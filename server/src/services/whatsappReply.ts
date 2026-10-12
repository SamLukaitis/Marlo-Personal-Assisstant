// Sends a runAssistantChat result over WhatsApp — plain text normally, or a tappable choice
// message when the assistant called ask_user_choice. Shared by the three ordinary inbound-message
// handlers (whatsappRoutes.ts) and the pending-action resume path (actionHandlers.ts) — a resume
// reply that itself needs another ask_user_choice renders exactly the same way a first-turn one
// does. Lives in its own module rather than inside whatsappRoutes.ts because actionHandlers.ts
// needs it too, and whatsappRoutes.ts imports actionHandlers.ts — putting it in whatsappRoutes.ts
// would create a circular import.
import { appendWhatsAppMessage } from "../db/store.js";
import { sendWhatsAppMessage, sendChoiceMessage, sendWhatsAppReaction, sendWhatsAppLocationRequest } from "../providers/whatsapp.js";
import { splitIntoChunks, delayForChunk } from "./messageSplitting.js";
import { sleep } from "./sleep.js";
import type { AssistantReply } from "../ai/assistant.js";

export async function sendAssistantReply(
  ownerId: number,
  phone: string,
  reply: AssistantReply,
  inboundMessageId: string
): Promise<void> {
  // Synthetic turns (phone-action report-back) have no inbound wamid to react to — fall through to text.
  if (reply.reaction && inboundMessageId) {
    // A reaction replaces the text reply entirely (see assistant.ts's react_to_message) —
    // persist a readable history line rather than an empty row, and target the message that
    // triggered this turn (the wamid the caller passed in), not one of Marlowe's own messages.
    appendWhatsAppMessage(ownerId, phone, "assistant", `[reacted ${reply.reaction.emoji}]`);
    await sendWhatsAppReaction(phone, inboundMessageId, reply.reaction.emoji);
    return;
  }

  if (reply.locationRequest) {
    // Persisted like any reply so the next turn — triggered by the pin the user shares — can see
    // what was asked for (chatDispatch.handleLocation appends the pin right after this row).
    const wamid = await sendWhatsAppLocationRequest(phone, reply.text);
    if (wamid) {
      appendWhatsAppMessage(ownerId, phone, "assistant", reply.text, [wamid]);
    } else {
      appendWhatsAppMessage(ownerId, phone, "assistant", reply.text);
    }
    return;
  }

  if (!reply.choice) {
    // Splitting/pausing is transport-only — the history row below always holds the one full
    // reply.text, not one row per chunk, so conversation-history/summary logic elsewhere is
    // unaffected. A single-paragraph reply (the common case) yields exactly one chunk and sends
    // exactly as it always did, with no pause. Sending happens before the append (rather than
    // before, as it used to) so the wamid(s) actually sent can be recorded against the history
    // row — see db/store.ts's whatsapp_message_wamids, which resolves a later swipe-to-reply to
    // this message no matter how long afterward.
    const chunks = splitIntoChunks(reply.text);
    const wamids: string[] = [];
    if (chunks.length === 0) {
      const wamid = await sendWhatsAppMessage(phone, reply.text);
      if (wamid) wamids.push(wamid);
    } else {
      for (let i = 0; i < chunks.length; i++) {
        if (i > 0) await sleep(delayForChunk(chunks[i]));
        const wamid = await sendWhatsAppMessage(phone, chunks[i]);
        if (wamid) wamids.push(wamid);
      }
    }
    // Only pass the wamids array when it actually has something — an explicit empty/undefined
    // 5th argument is a different call shape than omitting it, and appendWhatsAppMessage already
    // treats "no wamids" as a no-op for the join table either way.
    if (wamids.length) {
      appendWhatsAppMessage(ownerId, phone, "assistant", reply.text, wamids);
    } else {
      appendWhatsAppMessage(ownerId, phone, "assistant", reply.text);
    }
    return;
  }

  appendWhatsAppMessage(ownerId, phone, "assistant", reply.text);
  const choice = reply.choice;
  const choices = choice.buttons.map((b) => ({
    id: `pa:${choice.actionId}:${b.key}`,
    title: b.label,
  }));
  await sendChoiceMessage(phone, choice.question, choices);
}
