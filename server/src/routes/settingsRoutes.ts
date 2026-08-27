import { Router } from "express";
import { getSetting, setSetting } from "../db/store.js";
import type { AuthedRequest } from "../middleware/auth.js";

export const settingsRoutes = Router();

settingsRoutes.get("/api/settings", (req, res) => {
  const ownerId = (req as unknown as AuthedRequest).userId;
  res.json({
    assistantName: getSetting(ownerId, "assistant_name") ?? "Marlowe",
    persona: getSetting(ownerId, "persona") ?? "",
  });
});

settingsRoutes.put("/api/settings", (req, res) => {
  const ownerId = (req as unknown as AuthedRequest).userId;
  const { assistantName, persona } = req.body ?? {};
  if (typeof assistantName === "string") setSetting(ownerId, "assistant_name", assistantName.slice(0, 100));
  if (typeof persona === "string") setSetting(ownerId, "persona", persona.slice(0, 5000));
  res.json({ ok: true });
});
