import { Router } from "express";
import {
  isWhatsAppConfigured,
  isWhatsAppSignatureConfigured,
  verifyWebhookChallenge,
  verifyWebhookSignature,
  sendWhatsAppMessage,
  extractIncomingMessages,
} from "../providers/whatsapp.js";
import { isWhatsAppNumberAllowed, getWhatsAppHistory, appendWhatsAppMessage } from "../db/store.js";
import { runAssistantChat } from "../ai/assistant.js";

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

async function handleIncoming(from: string, text: string): Promise<void> {
  if (!isWhatsAppNumberAllowed(from)) {
    console.warn(`whatsapp: ignoring message from non-allowed number ${from}`);
    return;
  }

  appendWhatsAppMessage(from, "user", text);
  const history = getWhatsAppHistory(from, 20).map((m) => ({
    role: m.role,
    content: m.content,
  }));

  try {
    const reply = await runAssistantChat(history);
    appendWhatsAppMessage(from, "assistant", reply);
    await sendWhatsAppMessage(from, reply);
  } catch (err) {
    console.error("whatsapp: failed to handle message", err);
    await sendWhatsAppMessage(
      from,
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
    handleIncoming(m.from, m.text).catch((err) =>
      console.error("whatsapp: unhandled error processing message", err)
    );
  }
});
