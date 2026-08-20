import { Router } from "express";
import {
  isWhatsAppConfigured,
  isWhatsAppSignatureConfigured,
  verifyWebhookChallenge,
  verifyWebhookSignature,
  sendWhatsAppMessage,
  extractIncomingMessages,
  type IncomingWhatsAppMessage,
} from "../providers/whatsapp.js";
import { resolveOwnerByPhone, getWhatsAppHistory, appendWhatsAppMessage } from "../db/store.js";
import { runAssistantChat, MAX_HISTORY_MESSAGES } from "../ai/assistant.js";
import { ingestWhatsAppMedia } from "../services/documents.js";
import { handlePendingRegistration } from "../services/whatsappRegistration.js";

export const whatsappRoutes = Router();

// Meta calls this once when you configure the webhook URL, to prove you control it.
whatsappRoutes.get("/webhooks/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"] as string;
  const token = req.query["hub.verify_token"] as string;
  const challenge = req.query["hub.challenge"] as string;

  if (verifyWebhookChallenge(mode, token)) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Bounded recent-message-ID cache to ignore Meta's webhook retries (it retries if we're slow
// to ACK, which we always will be relative to a full Claude tool-calling round trip).
const seenMessageIds = new Set<string>();
function alreadyProcessed(id: string): boolean {
  if (seenMessageIds.has(id)) return true;
  seenMessageIds.add(id);
  if (seenMessageIds.size > 500) {
    const first = seenMessageIds.values().next().value;
    if (first !== undefined) seenMessageIds.delete(first);
  }
  return false;
}

async function handleText(ownerId: number, from: string, text: string): Promise<void> {
  appendWhatsAppMessage(ownerId, from, "user", text);
  const history = getWhatsAppHistory(from, MAX_HISTORY_MESSAGES).map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const reply = await runAssistantChat(ownerId, history);
  appendWhatsAppMessage(ownerId, from, "assistant", reply);
  await sendWhatsAppMessage(from, reply);
}

async function handleMedia(
  ownerId: number,
  from: string,
  mediaId: string,
  mimeType: string,
  filename?: string,
  caption?: string
): Promise<void> {
  const label = filename ?? caption ?? "a file";
  appendWhatsAppMessage(ownerId, from, "user", `[Sent ${label}]`);

  const doc = await ingestWhatsAppMedia({ ownerId, phone: from, mediaId, mimeType, filename, caption });

  // Route this through the normal assistant/tool loop instead of just echoing the raw
  // extraction back. This is what makes a caption like "add this to calendar" actually get
  // acted on in the same turn — previously handleMedia never called the assistant at all, so
  // any request sent alongside the file was silently ignored until the user asked again.
  const history = getWhatsAppHistory(from, MAX_HISTORY_MESSAGES).map((m) => ({
    role: m.role,
    content: m.content,
  }));
  // The persisted history line is just "[Sent <caption>]" (kept short so it doesn't bloat every
  // future call's history) — for this one call, swap in the full extracted text plus the
  // caption so the model has the actual document content to act on and confirm.
  const docContext =
    `[A document was just sent via WhatsApp and has already been downloaded and saved — no ` +
    `need to save it again, just confirm and/or act on it. Extracted content:\n${doc.extractedText}` +
    (caption
      ? `\n\nThe user's message alongside it was: "${caption}"`
      : "\n\nThe user didn't add any message alongside it — just give a short confirmation of what was saved.");
  if (history.length > 0) {
    history[history.length - 1] = { role: "user", content: docContext };
  } else {
    history.push({ role: "user", content: docContext });
  }

  const reply = await runAssistantChat(ownerId, history);
  appendWhatsAppMessage(ownerId, from, "assistant", reply);
  await sendWhatsAppMessage(from, reply);
}

async function handleIncoming(message: IncomingWhatsAppMessage): Promise<void> {
  // The core of multi-tenant WhatsApp routing: which hub does this phone number belong to?
  // Replaces the old single global allow-list boolean — a number not registered to any user is
  // treated the same way an unlisted number was before (silently ignored), it's just resolved
  // per-tenant now instead of against one shared list.
  const ownerId = resolveOwnerByPhone(message.from);
  if (ownerId === null) {
    // No hub for this number yet — instead of silently dropping it, walk them through
    // registering: name, email (invite-checked), a one-time link to connect Gmail/Outlook. See
    // services/whatsappRegistration.ts for the conversation state machine.
    await handlePendingRegistration(message).catch((err) =>
      console.error("whatsapp: registration flow failed", err)
    );
    return;
  }

  try {
    if (message.kind === "text") {
      await handleText(ownerId, message.from, message.text);
    } else {
      await handleMedia(ownerId, message.from, message.mediaId, message.mimeType, message.filename, message.caption);
    }
  } catch (err) {
    console.error("whatsapp: failed to handle message", err);
    await sendWhatsAppMessage(
      message.from,
      "Sorry, I hit an error handling that — check the server logs."
    ).catch(() => {});
  }
}

whatsappRoutes.post("/webhooks/whatsapp", (req, res) => {
  // ACK immediately — Meta expects a fast response and retries otherwise, and a full
  // assistant round-trip (tool calls included) can easily take longer than that.
  res.sendStatus(200);

  if (!isWhatsAppConfigured()) return;

  if (!isWhatsAppSignatureConfigured()) {
    console.error(
      "whatsapp: WHATSAPP_APP_SECRET is not set — refusing to process an unverifiable webhook"
    );
    return;
  }

  const signature = req.get("X-Hub-Signature-256") ?? undefined;
  const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
  if (!rawBody || !verifyWebhookSignature(rawBody, signature)) {
    console.warn("whatsapp: webhook signature verification failed — dropping payload");
    return;
  }

  const messages = extractIncomingMessages(req.body);
  for (const m of messages) {
    if (alreadyProcessed(m.messageId)) continue;
    handleIncoming(m).catch((err) =>
      console.error("whatsapp: unhandled error processing message", err)
    );
  }
});
