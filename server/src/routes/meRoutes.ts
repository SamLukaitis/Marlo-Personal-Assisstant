import { Router } from "express";
import { getUser, isAppOwner, isAdmin } from "../db/store.js";
import type { AuthedRequest } from "../middleware/auth.js";

export const meRoutes = Router();

// Mounted behind requireAuth (see index.ts) — this is how the client's AuthContext finds out
// who's logged in (or gets a 401 and knows to show the public homepage). Two distinct flags,
// both purely UI hints since the server re-checks itself on every request rather than trusting
// either: isAppOwner (the single APP_OWNER_EMAIL account) gates the narrower invites/reset-test-
// phone section in Settings; isAdmin (the app owner plus anyone they/other admins have promoted)
// gates the broader Portal.
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
  });
});
