import { Router } from "express";
import fs from "node:fs";
import {
  isAppOwner,
  listInvitedEmails,
  addInvitedEmail,
  removeInvitedEmail,
  resolveOwnerByPhone,
  deleteUserCompletely,
  deletePendingRegistration,
  normalizePhone,
  findRemainingOwnerReferences,
} from "../db/store.js";
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

// For repeatedly testing the WhatsApp registration flow with the same real phone number without
// needing a fresh one each time — wipes any in-progress registration for that number, and if it's
// already bound to a full account, wipes that account entirely (every table, plus the uploaded
// files themselves) so the same number/email can go through signup again from a clean slate.
// Irreversible, so this stays owner-only and the client puts a confirm() in front of it.
adminRoutes.post("/api/admin/reset-test-phone", (req, res) => {
  if (!isAppOwner((req as unknown as AuthedRequest).userId)) {
    res.status(403).json({ error: "not allowed" });
    return;
  }
  const phone = typeof req.body?.phone === "string" ? normalizePhone(req.body.phone) : "";
  if (!phone) {
    res.status(400).json({ error: "phone is required" });
    return;
  }

  deletePendingRegistration(phone);

  const ownerId = resolveOwnerByPhone(phone);
  try {
    if (ownerId !== null) {
      const { deletedDocumentPaths } = deleteUserCompletely(ownerId);
      for (const p of deletedDocumentPaths) {
        try {
          fs.unlinkSync(p);
        } catch {
          // best-effort — a missing file on disk shouldn't block the rest of the reset
        }
      }
    }
  } catch (err) {
    // Surface the real DB error (e.g. a newly-added owner_id-referencing table this purge
    // hasn't been taught to clear yet) instead of letting it fall through to Express's default
    // HTML error page, which the client can't parse and reports as a generic failure. The
    // transaction rolled back on throw, so ownerId's rows are all still intact here — naming
    // exactly which table blocked it beats another guess-and-redeploy cycle (this purge list has
    // gone stale three times already).
    const offenders = ownerId !== null ? findRemainingOwnerReferences(ownerId) : [];
    console.error("admin: reset-test-phone failed", err, { offenders });
    res.status(500).json({
      error: (err as Error).message,
      ...(offenders.length > 0 ? { offenders } : {}),
    });
    return;
  }

  res.json({ ok: true, hadAccount: ownerId !== null });
});
