// Sends a runAssistantChat result over WhatsApp — plain text normally, or a tappable choice
// message when the assistant called ask_user_choice. Shared by the three ordinary inbound-message
// handlers (whatsappRoutes.ts) and the pending-action resume path (actionHandlers.ts) — a resume
// reply that itself needs another ask_user_choice renders exactly the same way a first-turn one
// does. Lives in its own module rather than inside whatsappRoutes.ts because actionHandlers.ts
// needs it too, and whatsappRoutes.ts imports actionHandlers.ts — putting it in whatsappRoutes.ts
// would create a circular import.
import { appendWhatsAppMessage } from "../db/store.js";
import { sendWhatsAppMessage, sendChoiceMessage } from "../providers/whatsapp.js";
import type { AssistantReply } from "../ai/assistant.js";

export async function sendAssistantReply(
  ownerId: number,
  phone: string,
  reply: AssistantReply
): Promise<void> {
  appendWhatsAppMessage(ownerId, phone, "assistant", reply.text);

  if (!reply.choice) {
    await sendWhatsAppMessage(phone, reply.text);
    return;
  }

  const choice = reply.choice;
  const choices = choice.buttons.map((b) => ({
    id: `pa:${choice.actionId}:${b.key}`,
    title: b.label,
  }));
  await sendChoiceMessage(phone, choice.question, choices);
}
