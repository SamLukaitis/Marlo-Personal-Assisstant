import { Router } from "express";
import { getSetting, setSetting } from "../db/store.js";
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
  });
});

settingsRoutes.put("/api/settings", (req, res) => {
  const ownerId = (req as unknown as AuthedRequest).userId;
  const { assistantName, persona, userName } = req.body ?? {};
  if (typeof assistantName === "string") setSetting(ownerId, "assistant_name", assistantName.slice(0, 100));
  if (typeof persona === "string") setSetting(ownerId, "persona", persona.slice(0, 5000));
  if (typeof userName === "string") setSetting(ownerId, "user_name", userName.trim().slice(0, 60));
  res.json({ ok: true });
});
