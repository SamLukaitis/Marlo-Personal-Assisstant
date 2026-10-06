import Anthropic from "@anthropic-ai/sdk";
import {
  getBriefing,
  saveBriefing,
  getSetting,
  setSetting,
  recordApiUsage,
  listCheckins,
  type TravelCheckinRow,
} from "../db/store.js";
import { hubListMessages, hubListEvents, hubFlaggedMessages } from "./hub.js";
import { fetchHeadlines, type NewsTopic } from "../providers/news.js";
import { fetchWeather, type WeatherReport } from "../providers/weather.js";
import { fetchQuotes, DEFAULT_SYMBOLS, type Quote } from "../providers/markets.js";
import { DateTime } from "luxon";
import { getUserTimezone, userLocalClock } from "./userTimezone.js";
import { eventLocalDateKey } from "./eventTime.js";
import type { CalendarEvent, UnifiedMessage } from "../providers/types.js";
// Type-only: attention.ts imports this module at runtime, so a value import here would be a cycle.
import type { AttentionBundle } from "./attention.js";

// Briefing synthesis is a once-a-day, moderately complex writeup — the richer assistant tier
// is the right fit, same as assistant.ts's routing, rather than the flat Opus default this
// used to have (which predates the cost-efficiency work and was accidentally never updated).
const MODEL = process.env.ASSISTANT_MODEL_COMPLEX ?? "claude-sonnet-5";

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

// Timed events keep their zoned ISO string (unambiguous for the model); an all-day event's plain
// date would otherwise read as a midnight start.
export function describeEventTime(e: CalendarEvent): string {
  return e.allDay ? `${e.title} (all day)` : `${e.title} at ${e.start}`;
}

// What the attention gate (attention.ts) has for this morning: reminders due in the next couple of
// hours, non-urgent things worth knowing, and what Marlowe noted since yesterday with when it will
// bring each up. Labelled so the model keeps the three apart and repeats their wording.
export function attentionFactLines(bundle: AttentionBundle | undefined): string[] {
  if (!bundle) return [];
  const lines: string[] = [];
  if (bundle.upcoming.length) {
    lines.push(
      `Coming up in the next couple of hours — lead the briefing with these, keeping the *bold* specifics: ${bundle.upcoming.join(" | ")}`
    );
  }
  if (bundle.needsAttention.length) {
    lines.push(`Worth knowing (one short line each, keep the *bold* specifics): ${bundle.needsAttention.join(" | ")}`);
  }
  if (bundle.noted.length) {
    lines.push(
      `Noted since the last briefing (one short line each, keep the *bold* specifics and the "I'll remind you" part word for word): ${bundle.noted.join(" | ")}`
    );
  }
  return lines;
}

export function briefingSystemPrompt(assistantName: string, persona: string): string {
  return `You are ${assistantName}, the user's personal assistant, writing their morning briefing.${
    persona ? ` The user described their preferences: ${persona}` : ""
  } Write it like a sharp PA: only what matters today, terse and scannable, using ONLY the facts given below — never supplement them with your own general knowledge, training data, or plausible-sounding guesses. This is a hard rule: fabricating a headline, email, event or date is a serious error.

Structure, in this order. Omit any section with nothing worth saying — no "nothing scheduled", no "no new emails":
- Coming up: ONLY if a "Coming up in the next couple of hours" fact is present. These lead.
- Location: ONLY if a "Currently in ..." fact is present. One short clause (don't say "just arrived" or "welcome to" unless the fact says arrived today).
- Weather: ONLY if a "Weather in ..." fact is present. One short clause.
- Calendar: today's events from "Today's calendar events". Add a note from "Calendar events in the next 3 days" only if it needs prep now (a flight, checking out of where they're staying).
- People: ONLY an email from "Unread emails today" or "Emails that look like they need a reply" that genuinely looks like it needs the user — name at most 2, and say what they want if the subject makes it clear. Never state a count of unread emails.
- Worth knowing: ONLY if a "Worth knowing" fact is present.
- Noted since the last briefing: ONLY if that fact is present — keep each item's "I'll remind you" wording.
- Markets: ONLY if a "Markets:" fact is present. One short line, mentioning direction.
- News: ONLY if a "Top news headlines" fact is present. One line per headline, max 3.

Keep WhatsApp *bold* markers from the facts. No headers, no preamble, no sign-off. Keep the whole thing under 120 words. If nothing at all is worth saying, reply with one short line saying the day looks clear.`;
}

async function buildBriefingText(ownerId: number, attention?: AttentionBundle): Promise<string> {
  const settings = getBriefingSettings(ownerId);
  const assistantName = getSetting(ownerId, "assistant_name") ?? "Marlowe";
  const persona = getSetting(ownerId, "persona") ?? "";

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
  const todayKeyStr = userLocalClock(ownerId).dateKey;
  // By calendar day, not the string prefix — a UTC "Z" time near midnight is a different local day.
  const todayEvents = events.filter((e) => eventLocalDateKey(e.start, zone) === todayKeyStr);
  const upcomingEvents = events.filter((e) => eventLocalDateKey(e.start, zone) !== todayKeyStr);
  const location = describeLocationStreak(listCheckins(ownerId, 1)[0], now, zone);
  const { headlines: news, quotes, weather } = await getBriefingFeed(ownerId);

  const facts = [
    ...attentionFactLines(attention),
    location,
    weather
      ? `Weather in ${weather.place}: ${weather.condition}, currently ${weather.tempC}°C, high ${weather.highC}°C, low ${weather.lowC}°C`
      : "",
    quotes.length
      ? `Markets: ${quotes
          .map(
            (q) =>
              `${q.name} ${q.price} (${q.changePercent >= 0 ? "+" : ""}${q.changePercent}%)`
          )
          .join("; ")}`
      : "",
    `Unread emails today: ${
      unread
        .slice(0, 15)
        .map((m) => `"${m.subject}" from ${m.from}`)
        .join("; ") || "none"
    }`,
    `Today's calendar events: ${
      todayEvents.map(describeEventTime).join("; ") || "nothing scheduled"
    }`,
    `Calendar events in the next 3 days (not today) — mention only if there's something notable, e.g. a flight or a change of accommodation: ${
      upcomingEvents.map(describeEventTime).join("; ") || "none"
    }`,
    `Emails that look like they need a reply (unread, over 3 days old, not automated): ${
      flagged.map((m) => `"${m.subject}" from ${m.from}`).join("; ") || "none"
    }`,
    news.length
      ? `Top news headlines: ${news.map((h) => `[${h.topic}] ${h.title}`).join("; ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const anthropic = getClient();
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: briefingSystemPrompt(assistantName, persona),
    messages: [{ role: "user", content: facts }],
  });
  recordApiUsage(
    ownerId,
    "background",
    MODEL,
    "daily_briefing",
    response.usage?.input_tokens ?? 0,
    response.usage?.output_tokens ?? 0,
    response.usage?.cache_read_input_tokens ?? 0,
    response.usage?.cache_creation_input_tokens ?? 0
  );

  const text = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  return text?.text ?? "Nothing to report today.";
}

// A briefing cached earlier today (e.g. the Assistant page opened it) doesn't know about attention
// items that arrived since, so the proactive send regenerates it whenever it has some to include.
export async function getTodaysBriefing(
  ownerId: number,
  attention?: AttentionBundle
): Promise<{ date: string; content: string }> {
  const date = userLocalClock(ownerId).dateKey;
  const existing = getBriefing(ownerId, date);
  if (existing && attentionFactLines(attention).length === 0) return existing;
  const content = await buildBriefingText(ownerId, attention);
  return saveBriefing(ownerId, date, content);
}

export async function refreshBriefing(ownerId: number): Promise<{ date: string; content: string }> {
  const date = userLocalClock(ownerId).dateKey;
  const content = await buildBriefingText(ownerId);
  return saveBriefing(ownerId, date, content);
}
