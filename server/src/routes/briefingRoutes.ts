import { Router } from "express";
import {
  getTodaysBriefing,
  refreshBriefing,
  getBriefingSettings,
  saveBriefingSettings,
} from "../services/briefing.js";

export const briefingRoutes = Router();

briefingRoutes.get("/api/briefing", async (_req, res) => {
  try {
    res.json(await getTodaysBriefing());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

briefingRoutes.post("/api/briefing/refresh", async (_req, res) => {
  try {
    res.json(await refreshBriefing());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

briefingRoutes.get("/api/briefing/settings", (_req, res) => {
  res.json(getBriefingSettings());
});

briefingRoutes.put("/api/briefing/settings", (req, res) => {
  const { enabled, includeNews, topics } = req.body ?? {};
  saveBriefingSettings({
    enabled: !!enabled,
    includeNews: !!includeNews,
    topics: Array.isArray(topics) ? topics : [],
  });
  res.json({ ok: true });
});
