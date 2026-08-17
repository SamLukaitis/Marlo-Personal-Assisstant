import { Router } from "express";
import {
  getTodaysBriefing,
  refreshBriefing,
  getBriefingSettings,
  saveBriefingSettings,
  getBriefingFeed,
} from "../services/briefing.js";
import { NEWS_TOPICS, type NewsTopic } from "../providers/news.js";
import { normalizeSymbol } from "../providers/markets.js";
import type { AuthedRequest } from "../middleware/auth.js";

export const briefingRoutes = Router();

const KNOWN_TOPICS = new Set(Object.keys(NEWS_TOPICS));

// Both of these end up in outbound URLs (an RSS feed lookup, a quote path segment), so unknown
// values are dropped here rather than trusted from the request body.
function parseTopics(raw: unknown): NewsTopic[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((t): t is NewsTopic => typeof t === "string" && KNOWN_TOPICS.has(t));
}

function parseTickers(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const symbol = normalizeSymbol(entry);
    if (symbol) seen.add(symbol);
  }
  // A briefing segment can't usefully show more than a handful, and each one is a network call.
  return [...seen].slice(0, 8);
}

briefingRoutes.get("/api/briefing", async (req, res) => {
  try {
    res.json(await getTodaysBriefing((req as unknown as AuthedRequest).userId));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

briefingRoutes.post("/api/briefing/refresh", async (req, res) => {
  try {
    res.json(await refreshBriefing((req as unknown as AuthedRequest).userId));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

briefingRoutes.get("/api/briefing/settings", (req, res) => {
  res.json(getBriefingSettings((req as unknown as AuthedRequest).userId));
});

briefingRoutes.put("/api/briefing/settings", (req, res) => {
  const {
    enabled,
    includeNews,
    topics,
    includeMarkets,
    tickers,
    includeWeather,
    weatherLocation,
    proactive,
    sendTime,
  } = req.body ?? {};
  saveBriefingSettings((req as unknown as AuthedRequest).userId, {
    enabled: !!enabled,
    includeNews: !!includeNews,
    topics: parseTopics(topics),
    includeMarkets: !!includeMarkets,
    tickers: parseTickers(tickers),
    includeWeather: !!includeWeather,
    weatherLocation: typeof weatherLocation === "string" ? weatherLocation.trim().slice(0, 100) : "",
    proactive: !!proactive,
    sendTime: typeof sendTime === "string" && /^\d{2}:\d{2}$/.test(sendTime) ? sendTime : "07:30",
  });
  res.json({ ok: true });
});

// One call for the Assistant page's briefing bar, so it doesn't have to know which sources the
// user opted into or fan out to a route per source.
briefingRoutes.get("/api/briefing/feed", async (req, res) => {
  try {
    res.json(await getBriefingFeed((req as unknown as AuthedRequest).userId));
  } catch (err) {
    console.error("briefing: feed failed", err);
    res.status(500).json({ error: "failed to load briefing feed" });
  }
});
