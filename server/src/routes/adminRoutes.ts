import { Router } from "express";
import fs from "node:fs";
import {
  isAppOwner,
  listInvitedPhones,
  addInvitedPhone,
  removeInvitedPhone,
  resolveOwnerByPhone,
  deleteUserCompletely,
  deletePendingRegistration,
  normalizePhone,
  findRemainingOwnerReferences,
  listPhoneNumbersForUser,
  resetOnboardingConnectionState,
  getWhatsAppHistory,
  getOnboardingStepEvents,
} from "../db/store.js";
import type { AuthedRequest } from "../middleware/auth.js";

export const adminRoutes = Router();

// Defense in depth: the client hides the Admin settings section for non-owners, but every route
// here re-checks isAppOwner itself — the same pattern assistant.ts uses for tool gating. A
// crafted request from a signed-in non-owner must still get a 403, not just a hidden button.
//
// Invite-only access is gated by phone number, not email — send a tester the WhatsApp number to
// message and add their number here; no need to collect their email in advance (see
// isPhoneInvited/addInvitedPhone in db/store.ts).
adminRoutes.get("/api/admin/invites", (req, res) => {
  if (!isAppOwner((req as unknown as AuthedRequest).userId)) {
    res.status(403).json({ error: "not allowed" });
    return;
  }
  res.json(listInvitedPhones());
});

adminRoutes.post("/api/admin/invites", (req, res) => {
  if (!isAppOwner((req as unknown as AuthedRequest).userId)) {
    res.status(403).json({ error: "not allowed" });
    return;
  }
  const phone = typeof req.body?.phone === "string" ? normalizePhone(req.body.phone) : "";
  if (!phone) {
    res.status(400).json({ error: "that doesn't look like a valid phone number" });
    return;
  }
  addInvitedPhone(phone);
  res.json(listInvitedPhones());
});

adminRoutes.delete("/api/admin/invites/:phone", (req, res) => {
  if (!isAppOwner((req as unknown as AuthedRequest).userId)) {
    res.status(403).json({ error: "not allowed" });
    return;
  }
  removeInvitedPhone(req.params.phone);
  res.json(listInvitedPhones());
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

// For replaying the WhatsApp onboarding UX end-to-end on an account you actually want to keep —
// unlike reset-test-phone above, this never touches data-bearing tables (usage, to-dos, poster
// board, documents, memory, chat history all stay put). Always targets the CALLER's own account,
// never an arbitrary phone/owner, since it's for testing your own signup flow, not resetting
// someone else's. Genuinely revokes the connected mail/calendar access (OAuth tokens are
// deleted), so reconnecting for real afterward does require going through OAuth again — see
// resetOnboardingConnectionState's own comment for exactly what is and isn't cleared.
adminRoutes.post("/api/admin/replay-onboarding", (req, res) => {
  const userId = (req as unknown as AuthedRequest).userId;
  if (!isAppOwner(userId)) {
    res.status(403).json({ error: "not allowed" });
    return;
  }
  const phones = listPhoneNumbersForUser(userId);
  for (const p of phones) {
    deletePendingRegistration(p.phone);
  }
  resetOnboardingConnectionState(userId);
  res.json({ ok: true, unboundPhones: phones.map((p) => p.phone) });
});

// The conversation viewer for watching a test user's onboarding/chat play out instead of guessing
// from server logs — merges the raw WhatsApp history (getWhatsAppHistory) with that owner's
// onboarding_step_events log (see db/store.ts) into one chronological timeline, so a "reached
// ask_briefing" marker sits right where it actually happened relative to the messages around it.
// 200 messages is generous for a test conversation without being an unbounded query.
adminRoutes.get("/api/admin/messages", (req, res) => {
  if (!isAppOwner((req as unknown as AuthedRequest).userId)) {
    res.status(403).json({ error: "not allowed" });
    return;
  }
  const phone = typeof req.query.phone === "string" ? normalizePhone(req.query.phone) : "";
  if (!phone) {
    res.status(400).json({ error: "phone is required" });
    return;
  }
  const ownerId = resolveOwnerByPhone(phone);
  if (ownerId === null) {
    res.status(404).json({ error: "no account found for that phone number" });
    return;
  }

  const messages = getWhatsAppHistory(phone, 200).map((m) => ({
    kind: "message" as const,
    createdAt: m.createdAt,
    role: m.role,
    content: m.content,
  }));
  const stepEvents = getOnboardingStepEvents(ownerId).map((e) => ({
    kind: "step" as const,
    createdAt: e.createdAt,
    step: e.step,
    event: e.event,
  }));
  const timeline = [...messages, ...stepEvents].sort((a, b) => a.createdAt - b.createdAt);

  res.json({ ownerId, timeline });
});
