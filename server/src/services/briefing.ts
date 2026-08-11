import Anthropic from "@anthropic-ai/sdk";
import { getBriefing, saveBriefing, getSetting, setSetting } from "../db/store.js";
import { hubListMessages, hubListEvents, hubFlaggedMessages } from "./hub.js";
import { fetchHeadlines, type NewsTopic } from "../providers/news.js";

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

function todayKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate()
  ).padStart(2, "0")}`;
}

export interface BriefingSettings {
  enabled: boolean;
  includeNews: boolean;
  topics: NewsTopic[];
  proactive: boolean;
  sendTime: string; // "HH:MM", 24h, server-local time
}

const DEFAULT_SETTINGS: BriefingSettings = {
  enabled: true,
  includeNews: false,
  topics: [],
  proactive: false,
  sendTime: "07:30",
};

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

async function buildBriefingText(ownerId: number): Promise<string> {
  const settings = getBriefingSettings(ownerId);
  const assistantName = getSetting(ownerId, "assistant_name") ?? "Assistant";
  const persona = getSetting(ownerId, "persona") ?? "";

  const [messages, events, flagged] = await Promise.all([
    hubListMessages(ownerId, { limit: 50 }),
    hubListEvents(ownerId, 1),
    hubFlaggedMessages(ownerId),
  ]);

  const unread = messages.filter((m) => m.unread);
  const news =
    settings.includeNews && settings.topics.length
      ? await fetchHeadlines(settings.topics, 4)
      : [];

  const facts = [
    `Unread emails (${unread.length}): ${
      unread
        .slice(0, 15)
        .map((m) => `"${m.subject}" from ${m.from}`)
        .join("; ") || "none"
    }`,
    `Today's calendar events: ${
      events.map((e) => `${e.title} at ${e.start}`).join("; ") || "nothing scheduled"
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
    } Write a short, warm, well-organized briefing using ONLY the facts given below — never supplement them with your own general knowledge, training data, or plausible-sounding guesses, even for things like current events or news. This is a hard rule: fabricating a headline, email, or event is a serious error.

Structure:
- Inbox: based on the "Unread emails" fact.
- Calendar: based on the "Today's calendar events" fact.
- Needs attention: based on the "Emails that look like they need a reply" fact.
- News: ONLY include this section if a "Top news headlines" fact line is present below. If it is absent, do not write a News section at all — not even to say there's no news. Never invent headlines.

For Inbox/Calendar/Needs attention, if the fact says "none" or "nothing scheduled", say so briefly rather than skipping it — those sections always exist. Keep the whole thing under 200 words.`,
    messages: [{ role: "user", content: facts }],
  });

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
