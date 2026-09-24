import { Router } from "express";
import {
  importantEmailAlertsEnabled,
  realPersonAlertsEnabled,
  setImportantEmailAlertsEnabled,
  setRealPersonAlertsEnabled,
} from "../services/emailAlertSettings.js";
import type { AuthedRequest } from "../middleware/auth.js";

export const alertRoutes = Router();

alertRoutes.get("/api/alerts/settings", (req, res) => {
  res.json({ enabled: realPersonAlertsEnabled((req as unknown as AuthedRequest).userId) });
});

alertRoutes.put("/api/alerts/settings", (req, res) => {
  const { enabled } = req.body ?? {};
  setRealPersonAlertsEnabled((req as unknown as AuthedRequest).userId, !!enabled);
  res.json({ ok: true });
});

alertRoutes.get("/api/important-email-alerts/settings", (req, res) => {
  res.json({ enabled: importantEmailAlertsEnabled((req as unknown as AuthedRequest).userId) });
});

alertRoutes.put("/api/important-email-alerts/settings", (req, res) => {
  const { enabled } = req.body ?? {};
  setImportantEmailAlertsEnabled((req as unknown as AuthedRequest).userId, !!enabled);
  res.json({ ok: true });
});
