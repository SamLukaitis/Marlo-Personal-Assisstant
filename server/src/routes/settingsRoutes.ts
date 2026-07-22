import { Router } from "express";
import { getSetting, setSetting } from "../db/store.js";

export const settingsRoutes = Router();

settingsRoutes.get("/api/settings", (_req, res) => {
  res.json({
    assistantName: getSetting("assistant_name") ?? "Assistant",
    persona: getSetting("persona") ?? "",
  });
});

settingsRoutes.put("/api/settings", (req, res) => {
  const { assistantName, persona } = req.body ?? {};
  if (typeof assistantName === "string") setSetting("assistant_name", assistantName.slice(0, 100));
  if (typeof persona === "string") setSetting("persona", persona.slice(0, 5000));
  res.json({ ok: true });
});
