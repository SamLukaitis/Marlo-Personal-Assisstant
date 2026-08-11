import type { Request, Response, NextFunction } from "express";
import { getUserIdBySessionToken } from "../db/store.js";

export const SESSION_COOKIE_NAME = "session";

export interface AuthedRequest extends Request {
  userId: number;
}

// Gates every /api/* route (wired in index.ts) — reads the session cookie, resolves it to a
// user, and attaches req.userId. Anything not authenticated gets a plain 401, no redirect: this
// is an API layer, the client's route guard is what sends a logged-out browser to the homepage.
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const raw = req.cookies?.[SESSION_COOKIE_NAME] as string | undefined;
  if (!raw) {
    res.sendStatus(401);
    return;
  }
  const userId = getUserIdBySessionToken(raw);
  if (userId === null) {
    res.sendStatus(401);
    return;
  }
  (req as unknown as AuthedRequest).userId = userId;
  next();
}
