import { Router } from "express";
import {
  isWhatsAppConfigured,
  isWhatsAppSignatureConfigured,
  verifyWebhookChallenge,
  verifyWebhookSignature,
  sendWhatsAppMessage,
  sendWhatsAppTypingIndicator,
  extractIncomingMessages,
  type IncomingWhatsAppMessage,
} from "../providers/whatsapp.js";
import {
  resolveOwnerByPhone,
  recordInboundMessage,
  getWhatsAppHistory,
  appendWhatsAppMessage,
  markWamidSeenIfNew,
} from "../db/store.js";
import { runAssistantChat, MAX_HISTORY_MESSAGES } from "../ai/assistant.js";
import { ingestWhatsAppMedia } from "../services/documents.js";
import { handlePendingRegistration } from "../services/whatsappRegistration.js";
import {
  handlePostConnectSetupReply,
  handleFirstTaskReply,
  handleBriefingContentReply,
} from "../services/postConnectSetup.js";
import { sendAssistantReply } from "../services/whatsappReply.js";
import { handlePendingActionReply } from "../services/actionHandlers.js";
import { maybeUpdateConversationSummary } from "../services/conversationSummary.js";
import { handleText, handleLocation } from "../services/chatDispatch.js";

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

// Durable dedupe (db/store.ts's seen_wamids) to ignore Meta's webhook retries (it retries if
// we're slow to ACK, which we always will be relative to a full Claude tool-calling round trip,
// and keeps retrying for up to 7 days) — survives restarts, unlike the in-memory cache this used
// to be.
function alreadyProcessed(id: string): boolean {
  return !markWamidSeenIfNew(id);
}

async function handleMedia(
  ownerId: number,
  from: string,
  mediaId: string,
  mimeType: string,
  messageId: string,
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

  const reply = await runAssistantChat(ownerId, history, from);
  await sendAssistantReply(ownerId, from, reply, messageId);
}

export async function handleIncoming(message: IncomingWhatsAppMessage): Promise<void> {
  // Fire-and-forget — shows the native "..." typing indicator while the assistant/tool-call
  // round trip below runs, so the user knows a reply is coming rather than wondering if the
  // message went through. Never let this block or fail message handling itself.
  sendWhatsAppTypingIndicator(message.messageId).catch((err) =>
    console.error("whatsapp: typing indicator failed", err)
  );

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

  // Marks the customer-service window open again as of now — see outbound.ts, which reads this
  // to decide whether a later proactive push can go out as free-form text or needs a template.
  recordInboundMessage(message.from);

  // Fire-and-forget, same as the typing indicator above — folds any backlog that's fallen out of
  // the raw history window into the rolling summary (services/conversationSummary.ts). Cheap to
  // call every time (usually a no-op); never let it block or fail message handling.
  maybeUpdateConversationSummary(message.from).catch((err) =>
    console.error("whatsapp: conversation summary update failed", err)
  );

  // The two blocking free-text setup steps (ask_first_task, ask_briefing_content) — each either
  // consumes a "skip" and advances the chain, or forwards the message to ordinary chat handling
  // and advances right after. Checked first since they're the earliest steps in the chain.
  if (await handleFirstTaskReply(ownerId, message)) return;
  // A tap answering one of postConnectSetup's yes/no button questions (daily briefing, Teams) —
  // handled entirely there and never reaches the assistant. Returns false for everything else
  // (nothing pending, a stray/late tap, or ordinary text/media), which falls through to normal
  // handling below exactly as before.
  if (await handlePostConnectSetupReply(ownerId, message)) return;
  if (await handleBriefingContentReply(ownerId, message)) return;
  if (await handlePendingActionReply(ownerId, message)) return;

  try {
    if (message.kind === "text") {
      await handleText(ownerId, message.from, message.text, message.messageId);
    } else if (message.kind === "media") {
      await handleMedia(
        ownerId,
        message.from,
        message.mediaId,
        message.mimeType,
        message.messageId,
        message.filename,
        message.caption
      );
    } else if (message.kind === "location") {
      await handleLocation(
        ownerId,
        message.from,
        message.latitude,
        message.longitude,
        message.messageId,
        message.name,
        message.address
      );
    } else if (message.kind === "reaction") {
      // A reaction to something Marlowe sent (or its removal) — recorded to history so it's not
      // silently dropped, but deliberately does NOT trigger a full assistant turn/reply: a
      // reaction on its own essentially never needs a response, and every one skipped here is a
      // full API call not spent.
      const label = message.emoji ? message.emoji : "(removed)";
      appendWhatsAppMessage(ownerId, message.from, "user", `[reacted ${label} to a message]`);
    } else if (message.kind === "unsupported") {
      // Location, voice/audio, sticker, contacts, video, etc. — nothing reads these yet. Tell the
      // user plainly rather than staying silent, and log the raw type so it's visible which ones
      // are actually showing up in practice.
      console.log("whatsapp: unsupported message type", { ownerId, type: message.type });
      const reply = "I can't read that message type yet — text me instead.";
      appendWhatsAppMessage(ownerId, message.from, "assistant", reply);
      await sendWhatsAppMessage(message.from, reply);
    } else {
      // A button tap with nothing pending for this owner — nothing sends buttons outside
      // registration/post-connect setup today, so this is always a stray/late tap. Log and ignore
      // rather than routing it into handleText/handleMedia, which don't expect this shape.
      console.error("whatsapp: unexpected interactive message with no pending setup step", {
        ownerId,
        buttonId: message.buttonId,
      });
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
