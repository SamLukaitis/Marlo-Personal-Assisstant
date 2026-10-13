import { Router } from "express";
import {
  isWhatsAppConfigured,
  isWhatsAppSignatureConfigured,
  verifyWebhookChallenge,
  verifyWebhookSignature,
  sendWhatsAppTypingIndicator,
  extractIncomingMessages,
  type IncomingWhatsAppMessage,
} from "../providers/whatsapp.js";
import {
  resolveOwnerByPhone,
  recordInboundMessage,
  appendWhatsAppMessage,
  markWamidSeenIfNew,
  cancelUntilReplyRemindersForOwner,
} from "../db/store.js";
import { ingestWhatsAppMedia } from "../services/documents.js";
import { handlePendingRegistration } from "../services/whatsappRegistration.js";
import {
  handlePostConnectSetupReply,
  handleNameReply,
  handleFirstTaskReply,
} from "../services/postConnectSetup.js";
import { handlePendingActionReply } from "../services/actionHandlers.js";
import { maybeUpdateConversationSummary } from "../services/conversationSummary.js";
import { maybeExtractMemory } from "../services/memoryExtraction.js";
import { handleText, handleLocation } from "../services/chatDispatch.js";
import { resolveQuotedMessageContext } from "../services/quotedMessage.js";
import { queueForAssistant, looksComplete } from "../services/messageBatching.js";
import { sendTextAndRecord, sendScriptedText } from "../services/whatsappReply.js";

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
  caption?: string,
  quotedMessageId?: string,
  forwarded?: boolean
): Promise<void> {
  const label = filename ?? caption ?? "a file";
  const rowId = appendWhatsAppMessage(ownerId, from, "user", `[Sent ${label}]`, [messageId]);

  const doc = await ingestWhatsAppMedia({
    ownerId,
    phone: from,
    mediaId,
    mimeType,
    filename,
    caption,
    wamid: messageId,
  });

  // Route this through the normal assistant/tool loop (via the batching queue, so a follow-up
  // text sent right after gets folded into the same reply) instead of just echoing the raw
  // extraction back. This is what makes a caption like "add this to calendar" actually get
  // acted on in the same turn — previously handleMedia never called the assistant at all, so
  // any request sent alongside the file was silently ignored until the user asked again.
  //
  // The persisted history line is just "[Sent <caption>]" (kept short so it doesn't bloat every
  // future call's history) — this override swaps in the full extracted text plus the caption so
  // the model has the actual document content to act on and confirm. A rare case where this media
  // message was itself a swipe-reply to something else gets that resolved context prepended —
  // see quotedMessage.ts.
  const quotedContext = resolveQuotedMessageContext(ownerId, quotedMessageId, forwarded, from);
  const docContext =
    (quotedContext ? `${quotedContext}\n\n` : "") +
    `[A document was just sent via WhatsApp and has already been downloaded and saved — no ` +
    `need to save it again, just confirm and/or act on it. Extracted content:\n${doc.extractedText}` +
    (caption
      ? `\n\nThe user's message alongside it was: "${caption}"`
      : "\n\nThe user didn't add any message alongside it — just give a short confirmation of what was saved.");
  // A caption that reads as a complete thought ("what does this say?") takes the short debounce
  // path; no caption (or one that trails off) defaults to waiting longer, since a document often
  // arrives with the explanatory text as its own separate follow-up message.
  queueForAssistant(ownerId, from, messageId, rowId, docContext, !!caption && looksComplete(caption));
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

  // Any inbound message counts as "the user replied" — stops every currently-active
  // until_reply reminder (set_reminder's mode: 'until_reply') for this owner. Deliberately not
  // scoped to a specific reminder or keyword: simple and fully hardcoded, no AI judgment about
  // whether a given message "counts" as acknowledging the reminder.
  cancelUntilReplyRemindersForOwner(ownerId);

  // Fire-and-forget, same as the typing indicator above — folds any backlog that's fallen out of
  // the raw history window into the rolling summary (services/conversationSummary.ts). Cheap to
  // call every time (usually a no-op); never let it block or fail message handling.
  maybeUpdateConversationSummary(message.from).catch((err) =>
    console.error("whatsapp: conversation summary update failed", err)
  );

  // Fire-and-forget, same as the summary above — turns each batch of fresh messages into
  // structured memories (services/memoryExtraction.ts). Usually a no-op; never blocks a reply.
  maybeExtractMemory(message.from).catch((err) =>
    console.error("whatsapp: memory extraction failed", err)
  );

  // The blocking free-text setup steps (ask_name, ask_first_task) — each either consumes a "skip"
  // (or, for ask_name, saves the name) and advances the chain, or forwards the message to
  // ordinary chat handling and advances right after. Checked first since they're the earliest
  // steps in the chain — ask_name is the very first question asked.
  if (await handleNameReply(ownerId, message)) return;
  if (await handleFirstTaskReply(ownerId, message)) return;
  // A tap answering one of postConnectSetup's yes/no button questions (daily briefing, Teams) —
  // handled entirely there and never reaches the assistant. Returns false for everything else
  // (nothing pending, a stray/late tap, or ordinary text/media), which falls through to normal
  // handling below exactly as before.
  if (await handlePostConnectSetupReply(ownerId, message)) return;
  if (await handlePendingActionReply(ownerId, message)) return;

  try {
    if (message.kind === "text") {
      await handleText(
        ownerId,
        message.from,
        message.text,
        message.messageId,
        message.quotedMessageId,
        message.forwarded
      );
    } else if (message.kind === "media") {
      await handleMedia(
        ownerId,
        message.from,
        message.mediaId,
        message.mimeType,
        message.messageId,
        message.filename,
        message.caption,
        message.quotedMessageId,
        message.forwarded
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
      // Voice/audio, sticker, contacts, video, etc. — nothing reads these yet. Tell the user
      // plainly rather than staying silent, and log the raw type so it's visible which ones are
      // actually showing up in practice.
      console.log("whatsapp: unsupported message type", { ownerId, type: message.type });
      await sendTextAndRecord(ownerId, message.from, "I can't read that message type yet — text me instead.");
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
    await sendScriptedText(message.from, "Sorry, I hit an error handling that — check the server logs.").catch(() => {});
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

  // Scoped to Marlowe's own number so a second number on the same Meta app (Joyce — see
  // src/joyce/) can't be answered by Marlowe, which would otherwise treat every family member
  // as an unrecognised number and start its own signup flow at them.
  const messages = extractIncomingMessages(req.body, process.env.WHATSAPP_PHONE_NUMBER_ID);
  for (const m of messages) {
    if (alreadyProcessed(m.messageId)) continue;
    handleIncoming(m).catch((err) =>
      console.error("whatsapp: unhandled error processing message", err)
    );
  }
});
