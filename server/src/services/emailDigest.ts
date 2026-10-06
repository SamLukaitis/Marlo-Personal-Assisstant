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
import { personLine } from "./personLine.js";
import { getBriefingSettings } from "./briefing.js";
import {
  collectAttentionForDigest,
  commitAttentionBundle,
  isEmptyBundle,
  type AttentionBundle,
} from "./attention.js";

// Real-person emails held back for the user's once-a-day summary (emailAlertSettings.ts's "digest"
// mode). Stored as JSON in the settings table — a short-lived list that is emptied every day.
export interface DigestEmail {
  id: string;
  accountId: number;
  from: string;
  subject: string;
  // From realPersonTriage.ts: what the sender wants, and whether they are waiting on a reply.
  gist?: string;
  needsReply?: boolean;
}

const QUEUE_KEY = "email_digest_queue";
const LAST_SENT_KEY = "last_email_digest_date";
const INTRO_SENT_KEY = "email_digest_intro_sent";
// Bounds the queue for a user whose digest can't be delivered (no number, WhatsApp off).
const MAX_QUEUED = 200;
const MAX_LINES = 5;
// A template body is capped at 1000 characters. The first digest also carries the ~420-character
// check-in question, so it gets a smaller budget (see flushEmailDigestIfDue).
const MAX_DIGEST_CHARS = 950;
const MAX_DIGEST_CHARS_WITH_INTRO = 550;

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
    ...emails.map(({ id, accountId, from, subject, gist, needsReply }) => ({ id, accountId, from, subject, gist, needsReply })),
  ]);
}

export function queuedEmailDigestCount(ownerId: number): number {
  return readQueue(ownerId).length;
}

// One line per person (what they want, if triage said) plus anything the attention gate held for
// this evening. Names the user's own digest time, so a one-line summary doesn't read like a ping.
export function digestMessage(
  userName: string | null,
  queue: DigestEmail[],
  attention: AttentionBundle,
  digestTime: string,
  maxChars = MAX_DIGEST_CHARS
): string {
  const lead = `📬 ${userName ? `${userName}, here's` : "Here's"} your ${formatDigestTime(digestTime)} summary:`;
  const sections: string[] = [];
  if (queue.length) {
    const lines = queue
      .slice(0, MAX_LINES)
      .map((m) => `• ${personLine(m.from, m.subject, m.gist ? { gist: m.gist, needsReply: !!m.needsReply } : undefined)}`);
    const others = queue.slice(MAX_LINES).map((m) => `*${senderDisplayName(m.from)}*`);
    if (others.length) lines.push(`Also from ${others.join(", ")}.`);
    sections.push(lines.join("\n"));
  }
  if (attention.needsAttention.length) sections.push(attention.needsAttention.map((l) => `• ${l}`).join("\n"));
  if (attention.noted.length) sections.push(attention.noted.map((l) => `• ${l}`).join("\n"));
  const text = `${lead}\n${sections.join("\n\n")}`;
  return text.length > maxChars ? `${text.slice(0, maxChars - 1).replace(/\s+\S*$/, "")}…` : text;
}

// Shown once, on a user's first digest, when they never picked this mode themselves — it became the
// default for everyone, so the first summary doubles as the "is this what you want?" question.
function introExplanation(digestTime: string): string {
  return (
    `\n\nWe're trying something new: instead of pinging you every time someone emails, I now send ` +
    `one summary of people's emails each day at ${formatDigestTime(digestTime)}. Urgent things like ` +
    `flight changes still come straight away, and bookings and bills become reminders when they ` +
    `matter. Want to keep the daily summary?`
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
  const now = Date.now();
  // Held (over-cap) attention items always ride along; acknowledgements and other non-urgent items
  // only when there's no morning briefing to carry them. Independent of the people's-email setting.
  const attention = collectAttentionForDigest(ownerId, now, !getBriefingSettings(ownerId).proactive);
  if (queue.length === 0 && isEmptyBundle(attention)) {
    setSetting(ownerId, LAST_SENT_KEY, dateKey);
    return;
  }

  if (!isWhatsAppConfigured()) return;
  const numbers = listPhoneNumbersForUser(ownerId).map((r) => r.phone);
  if (numbers.length === 0) return;

  // Ids go in chat history only (see emailReference.ts), so "reply to Sarah's" resolves to a message.
  const askToKeep =
    queue.length > 0 && getSetting(ownerId, INTRO_SENT_KEY) === null && !realPersonAlertModeChosen(ownerId);
  const historyNote = [
    ...queue.slice(0, MAX_LINES).map((m) => emailReferenceNote(m)),
    ...(askToKeep ? [INTRO_HISTORY_NOTE] : []),
  ].join("\n");
  const digestTime = emailDigestTime(ownerId);
  const digest = digestMessage(
    getSetting(ownerId, "user_name"),
    queue,
    attention,
    digestTime,
    askToKeep ? MAX_DIGEST_CHARS_WITH_INTRO : MAX_DIGEST_CHARS
  );
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
    historyNote || undefined,
    send
  );
  if (sent) {
    writeQueue(ownerId, []);
    commitAttentionBundle(ownerId, attention, now);
    setSetting(ownerId, LAST_SENT_KEY, dateKey);
    if (askToKeep) setSetting(ownerId, INTRO_SENT_KEY, "true");
  }
}
