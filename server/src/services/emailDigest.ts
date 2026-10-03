import type Anthropic from "@anthropic-ai/sdk";
import {
  getSetting,
  setSetting,
  listPhoneNumbersForUser,
  createPendingAction,
  recordApiUsage,
} from "../db/store.js";
import { getClient } from "../ai/assistant.js";
import {
  timeOfDayBand,
  voiceOpening,
  voiceTimeOfDay,
  VOICE_FACTS_ONLY,
  VOICE_FORM,
  VOICE_PEOPLE_NOT_SUBJECTS,
  VOICE_SINGLE_LINE,
  type ProactiveVoice,
} from "./proactiveVoice.js";
import { DateTime } from "luxon";
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

// Same sender replying on the same thread (a chain of "Re:"s) collapses into one line with a
// count, instead of repeating an identical name/subject pair for every reply in the queue.
function groupBySenderAndSubject(queue: DigestEmail[]): { name: string; subject: string; count: number }[] {
  const groups: { name: string; subject: string; count: number }[] = [];
  const indexByKey = new Map<string, number>();
  for (const m of queue) {
    const name = senderDisplayName(m.from);
    const subject = m.subject.replace(/\s+/g, " ").trim();
    const key = `${name}\u0000${subject}`;
    const existing = indexByKey.get(key);
    if (existing !== undefined) groups[existing].count += 1;
    else {
      indexByKey.set(key, groups.length);
      groups.push({ name, subject, count: 1 });
    }
  }
  return groups;
}

// The old hardcoded digest, kept as the fallback for when the model call fails. A recap that
// reads like a machine still beats no recap at all — the queue has already been held all day and
// is cleared on a successful send, so silently skipping would lose it.
export function staticDigestMessage(ownerId: number, queue: DigestEmail[]): string {
  const userName = getSetting(ownerId, "user_name");
  const greeting = userName ? `${userName}, ` : "";
  const shown = groupBySenderAndSubject(queue).slice(0, MAX_NAMED);
  const bullets = shown.map((g) => {
    const label = `${shorten(g.name, MAX_NAME_LENGTH)} (${shorten(g.subject)})`;
    return `• ${g.count > 1 ? `${label} x${g.count}` : label}`;
  });
  const rest = queue.length - shown.reduce((sum, g) => sum + g.count, 0);
  if (rest > 0) bullets.push(`• ${rest} more`);
  return (
    `📬 ${greeting}${queue.length} new email${queue.length === 1 ? "" : "s"} from people:\n` +
    `${bullets.join("\n")}\n` +
    `Ask me about any of them.`
  );
}

// The model that writes the recap — same tier as the briefing, since this is the same job (turn a
// day's facts into one human paragraph) and the voice has to match.
const MODEL = process.env.ASSISTANT_MODEL_COMPLEX ?? "claude-sonnet-5";

// One sender's mail for the day, already grouped: a chain of replies on one thread is one entry
// with a count, not five. Subjects are given to the model so it can tell what someone wants — it is
// told never to quote them back (see VOICE_PEOPLE_NOT_SUBJECTS).
export interface DigestSender {
  name: string;
  subject: string;
  count: number;
}

export interface DigestDay {
  /** "21:00" in the user's own zone — what the greeting and sign-off are pitched to. */
  localTime: string;
  /** "Friday" in the user's own zone. */
  localWeekday: string;
  /** Total emails held for today, which can exceed `senders` once threads are grouped. */
  total: number;
  senders: DigestSender[];
}

export function digestSystemPrompt(voice: ProactiveVoice): string {
  // Composed from proactiveVoice.ts, same as briefing.ts, so the morning and evening messages read
  // as the same assistant. Only what's specific to an end-of-day note about mail lives here.
  return [
    // Deliberately not "end-of-day": the recap goes out whenever the user set it, and framing it as
    // an evening note made the model write "Evening —" and "sleep well" to a night-shift worker
    // whose recap lands at 06:30.
    voiceOpening(voice, "sending them a short note about who got in touch today"),

    `Write one short paragraph, the way you'd text someone you work for. Aim for about 30 words and never go past 50. ${VOICE_FORM}`,

    VOICE_PEOPLE_NOT_SUBJECTS,

    // Three rather than the briefing's two: this message is only about mail, so naming two of six
    // people loses more than it saves. Still a cap, because listing everyone is the old behaviour.
    `Name at most three people. If more got in touch, say so in a few words and stop — "a couple of others", "rest can wait", "nothing else that needs you tonight". Do not work through the list.`,

    VOICE_FACTS_ONLY,

    `This is only about who emailed. You have no calendar, no weather and no news here, so don't reach for any — and don't imply you know what else their day held.`,

    `Don't ask them a question and don't offer to do anything. Something else may be appended after your message, so end on a complete thought rather than a lead-in.`,

    voiceTimeOfDay(),

    `The facts name which part of the day this is arriving in. Treat that as the truth and don't assume it's the evening — people set this for whenever suits them, and for someone working nights it lands at breakfast. Every time word you use has to match it: no "tonight" in the morning, no "sleep well" at breakfast. If it doesn't obviously suit a greeting or sign-off, leave both off and just tell them what came in. Never guess at whether their day is starting or ending.`,

    VOICE_SINGLE_LINE,
  ].join("\n\n");
}

export function digestFactBlock(day: DigestDay): string {
  const people = day.senders.length;
  return [
    `Right now it is ${day.localTime} on ${day.localWeekday} for them — ${timeOfDayBand(day.localTime)}.`,
    `${day.total} email${day.total === 1 ? "" : "s"} from ${people} ${people === 1 ? "person" : "people"} today, newest last:`,
    day.senders
      .map((g) => `- ${g.name}: "${g.subject}"${g.count > 1 ? ` (and ${g.count - 1} more on the same thread)` : ""}`)
      .join("\n"),
  ].join("\n\n");
}

// Turns the held queue into what actually gets sent. Falls back to the old hardcoded list if the
// model call fails for any reason: the queue is cleared on a successful send, so skipping would
// lose a day of mail the user was told they'd hear about.
async function digestText(ownerId: number, queue: DigestEmail[]): Promise<string> {
  const day: DigestDay = {
    localTime: userLocalClock(ownerId).hhmm,
    localWeekday: DateTime.fromISO(userLocalClock(ownerId).dateKey).toFormat("cccc"),
    total: queue.length,
    senders: groupBySenderAndSubject(queue).slice(0, MAX_NAMED_TO_MODEL),
  };
  const voice: ProactiveVoice = {
    assistantName: getSetting(ownerId, "assistant_name") ?? "Marlowe",
    userName: (getSetting(ownerId, "user_name") ?? "").trim().split(/\s+/)[0] ?? "",
    persona: getSetting(ownerId, "persona") ?? "",
  };
  try {
    return await renderDigest(ownerId, voice, day, "email_digest");
  } catch (err) {
    console.error(`emailDigest: falling back to the plain digest for user ${ownerId}`, err);
    return staticDigestMessage(ownerId, queue);
  }
}

// More than the model is allowed to name, so it can judge what matters rather than being handed a
// pre-made shortlist — but bounded, since a 200-deep queue would be mostly noise in the prompt.
const MAX_NAMED_TO_MODEL = 12;

export async function renderDigest(
  ownerId: number,
  voice: ProactiveVoice,
  day: DigestDay,
  purpose: string
): Promise<string> {
  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 512,
    system: digestSystemPrompt(voice),
    messages: [{ role: "user", content: digestFactBlock(day) }],
  });
  recordApiUsage(
    ownerId,
    "background",
    MODEL,
    purpose,
    response.usage?.input_tokens ?? 0,
    response.usage?.output_tokens ?? 0,
    response.usage?.cache_read_input_tokens ?? 0,
    response.usage?.cache_creation_input_tokens ?? 0
  );
  const text = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  if (!text?.text.trim()) throw new Error("the model returned no text for the digest");
  return text.text.trim();
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
  const digest = await digestText(ownerId, queue);
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
