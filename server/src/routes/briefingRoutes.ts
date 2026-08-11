import { Router } from "express";
import {
  getTodaysBriefing,
  refreshBriefing,
  getBriefingSettings,
  saveBriefingSettings,
} from "../services/briefing.js";
import type { AuthedRequest } from "../middleware/auth.js";

export const briefingRoutes = Router();

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
  const { enabled, includeNews, topics, proactive, sendTime } = req.body ?? {};
  saveBriefingSettings((req as unknown as AuthedRequest).userId, {
    enabled: !!enabled,
    includeNews: !!includeNews,
    topics: Array.isArray(topics) ? topics : [],
    proactive: !!proactive,
    sendTime: typeof sendTime === "string" && /^\d{2}:\d{2}$/.test(sendTime) ? sendTime : "07:30",
  });
  res.json({ ok: true });
});
