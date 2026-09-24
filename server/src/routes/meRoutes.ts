import { Router } from "express";
import { getUser, isAppOwner, isAdmin } from "../db/store.js";
import type { AuthedRequest } from "../middleware/auth.js";

export const meRoutes = Router();

// Mounted behind requireAuth (see index.ts) — this is how the client's AuthContext finds out
// who's logged in (or gets a 401 and knows to show the public homepage). Three flags, all purely
// UI hints since the server re-checks itself on every request rather than trusting any of them:
// isAdmin (the app owner plus anyone they/other admins have promoted) gates the Portal and
// Settings' Admin section; isAppOwner (the single APP_OWNER_EMAIL account) is still reported
// because it's what /api/checkin's phone automation resolves to, but it no longer gates any UI on
// its own; whatsappSimulatorEnabled mirrors ENABLE_WHATSAPP_SIMULATOR (set only on staging) and
// gates the WhatsApp Simulator nav item — the route itself is also gated server-side, this just
// stops the link from appearing where it can't work.
meRoutes.get("/api/me", (req, res) => {
  const userId = (req as unknown as AuthedRequest).userId;
  const user = getUser(userId);
  if (!user) {
    res.sendStatus(401);
    return;
  }
  res.json({
    id: user.id,
    email: user.email,
    isAppOwner: isAppOwner(user.id),
    isAdmin: isAdmin(user.id),
    whatsappSimulatorEnabled: process.env.ENABLE_WHATSAPP_SIMULATOR === "true",
  });
});
