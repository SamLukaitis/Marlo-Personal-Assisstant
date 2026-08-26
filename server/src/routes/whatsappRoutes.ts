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
import { resolveOwnerByPhone, recordInboundMessage, getWhatsAppHistory, appendWhatsAppMessage } from "../db/store.js";
import { runAssistantChat, MAX_HISTORY_MESSAGES } from "../ai/assistant.js";
import { ingestWhatsAppMedia, ingestWhatsAppLink } from "../services/documents.js";
import { findSaveableUrl, type FetchFailureReason } from "../services/safeLinkFetcher.js";
import { handlePendingRegistration, isHelpTrigger, MARLOWE_HELP_TEXT } from "../services/whatsappRegistration.js";
import { handlePostConnectSetupReply } from "../services/postConnectSetup.js";
import { isVersionTrigger, buildVersionText } from "../services/version.js";

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

// Friendly, non-leaky wording per failure reason — never expose the raw fetch/DNS error detail
// to the end user, just enough for them to know what to do next.
function linkFailureMessage(reason: FetchFailureReason): string {
  switch (reason) {
    case "invalid_url":
    case "unsupported_scheme":
      return "That doesn't look like a regular web link I can open — send me a normal http/https address.";
    case "blocked_host":
    case "dns_error":
      return "I couldn't reach that link — double check the address, or just tell me the details directly.";
    case "timeout":
      return "That page took too long to load, so I couldn't save it — you can try again or tell me the details directly.";
    case "too_many_redirects":
      return "That link redirected too many times for me to follow — try sending the direct page.";
    case "non_html_content":
      return "That link points to a file rather than a web page, so I can't read it directly — try sending the file itself.";
    case "response_too_large":
    case "network_error":
      return "I ran into a problem trying to open that link, so I couldn't save it.";
  }
}

async function handleLink(ownerId: number, from: string, url: string): Promise<void> {
  const result = await ingestWhatsAppLink({ ownerId, phone: from, url });

  if (!result.ok) {
    const reply = linkFailureMessage(result.reason);
    appendWhatsAppMessage(ownerId, from, "assistant", reply);
    await sendWhatsAppMessage(from, reply);
    return;
  }

  // Same pattern as handleMedia below: route through the normal assistant loop so the saved
  // page's content can actually be acted on/confirmed, not just echoed back.
  const history = getWhatsAppHistory(from, MAX_HISTORY_MESSAGES).map((m) => ({
    role: m.role,
    content: m.content,
  }));
  const docContext =
    `[A link was just sent via WhatsApp, fetched, and saved — no need to save it again, just ` +
    `confirm and/or act on it. Extracted content:\n${result.doc.extractedText}`;
  if (history.length > 0) {
    history[history.length - 1] = { role: "user", content: docContext };
  } else {
    history.push({ role: "user", content: docContext });
  }

  const reply = await runAssistantChat(ownerId, history);
  appendWhatsAppMessage(ownerId, from, "assistant", reply);
  await sendWhatsAppMessage(from, reply);
}

async function handleText(ownerId: number, from: string, text: string): Promise<void> {
  appendWhatsAppMessage(ownerId, from, "user", text);

  // "help"/"menu" short-circuits straight to the same canned overview used at first contact —
  // instant, free, and worded consistently regardless of how the model might otherwise phrase
  // "what can you do", instead of spending an assistant turn on it.
  if (isHelpTrigger(text)) {
    appendWhatsAppMessage(ownerId, from, "assistant", MARLOWE_HELP_TEXT);
    await sendWhatsAppMessage(from, MARLOWE_HELP_TEXT);
    return;
  }

  // Same short-circuit shape as help, above — bypasses the model entirely so it works (and
  // tells the truth) even if the assistant/tool layer itself is what's broken or stale.
  if (isVersionTrigger(text)) {
    const versionText = buildVersionText();
    appendWhatsAppMessage(ownerId, from, "assistant", versionText);
    await sendWhatsAppMessage(from, versionText);
    return;
  }

  // A message that's just a URL (with at most a short lead-in) is treated as "save this link"
  // the same way a photo/PDF attachment already gets saved — see
  // safeLinkFetcher.findSaveableUrl for the detection heuristic and why it's biased hard toward
  // precision over recall (a false positive costs a fetch + an LLM call and pollutes the
  // document store; a false negative just means the user re-sends the bare link).
  const url = findSaveableUrl(text);
  if (url) {
    await handleLink(ownerId, from, url);
    return;
  }

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

  // A tap answering one of postConnectSetup's yes/no button questions (daily briefing, Teams,
  // Schengen tracking) — handled entirely there and never reaches the assistant. Returns false for
  // everything else (nothing pending, a stray/late tap, or ordinary text/media), which falls
  // through to normal handling below exactly as before.
  if (await handlePostConnectSetupReply(ownerId, message)) return;

  try {
    if (message.kind === "text") {
      await handleText(ownerId, message.from, message.text);
    } else if (message.kind === "media") {
      await handleMedia(ownerId, message.from, message.mediaId, message.mimeType, message.filename, message.caption);
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
