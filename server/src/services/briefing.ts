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
import { todayKey } from "./dateKey.js";
import type { UnifiedMessage } from "../providers/types.js";

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
  sendTime: string; // "HH:MM", 24h, server-local time
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
export function selectUnreadSinceMidnight(messages: UnifiedMessage[], now: Date): UnifiedMessage[] {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return messages.filter((m) => m.unread && new Date(m.receivedAt).getTime() >= midnight);
}

// Gives the briefing continuity about where the user has been, instead of leaving the model to
// guess from whatever calendar/document text happens to be in context — which is how "arrived in
// Rio" mentions kept resurfacing days after the actual arrival. checkin is the most recent
// travel_checkin row (listCheckins(ownerId, 1)[0]), or undefined if none exist yet.
export function describeLocationStreak(checkin: TravelCheckinRow | undefined, now: Date): string {
  if (!checkin || !checkin.city) return "";
  const place = checkin.country ? `${checkin.city}, ${checkin.country}` : checkin.city;
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const checkinMidnight = new Date(
    new Date(checkin.checkedInAt).getFullYear(),
    new Date(checkin.checkedInAt).getMonth(),
    new Date(checkin.checkedInAt).getDate()
  ).getTime();
  const daysSince = Math.round((midnight - checkinMidnight) / (24 * 60 * 60 * 1000));
  if (daysSince <= 0) return `Currently in ${place} — arrived today.`;
  return `Currently in ${place} — arrived ${daysSince} day${daysSince === 1 ? "" : "s"} ago, been there ${daysSince} day${daysSince === 1 ? "" : "s"}.`;
}

async function buildBriefingText(ownerId: number): Promise<string> {
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

  const unread = selectUnreadSinceMidnight(messages, now);
  const todayKeyStr = todayKey();
  const todayEvents = events.filter((e) => e.start.startsWith(todayKeyStr));
  const upcomingEvents = events.filter((e) => !e.start.startsWith(todayKeyStr));
  const location = describeLocationStreak(listCheckins(ownerId, 1)[0], now);
  const { headlines: news, quotes, weather } = await getBriefingFeed(ownerId);

  const facts = [
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
    `Unread emails today (${unread.length}): ${
      unread
        .slice(0, 15)
        .map((m) => `"${m.subject}" from ${m.from}`)
        .join("; ") || "none"
    }`,
    `Today's calendar events: ${
      todayEvents.map((e) => `${e.title} at ${e.start}`).join("; ") || "nothing scheduled"
    }`,
    `Calendar events in the next 3 days (not today) — mention only if there's something notable, e.g. a flight or a change of accommodation: ${
      upcomingEvents.map((e) => `${e.title} at ${e.start}`).join("; ") || "none"
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
    system: `You are ${assistantName}, the user's personal assistant, writing their morning briefing.${
      persona ? ` The user described their preferences: ${persona}` : ""
    } Write a terse, scannable briefing using ONLY the facts given below — never supplement them with your own general knowledge, training data, or plausible-sounding guesses, even for things like current events or news. This is a hard rule: fabricating a headline, email, or event is a serious error.

Structure, in this order:
- Location: ONLY if a "Currently in ..." fact line is present below. One short clause, e.g. mention in passing if it's relevant to the day (don't say "just arrived" or "welcome to" unless the fact itself says arrived today).
- Weather: ONLY if a "Weather in ..." fact line is present below. One short clause.
- Inbox: one line based on the "Unread emails today" fact — the count plus at most 2-3 senders/subjects worth calling out, not a full list.
- Calendar: based on the "Today's calendar events" fact. Only add a note from "Calendar events in the next 3 days" if it's something the user should prep for now (a flight, checking out of where they're staying) — otherwise leave it out entirely.
- Needs attention: one line based on the "Emails that look like they need a reply" fact.
- Markets: ONLY if a "Markets:" fact line is present below. One short line, mentioning direction.
- News: ONLY include this section if a "Top news headlines" fact line is present below. One line per headline, max 3.

Weather, Markets, News, and the upcoming-events note are opt-in: if there's nothing to say, omit them entirely — not even a line saying there's none. Never invent a headline, a price, or a forecast.

For Inbox/Calendar/Needs attention, if the fact says "none" or "nothing scheduled", say so in one short clause rather than skipping it — those three always get a line. No headers, no preamble, no sign-off — just the lines themselves. Keep the whole thing under 100 words.`,
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

export async function getTodaysBriefing(ownerId: number): Promise<{ date: string; content: string }> {
  const date = todayKey();
  const existing = getBriefing(ownerId, date);
  if (existing) return existing;
  const content = await buildBriefingText(ownerId);
  return saveBriefing(ownerId, date, content);
}

export async function refreshBriefing(ownerId: number): Promise<{ date: string; content: string }> {
  const date = todayKey();
  const content = await buildBriefingText(ownerId);
  return saveBriefing(ownerId, date, content);
}
