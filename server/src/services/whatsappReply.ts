// Sends a runAssistantChat result over WhatsApp — plain text normally, or a tappable choice
// message when the assistant called ask_user_choice. Shared by the three ordinary inbound-message
// handlers (whatsappRoutes.ts) and the pending-action resume path (actionHandlers.ts) — a resume
// reply that itself needs another ask_user_choice renders exactly the same way a first-turn one
// does. Lives in its own module rather than inside whatsappRoutes.ts because actionHandlers.ts
// needs it too, and whatsappRoutes.ts imports actionHandlers.ts — putting it in whatsappRoutes.ts
// would create a circular import.
import { appendWhatsAppMessage, type SentPart } from "../db/store.js";
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
  if (reply.reaction) {
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
    const parts: SentPart[] = [];
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
  await sendChoiceAndRecord(ownerId, phone, reply.text, choice.question, choices);
}

// Every message Marlowe sends should go through one of the three senders here (or outbound.ts for
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
  historyNote?: string
): Promise<void> {
  const historyText = historyNote ? `${text}\n\n${historyNote}` : text;
  let wamid: string | undefined;
  try {
    wamid = await sendWhatsAppMessage(phone, text);
  } finally {
    recordAssistantMessage(ownerId, phone, historyText, wamid ? [{ wamid, text }] : []);
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
  choices: { id: string; title: string }[]
): Promise<void> {
  let parts: SentPart[] = [];
  try {
    parts = await sendChoiceMessage(phone, prompt, choices);
  } finally {
    recordAssistantMessage(ownerId, phone, historyText, parts);
  }
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
