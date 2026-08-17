import { Router } from "express";
import { getEnabledTools, setToolEnabled, TOOL_KEYS, type ToolKey } from "../db/store.js";
import type { AuthedRequest } from "../middleware/auth.js";

export const toolsRoutes = Router();

// The tool catalog (which tools exist, their display copy) is code, not data — same precedent
// as /api/providers in accountRoutes.ts. Only which tools a given user has turned on lives in
// the database (user_enabled_tools).
const TOOL_CATALOG: { key: ToolKey; label: string; description: string }[] = [
  {
    key: "teams",
    label: "Microsoft Teams chat",
    description: "Let your assistant read and search your Teams conversations.",
  },
  {
    key: "travel",
    label: "Travel / Schengen day tracker",
    description:
      "Track location check-ins and count days spent in a country or the Schengen area.",
  },
];

toolsRoutes.get("/api/tools", (req, res) => {
  const ownerId = (req as unknown as AuthedRequest).userId;
  const enabled = getEnabledTools(ownerId);
  res.json(
    TOOL_CATALOG.map((t) => ({
      ...t,
      enabled: enabled.has(t.key),
    }))
  );
});

toolsRoutes.put("/api/tools/:key", (req, res) => {
  const ownerId = (req as unknown as AuthedRequest).userId;
  const key = req.params.key as ToolKey;
  if (!TOOL_KEYS.includes(key)) {
    res.status(400).json({ error: `unknown tool: ${key}` });
    return;
  }
  const { enabled } = req.body ?? {};
  setToolEnabled(ownerId, key, !!enabled);
  res.json({ ok: true });
});
