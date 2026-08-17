import { Router } from "express";
import { getUser, isAppOwner } from "../db/store.js";
import type { AuthedRequest } from "../middleware/auth.js";

export const meRoutes = Router();

// Mounted behind requireAuth (see index.ts) — this is how the client's AuthContext finds out
// who's logged in (or gets a 401 and knows to show the public homepage). isAdmin decides
// whether the client shows the Admin settings section — purely a UI hint, since adminRoutes.ts
// re-checks isAppOwner itself on every request rather than trusting this flag.
meRoutes.get("/api/me", (req, res) => {
  const userId = (req as unknown as AuthedRequest).userId;
  const user = getUser(userId);
  if (!user) {
    res.sendStatus(401);
    return;
  }
  res.json({ id: user.id, email: user.email, isAdmin: isAppOwner(user.id) });
});
