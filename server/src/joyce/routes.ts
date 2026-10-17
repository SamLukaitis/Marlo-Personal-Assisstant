import { Router } from "express";
import { isJoyceConfigured, normalizeJoycePhone } from "./familyKey.js";
import { markJoyceWamidSeenIfNew } from "./registry.js";
import { openFamilyForCalendarToken, openFamilySessionForPhone } from "./familyDb.js";
import { buildCalendarFeed } from "./calendarFeed.js";
import { appendMessage } from "./store.js";
import { applyName, CHOICE_BUTTONS, handleOnboarding, needsName } from "./onboarding.js";
import { handlePendingLeave } from "./leaving.js";
import { runJoyceTurn } from "./assistant.js";
import { saveFamilyFile } from "./files.js";
import { asText, messages, type JoyceMessage } from "./messages.js";
import { handlePendingDelete } from "./deleting.js";
import { takePendingDelete } from "./store.js";
import { delayForChunk, splitIntoChunks } from "./messageSplitting.js";
import {
  downloadJoyceMedia,
  extractJoyceMessages,
  isJoyceWhatsAppConfigured,
  joycePhoneNumberId,
  sendJoyceButtons,
  sendJoyceMessage,
  sendJoyceTypingIndicator,
  verifyJoyceWebhookChallenge,
  verifyJoyceWebhookSignature,
  type JoyceInboundMessage,
} from "./whatsapp.js";

// Joyce's webhook, on its own path. Meta has one callback URL per app, so when Joyce shares
// Marlowe's app her number needs a phone-number-level webhook override pointing here (see
// "Going live" in feature-to-do/joyce-family-assistant.md); without it her messages only reach
// Marlowe's endpoint, which drops them. The phone_number_id guard below is a second line of
// defence in case Marlowe's traffic is ever delivered here too.

export const joyceRoutes = Router();

// The family calendar subscription feed — see calendarFeed.ts. The secret in the path is the only
// credential; an unknown or replaced link gets a plain 404 that says nothing about why.
joyceRoutes.get("/joyce/calendar/:file", (req, res) => {
  const match = /^([A-Za-z0-9_-]{20,64})\.ics$/.exec(req.params.file);
  const family = match && isJoyceConfigured() ? openFamilyForCalendarToken(match[1]) : null;
  if (!family) {
    res.sendStatus(404);
    return;
  }
  res.set("Content-Type", "text/calendar; charset=utf-8");
  res.set("Cache-Control", "no-store");
  res.send(buildCalendarFeed(family));
});

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
        wamid: message.messageId,
        quotedWamid: message.quotedMessageId,
      })
    : await composeReply(phone, message.text, {
        wamid: message.messageId,
        quotedWamid: message.quotedMessageId,
      });
  await sendJoyceReply(message.from, reply);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sends a reply's messages in order. A long one is split into several bubbles the same way
 * Marlowe's are (see messageSplitting.ts), and every message after the first waits a moment, so
 * it reads as someone typing rather than a burst. A message with buttons goes out whole.
 */
export async function sendJoyceReply(to: string, reply: JoyceMessage[]): Promise<void> {
  let first = true;
  for (const message of reply) {
    const parts = message.buttons ? [message.text] : splitIntoChunks(message.text);
    for (let i = 0; i < parts.length; i++) {
      if (!first) await sleep(delayForChunk(parts[i]));
      first = false;
      const isLast = i === parts.length - 1;
      if (message.buttons && isLast) await sendJoyceButtons(to, parts[i], message.buttons);
      else await sendJoyceMessage(to, parts[i]);
    }
  }
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
    wamid?: string;
    quotedWamid?: string;
  }
): Promise<JoyceMessage[]> {
  // A file is still "the next message", so it spends a pending leave request like anything
  // else would. The caption is what gets matched; a file with no caption never confirms. The
  // file isn't kept: they were mid-way through leaving, so where it belongs is unclear.
  const leaveOutcome = handlePendingLeave(normalizedPhone, media.caption);
  if (leaveOutcome) {
    return leaveOutcome.left
      ? leftReply(leaveOutcome.reply)
      : messages(`${leaveOutcome.reply} I haven't kept that file — send it again if you want it saved.`);
  }

  const session = openFamilySessionForPhone(normalizedPhone);
  if (!session) {
    // Nowhere to keep it. Onboarding is driven by what they type, so a file doesn't advance it —
    // it just gets them the current question again.
    const outcome = handleOnboarding(normalizedPhone, "");
    return [
      ...messages("I can only keep files once you're in a family group."),
      ...(outcome.done ? [] : outcome.reply),
    ];
  }

  // A file isn't an answer to "delete this?", so a pending delete is just dropped (kept).
  takePendingDelete(session);

  const saved = await saveFamilyFile(session, {
    buffer: await media.download(),
    mimeType: media.mimeType,
    filename: media.filename,
    caption: media.caption,
  });

  if (needsName(session)) {
    return messages("Got it, that's saved for the family. Before anything else, what should I call you?");
  }

  const kind = media.mimeType.startsWith("image/") ? "a photo" : "a file";
  const label = media.filename ? ` "${media.filename}"` : "";
  const userText = `[Sent ${kind}${label}]${media.caption ? ` ${media.caption}` : ""}`;
  return runJoyceTurn(
    { session, normalizedPhone, wamid: media.wamid, quotedWamid: media.quotedWamid },
    userText,
    saved
  );
}

// After leaving, their next message is read as the answer to "new or join?" (see leaving.ts), so
// the buttons go with it.
function leftReply(text: string): JoyceMessage[] {
  return [{ text, buttons: CHOICE_BUTTONS }];
}

/**
 * Split out from the send so tests can assert on what Joyce would say without stubbing the
 * Graph API. Returns the messages to send, in order; empty means "say nothing".
 */
export async function composeReply(
  normalizedPhone: string,
  text: string,
  meta: { wamid?: string; quotedWamid?: string } = {}
): Promise<JoyceMessage[]> {
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
    return leaveOutcome.left ? leftReply(leaveOutcome.reply) : messages(leaveOutcome.reply);
  }

  let session = openFamilySessionForPhone(normalizedPhone);

  // No family yet: introduce, then new-or-join. Onboarding may land them in a family mid-call,
  // in which case it hands back the open session along with what to say.
  if (!session) {
    const outcome = handleOnboarding(normalizedPhone, text);
    if (!outcome.done) return outcome.reply;
    session = outcome.session;
    if (outcome.reply) {
      // They're in a family from here on, so what they said and what Joyce sent back (the family
      // ID included) goes in its history like any other turn — otherwise she can't see later
      // what she told them. The messages before this point have no family to be kept in.
      appendMessage(session, "user", text);
      appendMessage(session, "assistant", asText(outcome.reply));
      return outcome.reply;
    }
  }

  // The one turn where the whole message is an answer rather than a request.
  if (needsName(session)) {
    const reply = applyName(session, text);
    appendMessage(session, "user", text);
    appendMessage(session, "assistant", reply);
    return messages(reply);
  }

  // The answer to "delete this?" — matched in code before the model runs, like leaving. Kept out of
  // the history beyond a plain record, since the request it answers wasn't stored either.
  const deleteOutcome = handlePendingDelete(session, text);
  if (deleteOutcome) {
    appendMessage(session, "user", text);
    appendMessage(session, "assistant", deleteOutcome);
    return messages(deleteOutcome);
  }

  return runJoyceTurn({ session, normalizedPhone, ...meta }, text);
}
