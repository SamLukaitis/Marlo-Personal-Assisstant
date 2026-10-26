// Sends a runAssistantChat result over WhatsApp — plain text normally, or a tappable choice
// message when the assistant called ask_user_choice. Shared by the three ordinary inbound-message
// handlers (whatsappRoutes.ts) and the pending-action resume path (actionHandlers.ts) — a resume
// reply that itself needs another ask_user_choice renders exactly the same way a first-turn one
// does. Lives in its own module rather than inside whatsappRoutes.ts because actionHandlers.ts
// needs it too, and whatsappRoutes.ts imports actionHandlers.ts — putting it in whatsappRoutes.ts
// would create a circular import.
import { appendWhatsAppMessage, resolveOwnerByPhone, type SentPart } from "../db/store.js";
import {
  sendWhatsAppMessage,
  sendChoiceMessage,
  sendWhatsAppReaction,
  sendWhatsAppLocationRequest,
  sendWhatsAppReplyButtons,
  sendWhatsAppCtaUrl,
} from "../providers/whatsapp.js";
import { splitIntoChunks, delayForChunk } from "./messageSplitting.js";
import { sleep } from "./sleep.js";
import { actionButtonFor, RUN_BUTTON_LABEL } from "./phoneActionButton.js";
import { planLinkButton } from "./linkButton.js";
import type { AssistantReply } from "../ai/assistant.js";

// earlierParts: messages already sent for this same turn that aren't in history on their own — the
// "one sec, working on it…" holding line (messageBatching.ts). They're recorded as parts of this
// reply, so a swipe on one resolves to the answer it was waiting on.
export async function sendAssistantReply(
  ownerId: number,
  phone: string,
  reply: AssistantReply,
  inboundMessageId: string,
  earlierParts: SentPart[] = []
): Promise<void> {
  // Synthetic turns (phone-action report-back) have no inbound wamid to react to — fall through to text.
  if (reply.reaction && inboundMessageId) {
    // A reaction replaces the text reply entirely (see assistant.ts's react_to_message) —
    // persist a readable history line rather than an empty row, and target the message that
    // triggered this turn (the wamid the caller passed in), not one of Marlo's own messages.
    recordAssistantMessage(ownerId, phone, `[reacted ${reply.reaction.emoji}]`, earlierParts);
    await sendWhatsAppReaction(phone, inboundMessageId, reply.reaction.emoji);
    return;
  }

  if (reply.locationRequest) {
    // Persisted like any reply so the next turn — triggered by the pin the user shares — can see
    // what was asked for (chatDispatch.handleLocation appends the pin right after this row).
    const wamid = await sendWhatsAppLocationRequest(phone, reply.text);
    recordAssistantMessage(ownerId, phone, reply.text, [...earlierParts, ...(wamid ? [{ wamid }] : [])]);
    return;
  }

  if (!reply.choice) {
    // One phone-action link: send it as a "Run on iPhone" button. History keeps the full text with
    // the link, so the model still sees what it offered; a failed button send falls back to text.
    const button = actionButtonFor(reply.text);
    if (button) {
      try {
        const wamid = await sendWhatsAppCtaUrl(phone, button.body, RUN_BUTTON_LABEL, button.url);
        recordAssistantMessage(ownerId, phone, reply.text, [...earlierParts, ...(wamid ? [{ wamid, text: button.body }] : [])]);
        return;
      } catch (err) {
        console.error("whatsappReply: Run button send failed; sending the link as text", err);
      }
    }
    // A flight/hotel search link: the reply with a "View Google Flights"/"View Google Hotels"
    // button under it instead of the link. Same history and fallback rules as the Run button.
    const plan = reply.linkButton ? planLinkButton(reply.text, reply.linkButton) : null;
    if (reply.linkButton && plan) {
      const parts: SentPart[] = [...earlierParts];
      try {
        if (plan.leadingText) {
          for (const [i, chunk] of splitIntoChunks(plan.leadingText).entries()) {
            if (i > 0) await sleep(delayForChunk(chunk));
            const wamid = await sendWhatsAppMessage(phone, chunk);
            if (wamid) parts.push({ wamid, text: chunk });
          }
        }
        const wamid = await sendWhatsAppCtaUrl(phone, plan.body, reply.linkButton.label, reply.linkButton.url);
        if (wamid) parts.push({ wamid, text: plan.body });
        recordAssistantMessage(ownerId, phone, reply.text, parts);
        return;
      } catch (err) {
        // Part of the reply already went out without the link: send just the link to finish it.
        if (parts.length > earlierParts.length) {
          console.error("whatsappReply: search button send failed; sending the link as text", err);
          const wamid = await sendWhatsAppMessage(phone, reply.linkButton.url);
          if (wamid) parts.push({ wamid, text: reply.linkButton.url });
          recordAssistantMessage(ownerId, phone, reply.text, parts);
          return;
        }
        console.error("whatsappReply: search button send failed; sending the reply as text", err);
      }
    }

    // Splitting/pausing is transport-only — the history row below always holds the one full
    // reply.text, not one row per chunk, so conversation-history/summary logic elsewhere is
    // unaffected. A single-paragraph reply (the common case) yields exactly one chunk and sends
    // exactly as it always did, with no pause. Sending happens before the append (rather than
    // before, as it used to) so the wamid(s) actually sent can be recorded against the history
    // row — see db/store.ts's whatsapp_message_wamids, which resolves a later swipe-to-reply to
    // this message no matter how long afterward.
    const chunks = splitIntoChunks(reply.text);
    const parts: SentPart[] = [...earlierParts];
    if (chunks.length === 0) {
      const wamid = await sendWhatsAppMessage(phone, reply.text);
      if (wamid) parts.push({ wamid, text: reply.text });
    } else {
      for (let i = 0; i < chunks.length; i++) {
        if (i > 0) await sleep(delayForChunk(chunks[i]));
        const wamid = await sendWhatsAppMessage(phone, chunks[i]);
        if (wamid) parts.push({ wamid, text: chunks[i] });
      }
    }
    recordAssistantMessage(ownerId, phone, reply.text, parts);
    return;
  }

  const choice = reply.choice;
  const choices = choice.buttons.map((b) => ({
    id: `pa:${choice.actionId}:${b.key}`,
    title: b.label,
  }));
  await sendChoiceAndRecord(ownerId, phone, reply.text, choice.question, choices, earlierParts);
}

// Every message Marlo sends should go through one of the three senders here (or outbound.ts for
// proactive pushes) so it's recorded with its wamid(s) and can be swipe-replied to — a message sent
// without them can't be resolved later, and the model is left guessing what the user meant.
//
// For the short replies sent outside the assistant (confirmations, "Cancelled.", help text).
// historyNote is stored with the message but never sent — e.g. what a "✓ Sent." actually sent, so a
// swipe on it can be answered. Still recorded if the send fails, as these always were; the error is
// rethrown for the caller to handle.
export async function sendTextAndRecord(
  ownerId: number,
  phone: string,
  text: string,
  historyNote?: string,
  earlierParts: SentPart[] = []
): Promise<void> {
  const historyText = historyNote ? `${text}\n\n${historyNote}` : text;
  let wamid: string | undefined;
  try {
    wamid = await sendWhatsAppMessage(phone, text);
  } finally {
    recordAssistantMessage(ownerId, phone, historyText, [...earlierParts, ...(wamid ? [{ wamid, text }] : [])]);
  }
}

// Sent before it's recorded, like a plain reply, so every part's wamid is kept — a long choice
// prompt goes out as several messages and any of them can be swiped. historyText is what goes in
// chat history, which can be fuller than the prompt shown above the buttons.
export async function sendChoiceAndRecord(
  ownerId: number,
  phone: string,
  historyText: string,
  prompt: string,
  choices: { id: string; title: string }[],
  earlierParts: SentPart[] = []
): Promise<void> {
  let parts: SentPart[] = [];
  try {
    parts = await sendChoiceMessage(phone, prompt, choices);
  } finally {
    recordAssistantMessage(ownerId, phone, historyText, [...earlierParts, ...parts]);
  }
}

// For scripted messages sent outside the assistant — onboarding questions, connect links, the
// "hang tight" line, error and expired-button replies. `send` does the actual send and returns its
// wamid; historyText is what goes in chat history (for a connect link, the body text — never the
// link, which carries a sign-in token). The owner is looked up from the phone when the caller
// doesn't have it; a number with no account yet has no chat history, so it's just sent. Recording
// never fails the send — the message has already gone out by then.
export async function sendAndRecord(
  phone: string,
  historyText: string,
  send: () => Promise<string | undefined>,
  ownerId?: number
): Promise<void> {
  let wamid: string | undefined;
  try {
    wamid = await send();
  } finally {
    try {
      const owner = ownerId ?? resolveOwnerByPhone(phone);
      if (owner !== null) recordAssistantMessage(owner, phone, historyText, wamid ? [{ wamid, text: historyText }] : []);
    } catch (err) {
      console.error("whatsappReply: couldn't record a sent message in history", err);
    }
  }
}

export function sendScriptedText(phone: string, text: string, ownerId?: number): Promise<void> {
  return sendAndRecord(phone, text, () => sendWhatsAppMessage(phone, text), ownerId);
}

export function sendScriptedButtons(
  phone: string,
  text: string,
  buttons: { id: string; title: string }[],
  ownerId?: number
): Promise<void> {
  return sendAndRecord(phone, text, () => sendWhatsAppReplyButtons(phone, text, buttons), ownerId);
}

// History gets the body text only — the url carries a sign-in token.
export function sendScriptedLink(phone: string, bodyText: string, buttonText: string, url: string): Promise<void> {
  return sendAndRecord(phone, bodyText, () => sendWhatsAppCtaUrl(phone, bodyText, buttonText, url));
}

// A part whose text is the whole message needs no part text — only a part of a longer message does.
function recordAssistantMessage(ownerId: number, phone: string, text: string, parts: SentPart[]): void {
  if (!parts.length) {
    appendWhatsAppMessage(ownerId, phone, "assistant", text);
    return;
  }
  appendWhatsAppMessage(
    ownerId,
    phone,
    "assistant",
    text,
    parts.map((p) => (p.text === undefined || p.text === text ? p.wamid : p))
  );
}
