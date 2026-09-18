import { Router } from "express";
import fs from "node:fs";
import {
  isAdmin,
  listInvitedPhones,
  addInvitedPhone,
  removeInvitedPhone,
  resolveOwnerByPhone,
  clearReplayPark,
  listReplayParkedPhonesForUser,
  deleteUserCompletely,
  deletePendingRegistration,
  normalizePhone,
  findRemainingOwnerReferences,
  listPhoneNumbersForUser,
  resetOnboardingConnectionState,
  getWhatsAppHistory,
  getOnboardingStepEvents,
  listWaitlistRequests,
  isOnWaitlist,
  removeWaitlistRequest,
} from "../db/store.js";
import { sendProactiveMessage } from "../services/outbound.js";
import { MARLOWE_WAITLIST_APPROVED_TEXT } from "../services/whatsappRegistration.js";
import type { AuthedRequest } from "../middleware/auth.js";
import { internationalPhoneError } from "../services/phoneFormat.js";

export const adminRoutes = Router();

// Defense in depth: the client hides the Admin settings section for non-admins, but every route
// here re-checks isAdmin itself — the same pattern assistant.ts uses for tool gating. A
// crafted request from a signed-in non-admin must still get a 403, not just a hidden button.
//
// Gated on isAdmin, not isAppOwner: anyone promoted via the Portal's Admins tab runs the beta
// alongside the owner, so they need the same invite/reset/replay/viewer tools. isAppOwner stays
// what it always was — the single APP_OWNER_EMAIL account that /api/checkin's phone automation
// resolves to — it just no longer gates this router.
//
// Invite-only access is gated by phone number, not email — send a tester the WhatsApp number to
// message and add their number here; no need to collect their email in advance (see
// isPhoneInvited/addInvitedPhone in db/store.ts).
adminRoutes.get("/api/admin/invites", (req, res) => {
  if (!isAdmin((req as unknown as AuthedRequest).userId)) {
    res.status(403).json({ error: "not allowed" });
    return;
  }
  res.json(listInvitedPhones());
});

// Reports what Express actually made of the proxy headers on this very request, so the number of
// proxy hops to trust (config.ts's configureTrustProxy / TRUST_PROXY_HOPS) can be read off a real
// deployment instead of assumed. `rateLimitKey` is the address per-visitor limits key on
// (helpChatRoutes.ts): if it isn't your own public IP, count from the right of `chain` to find the
// entry that is — that position is the hop count to set. Admin-only: the forwarded chain is
// infrastructure detail, not something to expose publicly.
adminRoutes.get("/api/admin/ip-check", (req, res) => {
  if (!isAdmin((req as unknown as AuthedRequest).userId)) {
    res.status(403).json({ error: "not allowed" });
    return;
  }
  const forwardedFor = req.headers["x-forwarded-for"];
  const chain = (Array.isArray(forwardedFor) ? forwardedFor.join(",") : forwardedFor ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  res.json({
    rateLimitKey: req.ip,
    chain,
    forwardedFor: Array.isArray(forwardedFor) ? forwardedFor.join(", ") : forwardedFor ?? null,
    socketAddress: req.socket.remoteAddress ?? null,
    trustedHops: Number(req.app.get("trust proxy")) || 0,
  });
});

adminRoutes.post("/api/admin/invites", (req, res) => {
  if (!isAdmin((req as unknown as AuthedRequest).userId)) {
    res.status(403).json({ error: "not allowed" });
    return;
  }
  const phone = typeof req.body?.phone === "string" ? normalizePhone(req.body.phone) : "";
  // A number invited in national format can never match the E.164 `from` WhatsApp delivers, so the
  // tester is just told they aren't invited — see services/phoneFormat.ts for the full shape of
  // that failure. The same check now guards the Settings binding route, which lacked it and let a
  // real account store an unmatchable number.
  const formatError = internationalPhoneError(phone);
  if (formatError) {
    res.status(400).json({ error: formatError });
    return;
  }
  addInvitedPhone(phone);

  // Makes good on the promise in MARLOWE_WAITLIST_TEXT ("we'll message you here as soon as you
  // can get started"). Only for numbers that actually asked — inviting someone who never messaged
  // shouldn't cold-message them out of nowhere. Sent via sendProactiveMessage so it still lands
  // when their 24h customer-service window has closed, which it usually will have (see
  // services/outbound.ts). Best-effort and deliberately not awaited into the response: a Meta
  // hiccup must not make the invite itself look like it failed, since the row is already written.
  // try/catch as well as .catch(): a synchronous throw here (a misconfigured WhatsApp client,
  // say) would otherwise 500 a request whose invite row is already committed, telling the admin
  // the invite failed when it didn't.
  if (isOnWaitlist(phone)) {
    removeWaitlistRequest(phone);
    try {
      void Promise.resolve(
        sendProactiveMessage(phone, MARLOWE_WAITLIST_APPROVED_TEXT, "alert")
      ).catch((err) => console.error("admin: waitlist approval message failed", { phone }, err));
    } catch (err) {
      console.error("admin: waitlist approval message failed", { phone }, err);
    }
  }

  res.json(listInvitedPhones());
});

// The Waitlist section in Settings — every uninvited number that has messaged Marlowe, newest
// request first. Read-only here; approving is just POST /api/admin/invites above, which clears
// the entry and notifies them.
adminRoutes.get("/api/admin/waitlist", (req, res) => {
  if (!isAdmin((req as unknown as AuthedRequest).userId)) {
    res.status(403).json({ error: "not allowed" });
    return;
  }
  res.json(listWaitlistRequests());
});

// Dismiss without inviting — for spam and wrong numbers. Silent: the number is told nothing, and
// nothing stops them messaging again (which would simply re-add them to the list).
adminRoutes.delete("/api/admin/waitlist/:phone", (req, res) => {
  if (!isAdmin((req as unknown as AuthedRequest).userId)) {
    res.status(403).json({ error: "not allowed" });
    return;
  }
  removeWaitlistRequest(req.params.phone);
  res.json(listWaitlistRequests());
});

adminRoutes.delete("/api/admin/invites/:phone", (req, res) => {
  if (!isAdmin((req as unknown as AuthedRequest).userId)) {
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
// Irreversible, so the client puts a confirm() in front of it — and like the rest of this router
// it's admin-only, the same trust level the Portal already grants (admins can promote/demote
// each other there).
adminRoutes.post("/api/admin/reset-test-phone", (req, res) => {
  if (!isAdmin((req as unknown as AuthedRequest).userId)) {
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
  // Replay-onboarding leaves the number unbound but remembers which account it came from, so the
  // next registration is handed back to that account rather than creating a second one (see
  // resetOnboardingConnectionState). This endpoint's whole promise is that the same number can go
  // through signup from a clean slate, which that marker would quietly break — so drop it.
  //
  // Deliberately does NOT wipe the account the marker points at: that is a live account mid-replay
  // whose data replay exists to preserve, and following the marker here would make this a one-tap
  // wipe of the operator's own hub. An earlier version refused the whole request with a 409
  // instead, which removed the only escape hatch from a number nothing else could unstick.
  const clearedReplayPark = clearReplayPark(phone);
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

  res.json({ ok: true, hadAccount: ownerId !== null, clearedReplayPark });
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
  if (!isAdmin(userId)) {
    res.status(403).json({ error: "not allowed" });
    return;
  }
  // Includes numbers already unbound by an EARLIER replay: the live rows are gone by then, so
  // going by listPhoneNumbersForUser alone would clear nothing on a second replay and leave the
  // half-finished pending_whatsapp_registrations row behind — the next WhatsApp message would
  // resume mid-flow ("what's your email address?") instead of starting over, which reads as replay
  // having done nothing at all.
  const phones = [
    ...new Set([...listPhoneNumbersForUser(userId).map((p) => p.phone), ...listReplayParkedPhonesForUser(userId)]),
  ];
  for (const phone of phones) {
    deletePendingRegistration(phone);
  }
  resetOnboardingConnectionState(userId);
  res.json({ ok: true, unboundPhones: phones });
});

// The conversation viewer for watching a test user's onboarding/chat play out instead of guessing
// from server logs — merges the raw WhatsApp history (getWhatsAppHistory) with that owner's
// onboarding_step_events log (see db/store.ts) into one chronological timeline, so a "reached
// ask_briefing" marker sits right where it actually happened relative to the messages around it.
// 200 messages is generous for a test conversation without being an unbounded query.
adminRoutes.get("/api/admin/messages", (req, res) => {
  if (!isAdmin((req as unknown as AuthedRequest).userId)) {
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
