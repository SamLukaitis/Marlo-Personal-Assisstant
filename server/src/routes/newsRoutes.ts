import { Router } from "express";
import { fetchHeadlines, NEWS_TOPICS, type NewsTopic } from "../providers/news.js";
import { getBriefingSettings } from "../services/briefing.js";
import type { AuthedRequest } from "../middleware/auth.js";

export const newsRoutes = Router();

const ALL_TOPIC_KEYS = Object.keys(NEWS_TOPICS) as NewsTopic[];

function parseTopics(raw: unknown): NewsTopic[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  const set = new Set<string>(ALL_TOPIC_KEYS);
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter((t): t is NewsTopic => set.has(t));
}

// Used by the Assistant page's briefing bar — respects the user's own opt-in topics from the
// morning-briefing settings (same preference, reused rather than duplicated) unless the caller
// explicitly asks for specific topics. Distinct from the assistant's own get_news tool, which
// defaults to every topic on an explicit on-demand ask rather than requiring this same opt-in —
// see assistant.ts for that reasoning.
newsRoutes.get("/api/news", async (req, res) => {
  const ownerId = (req as unknown as AuthedRequest).userId;
  const requested = parseTopics(req.query.topics);
  const topics = requested.length ? requested : getBriefingSettings(ownerId).topics;
  if (!topics.length) {
    res.json([]);
    return;
  }
  try {
    res.json(await fetchHeadlines(topics, 6));
  } catch (err) {
    console.error("news: fetch failed", err);
    res.status(500).json({ error: "failed to fetch news" });
  }
});
