import type { FamilySession } from "./familyDb.js";
import { recordDerivation } from "./provenance.js";
import { appendSentMessage, getMemberContact, markRelayDelivered } from "./store.js";
import {
  CUSTOMER_SERVICE_WINDOW_MS,
  JOYCE_WINDOW_CLOSED_ERROR,
  JoyceSendError,
  sendJoyceMessage,
  sendJoyceRelayTemplate,
} from "./whatsapp.js";

// Sends a passed-on message ("tell Ella I'll be late") straight to the recipient:
//   - as an ordinary message if they've messaged Joyce in the last 24 hours;
//   - otherwise as the joyce_family_message template, the only thing WhatsApp lets through
//     outside that window. Until Meta approves it, those sends fail.
// If the send fails, the relay stays queued and claimRelaysFor (store.ts) hands it over the next
// time they message. Either way it's delivered exactly once: it's only marked delivered here
// after a send succeeds.

export function relayText(fromName: string | null, body: string): string {
  return `${fromName ?? "Someone in the family"} asked me to pass this on: ${body}`;
}

/** True if it was sent now; false if it's waiting for their next message. Never throws. */
export async function sendRelayNow(
  session: FamilySession,
  relayId: number,
  toMemberId: number,
  body: string,
  now = Date.now()
): Promise<boolean> {
  const contact = getMemberContact(session, toMemberId);
  if (!contact?.phone) return false;
  const from = session.actor.displayName;
  let sentText: string;
  try {
    sentText = await send(contact.phone, contact, from, body, now);
  } catch (err) {
    console.error("joyce: couldn't send a passed-on message now; they'll get it when they next message", err);
    return false;
  }
  markRelayDelivered(session, relayId);
  // In their own conversation, so Joyce knows what they mean if they reply to it, and removed
  // along with the relay if the sender deletes the message it came from.
  const sentId = appendSentMessage(session, toMemberId, sentText);
  recordDerivation(session, { type: "message", id: sentId }, [{ type: "relay", id: relayId }]);
  return true;
}

/** Sends it whichever way WhatsApp allows, and returns what was sent. */
async function send(
  phone: string,
  contact: { name: string | null; lastSeenAt: number },
  from: string | null,
  body: string,
  now: number
): Promise<string> {
  if (now - contact.lastSeenAt < CUSTOMER_SERVICE_WINDOW_MS) {
    try {
      const text = relayText(from, body);
      await sendJoyceMessage(phone, text);
      return text;
    } catch (err) {
      // Our clock said the window was open and Meta disagrees: fall through to the template.
      if (!(err instanceof JoyceSendError && err.code === JOYCE_WINDOW_CLOSED_ERROR)) throw err;
    }
  }
  await sendJoyceRelayTemplate(phone, { recipientName: contact.name, senderName: from, message: body });
  return (
    `Hi ${contact.name ?? "there"}, you have a new message from ${from ?? "someone in your family"} ` +
    `in your family group:\n\n"${body}"\n\nReply here if you'd like me to pass anything back.`
  );
}
