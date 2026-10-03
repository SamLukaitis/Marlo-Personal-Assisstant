import { Router } from "express";
import { isJoyceConfigured, normalizeJoycePhone } from "./familyKey.js";
import { markJoyceWamidSeenIfNew } from "./registry.js";
import { openFamilySessionForPhone } from "./familyDb.js";
import { appendMessage } from "./store.js";
import { applyName, handleOnboarding, needsName } from "./onboarding.js";
import { handlePendingLeave } from "./leaving.js";
import { runJoyceTurn } from "./assistant.js";
import { saveFamilyFile } from "./files.js";
import {
  downloadJoyceMedia,
  extractJoyceMessages,
  isJoyceWhatsAppConfigured,
  joycePhoneNumberId,
  sendJoyceMessage,
  sendJoyceTypingIndicator,
  verifyJoyceWebhookChallenge,
  verifyJoyceWebhookSignature,
  type JoyceInboundMessage,
} from "./whatsapp.js";

// Joyce's webhook. Mounted on its own path so that, if her number is put on a separate Meta app,
// the two products never share an endpoint at all. When she shares Marlowe's app (the likely
// starting point, since it's one WhatsApp Business Account), both numbers' messages arrive at
// both endpoints and the phone_number_id guard below is what keeps them apart.

export const joyceRoutes = Router();

joyceRoutes.get("/webhooks/joyce", (req, res) => {
  const mode = req.query["hub.mode"] as string;
  const token = req.query["hub.verify_token"] as string;
  const challenge = req.query["hub.challenge"] as string;
  if (verifyJoyceWebhookChallenge(mode, token)) res.status(200).send(challenge);
  else res.sendStatus(403);
});

joyceRoutes.post("/webhooks/joyce", (req, res) => {
  // ACK first: Meta retries anything slow, and a full model round trip is always slow.
  res.sendStatus(200);

  if (!isJoyceWhatsAppConfigured() || !isJoyceConfigured()) return;

  const signature = req.get("X-Hub-Signature-256") ?? undefined;
  const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
  if (!rawBody || !verifyJoyceWebhookSignature(rawBody, signature)) {
    console.warn("joyce: webhook signature verification failed — dropping payload");
    return;
  }

  for (const message of extractJoyceMessages(req.body)) {
    // Not addressed to Joyce's number — it's Marlowe's, arriving here because both numbers sit
    // on one Meta app. Dropping it silently is correct: Marlowe's own endpoint has the same
    // payload and will handle it.
    if (message.toPhoneNumberId !== joycePhoneNumberId()) continue;
    if (!markJoyceWamidSeenIfNew(message.messageId)) continue;
    handleJoyceIncoming(message).catch((err) =>
      console.error("joyce: unhandled error processing message", err)
    );
  }
});

/**
 * One inbound message, start to finish. Exported for tests, which drive it directly rather than
 * through Express.
 *
 * The order here is the isolation boundary in practice: the phone number is resolved to a family
 * *before* anything reads or writes family content, and everything downstream is handed the
 * resulting session rather than the number. Nothing below this line can name a family.
 */
export async function handleJoyceIncoming(message: JoyceInboundMessage): Promise<void> {
  sendJoyceTypingIndicator(message.messageId).catch((err) =>
    console.error("joyce: typing indicator failed", err)
  );

  const phone = normalizeJoycePhone(message.from);
  const media = message.media;
  const reply = media
    ? await composeMediaReply(phone, {
        caption: message.text,
        mimeType: media.mimeType,
        filename: media.filename,
        download: () => downloadJoyceMedia(media.mediaId),
      })
    : await composeReply(phone, message.text);
  if (reply) await sendJoyceMessage(message.from, reply);
}

/**
 * A photo or file. Saved for the family, then handed to the model along with what was read out
 * of it, so a caption like "remind everyone about this on Friday" gets acted on in the same turn.
 * `download` is only called once we know there's a family to save it into.
 */
export async function composeMediaReply(
  normalizedPhone: string,
  media: {
    caption: string;
    mimeType: string;
    filename?: string;
    download: () => Promise<Buffer>;
  }
): Promise<string | null> {
  // A file is still "the next message", so it spends a pending leave request like anything
  // else would. The caption is what gets matched; a file with no caption never confirms. The
  // file isn't kept: they were mid-way through leaving, so where it belongs is unclear.
  const leaveOutcome = handlePendingLeave(normalizedPhone, media.caption);
  if (leaveOutcome) {
    return leaveOutcome.left
      ? leaveOutcome.reply
      : `${leaveOutcome.reply} I haven't kept that file — send it again if you want it saved.`;
  }

  const session = openFamilySessionForPhone(normalizedPhone);
  if (!session) {
    // Nowhere to keep it. Onboarding is driven by what they type, so a file doesn't advance it —
    // it just gets them the current question again.
    const outcome = handleOnboarding(normalizedPhone, "");
    const prompt = outcome.done ? "" : `\n\n${outcome.reply}`;
    return `I can only keep files once you're in a family group.${prompt}`;
  }

  const saved = await saveFamilyFile(session, {
    buffer: await media.download(),
    mimeType: media.mimeType,
    filename: media.filename,
    caption: media.caption,
  });

  if (needsName(session)) {
    return "Got it — that's saved for the family. Before anything else, what should I call you?";
  }

  const kind = media.mimeType.startsWith("image/") ? "a photo" : "a file";
  const label = media.filename ? ` "${media.filename}"` : "";
  const userText = `[Sent ${kind}${label}]${media.caption ? ` ${media.caption}` : ""}`;
  return runJoyceTurn({ session, normalizedPhone }, userText, saved);
}

/**
 * Split out from the send so tests can assert on what Joyce would say without stubbing the
 * Graph API. Returns the text to send, or null for "say nothing".
 */
export async function composeReply(
  normalizedPhone: string,
  text: string
): Promise<string | null> {
  // First, before anything reads a family and before the model is involved at all: is this the
  // answer to a leave confirmation? Matching it here rather than in a tool is what makes leaving
  // impossible for the assistant to do on someone's behalf — see joyce/leaving.ts.
  const leaveOutcome = handlePendingLeave(normalizedPhone, text);
  if (leaveOutcome) {
    // Record the exchange in the family's history when they're still in it. Without this the
    // model sees the warning it sent, then the user's next message with no reply after it, and
    // reasonably concludes the request is still open — it then tells people to send "confirm
    // cancel" when doing so would no longer do anything. Skipped when they did leave: there is
    // no longer a family for this number to write to.
    if (!leaveOutcome.left) {
      const stillIn = openFamilySessionForPhone(normalizedPhone);
      if (stillIn) {
        appendMessage(stillIn, "user", text);
        appendMessage(stillIn, "assistant", leaveOutcome.reply);
      }
    }
    return leaveOutcome.reply;
  }

  let session = openFamilySessionForPhone(normalizedPhone);

  // No family yet: introduce, then new-or-join. Onboarding may land them in a family mid-call,
  // in which case it hands back the open session along with what to say.
  if (!session) {
    const outcome = handleOnboarding(normalizedPhone, text);
    if (!outcome.done) return outcome.reply;
    session = outcome.session;
    if (outcome.reply) return outcome.reply;
  }

  // The one turn where the whole message is an answer rather than a request.
  if (needsName(session)) return applyName(session, text);

  return runJoyceTurn({ session, normalizedPhone }, text);
}
