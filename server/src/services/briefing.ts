import Anthropic from "@anthropic-ai/sdk";
import {
  getBriefing,
  saveBriefing,
  getSetting,
  setSetting,
  recordApiUsage,
  listCheckins,
  listAccounts,
  type TravelCheckinRow,
} from "../db/store.js";
import { mailboxLabel } from "./mailboxLabel.js";
import { hubListMessages, hubListEvents, hubFlaggedMessages, senderDisplayName } from "./hub.js";
import { fetchHeadlines, type NewsTopic } from "../providers/news.js";
import { fetchWeather, type WeatherReport } from "../providers/weather.js";
import { fetchQuotes, DEFAULT_SYMBOLS, type Quote } from "../providers/markets.js";
import { DateTime } from "luxon";
import { getUserTimezone, userLocalClock } from "./userTimezone.js";
import {
  voiceOpening,
  voiceTimeOfDay,
  VOICE_FACTS_ONLY,
  VOICE_FORM,
  VOICE_PEOPLE_NOT_SUBJECTS,
  VOICE_SINGLE_LINE,
  type ProactiveVoice,
} from "./proactiveVoice.js";
import { eventLocalDateKey } from "./eventTime.js";
import { phoneSuggestionsEnabled, PHONE_SUGGESTION_PROMPT, expandPhoneMarkers, stripPhoneMarkers } from "./phoneActions.js";
import type { CalendarEvent, UnifiedMessage } from "../providers/types.js";
// Type-only: attention.ts imports this module at runtime, so a value import here would be a cycle.
import type { AttentionBundle } from "./attention.js";
import { editionBriefingFacts } from "../editions/index.js";

// Briefing synthesis is a once-a-day, moderately complex writeup — the richer assistant tier
// is the right fit, same as assistant.ts's routing, rather than the flat Opus default this
// used to have (which predates the cost-efficiency work and was accidentally never updated).
const MODEL = process.env.ASSISTANT_MODEL_COMPLEX ?? "claude-sonnet-5-5";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY is not set — add it to server/.env");
    }
    client = new Anthropic();
  }
  return client;
}

export interface BriefingSettings {
  enabled: boolean;
  includeNews: boolean;
  topics: NewsTopic[];
  includeMarkets: boolean;
  tickers: string[];
  includeWeather: boolean;
  weatherLocation: string;
  proactive: boolean;
  sendTime: string; // "HH:MM", 24h, in the user's own timezone (server time if theirs isn't known)
}

const DEFAULT_SETTINGS: BriefingSettings = {
  enabled: true,
  includeNews: false,
  topics: [],
  includeMarkets: false,
  tickers: [],
  includeWeather: false,
  weatherLocation: "",
  proactive: false,
  sendTime: "07:30",
};

export interface BriefingFeed {
  headlines: Awaited<ReturnType<typeof fetchHeadlines>>;
  quotes: Quote[];
  weather: WeatherReport | null;
}

// The single source of "what does this user actually want to see" — used by both the morning
// briefing text and the Assistant page's briefing bar, so the two can never drift apart on which
// sources are on. Every source is independently best-effort: one failing provider degrades that
// one segment rather than emptying the whole feed.
export async function getBriefingFeed(ownerId: number): Promise<BriefingFeed> {
  const settings = getBriefingSettings(ownerId);

  const [headlines, quotes, weather] = await Promise.all([
    settings.includeNews && settings.topics.length
      ? fetchHeadlines(settings.topics, 4).catch(() => [])
      : Promise.resolve([]),
    settings.includeMarkets
      ? fetchQuotes(settings.tickers.length ? settings.tickers : DEFAULT_SYMBOLS).catch(() => [])
      : Promise.resolve([]),
    settings.includeWeather && settings.weatherLocation
      ? fetchWeather(settings.weatherLocation).catch(() => null)
      : Promise.resolve(null),
  ]);

  return { headlines, quotes, weather };
}

// Whether this user has ever saved briefing settings — distinct from getBriefingSettings()
// returning non-defaults, since someone can deliberately keep every default value. Used as the
// "still onboarding" signal in assistant.ts's system prompt: no new flag/table, just reusing
// whether this specific setting exists yet.
export function hasBriefingSettings(ownerId: number): boolean {
  return getSetting(ownerId, "briefing_settings") !== null;
}

export function getBriefingSettings(ownerId: number): BriefingSettings {
  const raw = getSetting(ownerId, "briefing_settings");
  if (!raw) return DEFAULT_SETTINGS;
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveBriefingSettings(ownerId: number, settings: BriefingSettings): void {
  setSetting(ownerId, "briefing_settings", JSON.stringify(settings));
}

// The "unread emails" headline count is meant to answer "what's new since I last looked" — not
// "how many unread messages currently sit in my last N fetched", which silently includes whatever
// was already unread yesterday (or further back) and just never got dealt with. Those older unread
// messages aren't lost: hubFlaggedMessages already surfaces the >3-day-old ones under "needs a
// reply". This just keeps the headline count from double-counting yesterday's backlog as "today's"
// unread mail.
export function selectUnreadSinceMidnight(
  messages: UnifiedMessage[],
  now: Date,
  zone?: string | null
): UnifiedMessage[] {
  const midnight = startOfDayMs(now.getTime(), zone);
  return messages.filter((m) => m.unread && new Date(m.receivedAt).getTime() >= midnight);
}

// Midnight of the day `ms` falls on — in `zone` (the user's IANA timezone) when known and usable,
// else the server's own zone, which is what these day boundaries used before there was a timezone.
function startOfDayMs(ms: number, zone?: string | null): number {
  const zoned = zone ? DateTime.fromMillis(ms, { zone }) : DateTime.fromMillis(ms);
  return (zoned.isValid ? zoned : DateTime.fromMillis(ms)).startOf("day").toMillis();
}

// Gives the briefing continuity about where the user has been, instead of leaving the model to
// guess from whatever calendar/document text happens to be in context — which is how "arrived in
// Rio" mentions kept resurfacing days after the actual arrival. checkin is the most recent
// travel_checkin row (listCheckins(ownerId, 1)[0]), or undefined if none exist yet.
export function describeLocationStreak(
  checkin: TravelCheckinRow | undefined,
  now: Date,
  zone?: string | null
): string {
  if (!checkin || !checkin.city) return "";
  const place = checkin.country ? `${checkin.city}, ${checkin.country}` : checkin.city;
  const midnight = startOfDayMs(now.getTime(), zone);
  const checkinMidnight = startOfDayMs(checkin.checkedInAt, zone);
  const daysSince = Math.round((midnight - checkinMidnight) / (24 * 60 * 60 * 1000));
  if (daysSince <= 0) return `Currently in ${place} — arrived today.`;
  return `Currently in ${place} — arrived ${daysSince} day${daysSince === 1 ? "" : "s"} ago, been there ${daysSince} day${daysSince === 1 ? "" : "s"}.`;
}

// The briefing is written as prose, so the model needs the day in words ("Thursday") as well as
// the clock time. Handed a raw ISO string it either does the weekday arithmetic itself (a guess
// presented as fact) or reads the date out loud — "2026-10-02T19:15:00+02:00" becoming "Oct 2,
// 19:15", which is exactly the robotic register this is trying to get away from. Formatted here,
// in the user's own zone, so the weekday is a fact rather than the model's inference.
//
// An invalid or unparseable start falls back to the raw string: better a stiff line than a
// confidently wrong day.
export function describeEventTime(e: CalendarEvent, zone?: string | null): string {
  const at = DateTime.fromISO(e.start, zone ? { zone } : undefined);
  if (!at.isValid) return e.allDay ? `${e.title} (all day, ${e.start})` : `${e.title} at ${e.start}`;
  const day = at.toFormat("cccc d LLL");
  return e.allDay ? `${e.title} (all day, ${day})` : `${e.title} at ${at.toFormat("HH:mm")} on ${day}`;
}

// What the attention gate (attention.ts) is holding for this briefing: reminders due in the next
// couple of hours, non-urgent things worth knowing, and what Marlo quietly filed since yesterday
// with when it will bring each up. Labelled so the model keeps the three apart.
export type BriefingAttention = Pick<AttentionBundle, "upcoming" | "needsAttention" | "noted">;

export function attentionFactLines(attention: BriefingAttention | undefined): string[] {
  if (!attention) return [];
  const lines: string[] = [];
  if (attention.upcoming.length) {
    lines.push(`Coming up soon — lead with these: ${attention.upcoming.join(" | ")}`);
  }
  if (attention.needsAttention.length) {
    lines.push(`Worth knowing: ${attention.needsAttention.join(" | ")}`);
  }
  if (attention.noted.length) {
    lines.push(`Noted since the last briefing, each with when you'll bring it up again: ${attention.noted.join(" | ")}`);
  }
  return lines;
}

// Everything the briefing's voice depends on that isn't a fact about the day. Split out from the
// fetch so the Briefing Lab (briefingPreview.ts) renders synthetic profiles through this exact
// prompt — a second copy of it would have drifted from the real one within a week.
export type BriefingVoice = ProactiveVoice;

// The facts the model is allowed to use, already reduced to display strings. Anything not in here
// does not exist as far as the briefing is concerned (the prompt is emphatic about that), so this
// type is also the definition of what a briefing can ever mention.
export interface BriefingDay {
  /** "07:30" in the user's own zone — what the greeting and sign-off are pitched to. */
  localTime: string;
  /** "Wednesday" in the user's own zone. */
  localWeekday: string;
  /** describeLocationStreak output, or "" when there's no check-in. */
  location: string;
  weather: WeatherReport | null;
  quotes: Quote[];
  /**
   * Unread since local midnight. `shown` is capped for the prompt; `count` is the real total.
   * `from` is a display name (senderDisplayName), never a raw address — the briefing is prose.
   */
  unread: { count: number; shown: { subject: string; from: string }[] };
  /** describeEventTime output for each. */
  todayEvents: string[];
  upcomingEvents: string[];
  /** `from` is a display name, as with `unread`. */
  flagged: { subject: string; from: string }[];
  news: { topic: string; title: string }[];
  /** What the attention gate is holding for this briefing (attention.ts); absent or empty when nothing. */
  attention?: BriefingAttention;
  /** Edition-specific fact lines (editions/index.ts), e.g. the business edition's money summary. */
  extraFacts?: string[];
  /** Mailboxes whose connection has expired, e.g. "Gmail (a@example.com)" — their mail and events are missing above. */
  brokenConnections?: string[];
}

// Added after the model's text rather than left to it: on a day with a dead connection the
// briefing must say so, and a 70-word limit with "drop things" instructions could drop it.
// "Reply reconnect" rather than a link: see connectionAlert.ts.
export function connectionNoticeLines(ownerId: number): string[] {
  return listAccounts(ownerId)
    .filter((a) => a.authBroken && (a.provider === "google" || a.provider === "microsoft"))
    .map(
      (a) =>
        `⚠️ I couldn't read your *${mailboxLabel(a.provider)}* (${a.email}) today — the connection has expired. Reply *reconnect* and I'll send you a link to fix it.`
    );
}

// Nothing on today, no new mail, nothing waiting on a reply. Decided here rather than left to the
// model to infer from three separate "none" lines, because the quiet-day message is a different
// message rather than a shorter one — the branch has to be reliable, not probabilistic.
// Anything the attention gate is holding (a reminder, something noted) is news, so not quiet.
export function isQuietDay(day: BriefingDay): boolean {
  return (
    day.unread.count === 0 &&
    day.todayEvents.length === 0 &&
    day.flagged.length === 0 &&
    attentionFactLines(day.attention).length === 0 &&
    !day.extraFacts?.length &&
    !day.brokenConnections?.length
  );
}

export function briefingSystemPrompt(voice: BriefingVoice): string {
  // Composed from proactiveVoice.ts's shared register so the briefing and the evening round-up
  // can't drift on tone or on the facts-only rules. Only the bits that are genuinely specific to a
  // morning briefing live here: its length, the quiet-day branch, and the opt-in feeds.
  return [
    voiceOpening(voice, "sending them a short message to start the day"),

    `Write one short paragraph, the way you'd text someone you work for. Aim for about 45 words and never go past 70 — on the busiest day that means dropping things, not writing tighter. ${VOICE_FORM}`,

    VOICE_PEOPLE_NOT_SUBJECTS,

    `Name at most two things. If there's more, describe the shape of the rest in a few words and stop — "a couple of others can wait", "rest is newsletters", "nothing else urgent". Being complete is the wrong instinct; they can ask you for the rest.`,

    VOICE_FACTS_ONLY,

    `Some facts are things you've been keeping track of for them. "Coming up soon" items lead the message. "Worth knowing" items get a few words each. "Noted since the last briefing" items are things you've quietly filed — mention them briefly so they know you've got it, and say when you'll bring each one up again. For all three keep the specifics that matter (who or what, the date or time, the amount, a booking reference) and drop the rest. They don't count toward the two-thing limit; fold several into one sentence, and on a day with these the message may run to about 100 words.`,

    `If the facts say QUIET DAY, don't recite the emptiness back to them. Say something easy and short that makes clear there's nothing to worry about${
      voice.userName ? `, using their first name` : ""
    } — one or two sentences, warm, worded differently each day rather than a stock line. Anything worth acting on from the next three days still gets a mention.`,

    voiceTimeOfDay(),

    `Weather, markets and news are opt-in. Mention one ONLY if its fact line is present below, in a few words inside a sentence, and leave it out entirely otherwise — never a line saying there's none. For markets, say the direction in plain words, not a string of percentages.`,

    VOICE_SINGLE_LINE,
  ].join("\n\n");
}

export function briefingFactBlock(day: BriefingDay): string {
  return [
    `Right now it is ${day.localTime} on ${day.localWeekday}, the user's own local time.`,
    ...attentionFactLines(day.attention),
    ...(day.extraFacts ?? []),
    day.brokenConnections?.length
      ? `CONNECTION PROBLEM: couldn't read ${day.brokenConnections.join(" or ")} today — the connection has expired, so its mail and calendar are missing from the facts below. Never describe their inbox or their day as empty or quiet because of it. A line telling them how to reconnect is added after your message, so don't write one yourself.`
      : "",
    isQuietDay(day)
      ? "QUIET DAY: nothing on their calendar today, no unread mail today, nothing waiting on a reply. Use the quiet-day check-in from your instructions. Anything worth acting on from the next-three-days list below still gets mentioned — a quiet day with a flight to pack for is still a quiet day, but they should hear about the flight."
      : "",
    day.location,
    day.weather
      ? `Weather in ${day.weather.place}: ${day.weather.condition}, currently ${day.weather.tempC}°C, high ${day.weather.highC}°C, low ${day.weather.lowC}°C`
      : "",
    day.quotes.length
      ? `Markets: ${day.quotes
          .map(
            (q) =>
              `${q.name} ${q.price} (${q.changePercent >= 0 ? "+" : ""}${q.changePercent}%)`
          )
          .join("; ")}`
      : "",
    `Unread emails today (${day.unread.count}): ${
      day.unread.shown
        .map((m) => `"${m.subject}" from ${m.from}`)
        .join("; ") || "none"
    }`,
    `Today's calendar events: ${
      day.todayEvents.join("; ") || "nothing scheduled"
    }`,
    `Calendar events in the next 3 days (not today) — mention only if there's something notable, e.g. a flight or a change of accommodation: ${
      day.upcomingEvents.join("; ") || "none"
    }`,
    `Emails that look like they need a reply (unread, over 3 days old, not automated): ${
      day.flagged.map((m) => `"${m.subject}" from ${m.from}`).join("; ") || "none"
    }`,
    day.news.length
      ? `Top news headlines: ${day.news.map((h) => `[${h.topic}] ${h.title}`).join("; ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

// The one place the briefing model is actually called. `purpose` separates the real morning
// briefing from Briefing Lab renders in the API-usage breakdown, so preview spend is visible
// rather than hidden inside daily_briefing's numbers.
export async function renderBriefing(
  ownerId: number,
  voice: BriefingVoice,
  day: BriefingDay,
  purpose: string,
  // Only the real morning send passes this (phone suggestions); Briefing Lab never does.
  extraSystem?: string
): Promise<string> {
  const anthropic = getClient();
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: extraSystem ? `${briefingSystemPrompt(voice)}

${extraSystem}` : briefingSystemPrompt(voice),
    messages: [{ role: "user", content: briefingFactBlock(day) }],
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
  return text?.text ?? "Nothing to report today.";
}

// Gathers the real day for a real user, then hands it to the shared renderer above.
async function buildBriefingText(ownerId: number, attention?: BriefingAttention): Promise<string> {
  const assistantName = getSetting(ownerId, "assistant_name") ?? "Marlo";
  const persona = getSetting(ownerId, "persona") ?? "";
  const userName = (getSetting(ownerId, "user_name") ?? "").trim().split(/\s+/)[0] ?? "";

  const now = new Date();
  // 3-day window (not just today) so a hostel checkout or flight tomorrow/the day after shows up
  // in advance instead of only appearing the morning it happens.
  const [messages, events, flagged] = await Promise.all([
    hubListMessages(ownerId, { limit: 50 }),
    hubListEvents(ownerId, 3),
    hubFlaggedMessages(ownerId),
  ]);

  // "Today" is the user's own day, not the server's (see userTimezone.ts for how their zone is known).
  const zone = getUserTimezone(ownerId);
  const unread = selectUnreadSinceMidnight(messages, now, zone);
  const clock = userLocalClock(ownerId);
  // By calendar day, not the string prefix — a UTC "Z" time near midnight is a different local day.
  const todayEvents = events.filter((e) => eventLocalDateKey(e.start, zone) === clock.dateKey);
  const upcomingEvents = events.filter((e) => eventLocalDateKey(e.start, zone) !== clock.dateKey);
  const { headlines: news, quotes, weather } = await getBriefingFeed(ownerId);

  const suggest = phoneSuggestionsEnabled(ownerId);
  const text = await renderBriefing(
    ownerId,
    { assistantName, userName, persona },
    {
      localTime: clock.hhmm,
      localWeekday: DateTime.fromISO(clock.dateKey).toFormat("cccc"),
      location: describeLocationStreak(listCheckins(ownerId, 1)[0], now, zone),
      weather,
      quotes,
      // Display name, not the raw address: handed "accounts@supplier.example" the model writes it
      // out verbatim mid-sentence, which reads like a machine. The email digest has always done
      // this (senderDisplayName); the briefing was passing raw `from` and it showed.
      unread: {
        count: unread.length,
        shown: unread.slice(0, 15).map((m) => ({ subject: m.subject, from: senderDisplayName(m.from) })),
      },
      todayEvents: todayEvents.map((e) => describeEventTime(e, zone)),
      upcomingEvents: upcomingEvents.map((e) => describeEventTime(e, zone)),
      flagged: flagged.map((m) => ({ subject: m.subject, from: senderDisplayName(m.from) })),
      news: news.map((h) => ({ topic: h.topic, title: h.title })),
      attention,
      extraFacts: editionBriefingFacts(ownerId, clock.dateKey),
      // Read after the hub calls above, which are what flag a dead connection.
      brokenConnections: listAccounts(ownerId)
        .filter((a) => a.authBroken)
        .map((a) => `${mailboxLabel(a.provider)} (${a.email})`),
    },
    "daily_briefing",
    suggest ? PHONE_SUGGESTION_PROMPT : undefined
  );
  let body: string;
  try {
    body = expandPhoneMarkers(ownerId, text, "briefing");
  } catch (err) {
    // The briefing is the product; a phone-link failure must not cost the user their morning.
    console.error("briefing: phone marker expansion failed, sending without links", err);
    body = stripPhoneMarkers(text);
  }
  return [body, ...connectionNoticeLines(ownerId)].join("\n\n");
}

// A briefing cached earlier today (e.g. the Assistant page opened it) doesn't know about attention
// items that arrived since, so the proactive send regenerates it whenever it has some to include.
export async function getTodaysBriefing(
  ownerId: number,
  attention?: BriefingAttention
): Promise<{ date: string; content: string }> {
  const date = userLocalClock(ownerId).dateKey;
  const existing = getBriefing(ownerId, date);
  if (existing && attentionFactLines(attention).length === 0) return existing;
  const content = await buildBriefingText(ownerId, attention);
  return saveBriefing(ownerId, date, content);
}

export async function refreshBriefing(
  ownerId: number,
  attention?: BriefingAttention
): Promise<{ date: string; content: string }> {
  const date = userLocalClock(ownerId).dateKey;
  const content = await buildBriefingText(ownerId, attention);
  return saveBriefing(ownerId, date, content);
}
