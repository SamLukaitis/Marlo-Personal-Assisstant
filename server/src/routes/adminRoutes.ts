import { Router } from "express";
import { isAppOwner, listInvitedEmails, addInvitedEmail, removeInvitedEmail } from "../db/store.js";
import type { AuthedRequest } from "../middleware/auth.js";

export const adminRoutes = Router();

// Defense in depth: the client hides the Admin settings section for non-owners, but every route
// here re-checks isAppOwner itself — the same pattern assistant.ts uses for tool gating. A
// crafted request from a signed-in non-owner must still get a 403, not just a hidden button.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

adminRoutes.get("/api/admin/invites", (req, res) => {
  if (!isAppOwner((req as unknown as AuthedRequest).userId)) {
    res.status(403).json({ error: "not allowed" });
    return;
  }
  res.json(listInvitedEmails());
});

adminRoutes.post("/api/admin/invites", (req, res) => {
  if (!isAppOwner((req as unknown as AuthedRequest).userId)) {
    res.status(403).json({ error: "not allowed" });
    return;
  }
  const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
  if (!EMAIL_PATTERN.test(email)) {
    res.status(400).json({ error: "that doesn't look like a valid email address" });
    return;
  }
  addInvitedEmail(email);
  res.json(listInvitedEmails());
});

adminRoutes.delete("/api/admin/invites/:email", (req, res) => {
  if (!isAppOwner((req as unknown as AuthedRequest).userId)) {
    res.status(403).json({ error: "not allowed" });
    return;
  }
  removeInvitedEmail(req.params.email);
  res.json(listInvitedEmails());
});
