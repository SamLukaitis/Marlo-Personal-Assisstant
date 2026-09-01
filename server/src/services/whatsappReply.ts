// Sends a runAssistantChat result over WhatsApp — plain text normally, or a tappable choice
// message when the assistant called ask_user_choice. Shared by the three ordinary inbound-message
// handlers (whatsappRoutes.ts) and the pending-action resume path (actionHandlers.ts) — a resume
// reply that itself needs another ask_user_choice renders exactly the same way a first-turn one
// does. Lives in its own module rather than inside whatsappRoutes.ts because actionHandlers.ts
// needs it too, and whatsappRoutes.ts imports actionHandlers.ts — putting it in whatsappRoutes.ts
// would create a circular import.
import { appendWhatsAppMessage } from "../db/store.js";
import { sendWhatsAppMessage, sendChoiceMessage, sendWhatsAppReaction } from "../providers/whatsapp.js";
import { splitIntoChunks, delayForChunk } from "./messageSplitting.js";
import { sleep } from "./sleep.js";
import type { AssistantReply } from "../ai/assistant.js";

export async function sendAssistantReply(
  ownerId: number,
  phone: string,
  reply: AssistantReply,
  inboundMessageId: string
): Promise<void> {
  if (reply.reaction) {
    // A reaction replaces the text reply entirely (see assistant.ts's react_to_message) —
    // persist a readable history line rather than an empty row, and target the message that
    // triggered this turn (the wamid the caller passed in), not one of Marlowe's own messages.
    appendWhatsAppMessage(ownerId, phone, "assistant", `[reacted ${reply.reaction.emoji}]`);
    await sendWhatsAppReaction(phone, inboundMessageId, reply.reaction.emoji);
    return;
  }

  appendWhatsAppMessage(ownerId, phone, "assistant", reply.text);

  if (!reply.choice) {
    // Splitting/pausing is transport-only — the history row above always holds the one full
    // reply.text, not one row per chunk, so conversation-history/summary logic elsewhere is
    // unaffected. A single-paragraph reply (the common case) yields exactly one chunk and sends
    // exactly as it always did, with no pause.
    const chunks = splitIntoChunks(reply.text);
    if (chunks.length === 0) {
      await sendWhatsAppMessage(phone, reply.text);
      return;
    }
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) await sleep(delayForChunk(chunks[i]));
      await sendWhatsAppMessage(phone, chunks[i]);
    }
    return;
  }

  const choice = reply.choice;
  const choices = choice.buttons.map((b) => ({
    id: `pa:${choice.actionId}:${b.key}`,
    title: b.label,
  }));
  await sendChoiceMessage(phone, choice.question, choices);
}
