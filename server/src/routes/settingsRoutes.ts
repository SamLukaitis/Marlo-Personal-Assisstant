import { Router } from "express";
import { getSetting, setSetting } from "../db/store.js";
import { setUserTimezone } from "../services/userTimezone.js";
import type { AuthedRequest } from "../middleware/auth.js";

export const settingsRoutes = Router();

settingsRoutes.get("/api/settings", (req, res) => {
  const ownerId = (req as unknown as AuthedRequest).userId;
  res.json({
    assistantName: getSetting(ownerId, "assistant_name") ?? "Marlowe",
    persona: getSetting(ownerId, "persona") ?? "",
    // Normally captured once via the ask_name WhatsApp onboarding step (postConnectSetup.ts) —
    // exposed here too so a user who finished onboarding before that step existed (or skipped it)
    // has a way to set it without going through onboarding again.
    userName: getSetting(ownerId, "user_name") ?? "",
    // The explicit override only (not the travel-check-in-derived fallback services/
    // userTimezone.ts also uses) — an empty value here just means "no override set", not "unknown".
    timezone: getSetting(ownerId, "timezone") ?? "",
  });
});

settingsRoutes.put("/api/settings", (req, res) => {
  const ownerId = (req as unknown as AuthedRequest).userId;
  const { assistantName, persona, userName, timezone } = req.body ?? {};
  if (typeof assistantName === "string") setSetting(ownerId, "assistant_name", assistantName.slice(0, 100));
  if (typeof persona === "string") setSetting(ownerId, "persona", persona.slice(0, 5000));
  if (typeof userName === "string") setSetting(ownerId, "user_name", userName.trim().slice(0, 60));
  if (typeof timezone === "string" && timezone.trim()) {
    if (!setUserTimezone(ownerId, timezone)) {
      res.status(400).json({ error: `"${timezone}" isn't a recognized IANA timezone (e.g. "Europe/London")` });
      return;
    }
  }
  res.json({ ok: true });
});
