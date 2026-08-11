import { Router } from "express";
import { getSetting, setSetting } from "../db/store.js";
import type { AuthedRequest } from "../middleware/auth.js";

export const alertRoutes = Router();

alertRoutes.get("/api/alerts/settings", (req, res) => {
  res.json({ enabled: getSetting((req as unknown as AuthedRequest).userId, "realtime_alerts_enabled") === "true" });
});

alertRoutes.put("/api/alerts/settings", (req, res) => {
  const { enabled } = req.body ?? {};
  setSetting((req as unknown as AuthedRequest).userId, "realtime_alerts_enabled", enabled ? "true" : "false");
  res.json({ ok: true });
});
