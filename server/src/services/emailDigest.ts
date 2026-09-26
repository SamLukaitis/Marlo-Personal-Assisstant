import { getSetting, setSetting, listPhoneNumbersForUser, createPendingAction } from "../db/store.js";
import { isWhatsAppConfigured } from "../providers/whatsapp.js";
import { senderDisplayName } from "./hub.js";
import { sendToAllNumbers } from "./proactiveDelivery.js";
import { sendProactiveMessageWithButtons } from "./outbound.js";
import { emailReferenceNote } from "./emailReference.js";
import {
  emailDigestTime,
  formatDigestTime,
  realPersonAlertModeChosen,
  realPersonAlertsEnabled,
} from "./emailAlertSettings.js";
import { userLocalClock } from "./userTimezone.js";

// Real-person emails held back for the user's once-a-day summary (emailAlertSettings.ts's "digest"
// mode). Stored as JSON in the settings table — a short-lived list that is emptied every day.
export interface DigestEmail {
  id: string;
  accountId: number;
  from: string;
  subject: string;
}

const QUEUE_KEY = "email_digest_queue";
const LAST_SENT_KEY = "last_email_digest_date";
const INTRO_SENT_KEY = "email_digest_intro_sent";
// Bounds the queue for a user whose digest can't be delivered (no number, WhatsApp off).
const MAX_QUEUED = 200;
const MAX_NAMED = 5;
const MAX_SUBJECT_LENGTH = 40;
// Keeps the first digest, check-in question included, inside a template's 1000-character limit.
const MAX_NAME_LENGTH = 30;

function readQueue(ownerId: number): DigestEmail[] {
  try {
    const parsed = JSON.parse(getSetting(ownerId, QUEUE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeQueue(ownerId: number, queue: DigestEmail[]): void {
  setSetting(ownerId, QUEUE_KEY, JSON.stringify(queue.slice(-MAX_QUEUED)));
}

export function queueForEmailDigest(ownerId: number, emails: DigestEmail[]): void {
  if (emails.length === 0) return;
  writeQueue(ownerId, [
    ...readQueue(ownerId),
    ...emails.map(({ id, accountId, from, subject }) => ({ id, accountId, from, subject })),
  ]);
}

export function queuedEmailDigestCount(ownerId: number): number {
  return readQueue(ownerId).length;
}

function shorten(subject: string, max = MAX_SUBJECT_LENGTH): string {
  const flat = subject.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function digestMessage(ownerId: number, queue: DigestEmail[]): string {
  const userName = getSetting(ownerId, "user_name");
  const greeting = userName ? `${userName}, ` : "";
  const named = queue.slice(0, MAX_NAMED).map((m) => `${shorten(senderDisplayName(m.from), MAX_NAME_LENGTH)} (${shorten(m.subject)})`);
  const rest = queue.length - named.length;
  return (
    `📬 ${greeting}${queue.length} new email${queue.length === 1 ? "" : "s"} from people: ` +
    `${named.join(", ")}${rest > 0 ? `, and ${rest} more` : ""}. Ask me about any of them.`
  );
}

// Shown once, on a user's first digest, when they never picked this mode themselves — it became the
// default for everyone, so the first summary doubles as the "is this what you want?" question.
function introExplanation(digestTime: string): string {
  return (
    `\n\nWe're trying something new: instead of pinging you every time someone emails, I now send ` +
    `one summary of people's emails each day at ${formatDigestTime(digestTime)}. Anything important, like ` +
    `flights, bookings and deliveries, still comes through straight away. Want to keep the daily ` +
    `summary?`
  );
}

// Without buttons (a template can't carry them) the person is told how to answer in words.
function introTyped(digestTime: string): string {
  return (
    introExplanation(digestTime) +
    ` Reply "keep it", give me a different time, or say "instant" and I'll ping you for every ` +
    `email as it arrives.`
  );
}

const INTRO_BUTTONS = [
  { key: "keep", title: "Keep daily summary" },
  { key: "instant", title: "Ping me instantly" },
  { key: "time", title: "Different time" },
];
// Long enough that answering the next day, or a few days later, still works.
const INTRO_ACTION_TTL_MS = 3 * 24 * 60 * 60 * 1000;

// Stored in chat history only (never sent), so the user's reply to introQuestion gets acted on.
const INTRO_HISTORY_NOTE =
  "[Digest check-in — Marlowe just asked whether to keep the daily email summary. If the user answers, " +
  'call set_email_alerts: keeping it -> people_mode "digest" (this records their choice); a different ' +
  'time -> digest_time "HH:MM" (and people_mode "digest"); every email as it arrives -> people_mode "instant".]';

// Runs every scheduler tick, sends once per calendar day after the user's digest time, and stays
// silent on a day with nothing queued. The day is stamped even when empty, so mail arriving later
// that evening goes into tomorrow's digest instead of firing a second message. A user who can't be
// reached (no number, WhatsApp off) keeps their queue and is retried on later ticks.
export async function flushEmailDigestIfDue(ownerId: number): Promise<void> {
  const { dateKey, hhmm } = userLocalClock(ownerId);
  // ">=": a date later than the user's own (their timezone just moved west) also counts as sent.
  if ((getSetting(ownerId, LAST_SENT_KEY) ?? "") >= dateKey) return;
  if (hhmm < emailDigestTime(ownerId)) return;

  // They turned people's emails off since these were queued, so they don't want them sent.
  if (!realPersonAlertsEnabled(ownerId)) writeQueue(ownerId, []);

  const queue = readQueue(ownerId);
  if (queue.length === 0) {
    setSetting(ownerId, LAST_SENT_KEY, dateKey);
    return;
  }

  if (!isWhatsAppConfigured()) return;
  const numbers = listPhoneNumbersForUser(ownerId).map((r) => r.phone);
  if (numbers.length === 0) return;

  // Ids go in chat history only (see emailReference.ts), so "reply to Sarah's" resolves to a message.
  const askToKeep = getSetting(ownerId, INTRO_SENT_KEY) === null && !realPersonAlertModeChosen(ownerId);
  const historyNote = [
    ...queue.slice(0, MAX_NAMED).map((m) => emailReferenceNote(m)),
    ...(askToKeep ? [INTRO_HISTORY_NOTE] : []),
  ].join("\n");
  const digest = digestMessage(ownerId, queue);
  const digestTime = emailDigestTime(ownerId);
  let send: ((phone: string) => Promise<void>) | undefined;
  if (askToKeep) {
    // One row shared by the three buttons, so the first tap answers it and a second tap (or a tap
    // from another of the user's numbers) finds it already used. See actionHandlers.ts.
    const actionId = createPendingAction(
      ownerId,
      "email_digest",
      "Keep the daily email summary?",
      "{}",
      INTRO_ACTION_TTL_MS
    );
    const buttons = INTRO_BUTTONS.map((b) => ({ id: `pa:${actionId}:${b.key}`, title: b.title }));
    send = (phone) =>
      sendProactiveMessageWithButtons(
        phone,
        digest + introExplanation(digestTime),
        buttons,
        "alert",
        historyNote,
        digest + introTyped(digestTime)
      );
  }
  const sent = await sendToAllNumbers(
    ownerId,
    `email-digest:${dateKey}`,
    numbers,
    askToKeep ? digest + introTyped(digestTime) : digest,
    "alert",
    "emailDigest",
    historyNote,
    send
  );
  if (sent) {
    writeQueue(ownerId, []);
    setSetting(ownerId, LAST_SENT_KEY, dateKey);
    if (askToKeep) setSetting(ownerId, INTRO_SENT_KEY, "true");
  }
}
