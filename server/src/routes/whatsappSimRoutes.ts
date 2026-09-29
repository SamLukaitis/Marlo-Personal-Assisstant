import { Router, type Request, type Response } from "express";
import crypto from "node:crypto";
import {
  addInvitedPhone,
  addPhoneNumberForUser,
  isPhoneInvited,
  listInvitedPhones,
  normalizePhone,
  removeInvitedPhone,
  resolveOwnerByPhone,
} from "../db/store.js";
import {
  isSimulatedTestUserPhone,
  newSimulatedTestUserPhone,
  simulatedPhoneForOwner,
  type IncomingWhatsAppMessage,
} from "../providers/whatsapp.js";
import { clearSimTranscript, getSimTranscript, recordSimMessage } from "../providers/whatsappSimTranscript.js";
import { resetTestPhone, TestPhoneResetError } from "../services/testPhoneReset.js";
import { composeDailyBriefingMessage } from "../services/scheduler.js";
import { sendProactiveMessage } from "../services/outbound.js";
import { handleIncoming } from "./whatsappRoutes.js";
import type { AuthedRequest } from "../middleware/auth.js";

// Backs the in-app WhatsApp Simulator page (client/src/pages/WhatsAppSimPage.tsx) — lets Sam/Jake
// exercise the real inbound-message pipeline (registration, debounced batching, choice buttons,
// link/media handling) from a browser instead of a real phone. Only mounted when
// ENABLE_WHATSAPP_SIMULATOR is set (see index.ts) and always behind requireAdmin.
//
// Two kinds of simulated number (see providers/whatsapp.ts):
// - the caller's own, 999000<ownerId> — "chat as me", bound to the caller's real account so
//   features can be tried against real data;
// - throwaway test users, 999100xxxxxx — invited but never bound here, so their first message
//   goes through the real signup flow and nothing they do touches the caller's account.
export const whatsappSimRoutes = Router();

type ResolvedPhone = { ok: true; phone: string; self: boolean } | { ok: false; status: number; error: string };

// The only numbers the simulator may drive: the caller's own sim number (the default), or a test
// user this simulator created and hasn't deleted. Anything else — a real number, another admin's
// sim number — is refused, so the simulator can never impersonate a real conversation.
function resolveSimPhone(req: Request, raw: unknown): ResolvedPhone {
  const ownerId = (req as unknown as AuthedRequest).userId;
  const own = simulatedPhoneForOwner(ownerId);
  const phone = typeof raw === "string" && raw.trim() ? normalizePhone(raw) : own;
  if (phone === own) return { ok: true, phone, self: true };
  if (!isSimulatedTestUserPhone(phone)) {
    return { ok: false, status: 400, error: "not a simulator number" };
  }
  if (!isPhoneInvited(phone)) {
    return { ok: false, status: 404, error: "no such test user — create a new one" };
  }
  return { ok: true, phone, self: false };
}

function refuse(res: Response, r: Extract<ResolvedPhone, { ok: false }>): void {
  res.status(r.status).json({ error: r.error });
}

// Fire-and-forget, same shape as the real webhook handler (whatsappRoutes.ts) — the assistant
// reply is debounced (services/messageBatching.ts) so it isn't ready by the time this returns.
// The client picks it up by polling GET /whatsapp-sim/transcript, which the send functions in
// providers/whatsapp.ts write to for every simulated number.
//
// Body: { text } to type a message, or { buttonId, label } to tap a reply button / list row the
// transcript offered, or { latitude, longitude } to share a location pin (the answer to a "Send
// location" request). Optional { phone } picks a test user; omitted means the caller's own number.
whatsappSimRoutes.post("/whatsapp-sim/send", (req, res) => {
  const ownerId = (req as unknown as AuthedRequest).userId;
  const target = resolveSimPhone(req, req.body?.phone);
  if (!target.ok) {
    refuse(res, target);
    return;
  }
  const { phone } = target;

  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  const buttonId = typeof req.body?.buttonId === "string" ? req.body.buttonId.trim() : "";
  const latitude = req.body?.latitude;
  const longitude = req.body?.longitude;
  const isLocation = latitude !== undefined || longitude !== undefined;
  if (
    isLocation &&
    !(
      typeof latitude === "number" &&
      typeof longitude === "number" &&
      Math.abs(latitude) <= 90 &&
      Math.abs(longitude) <= 180
    )
  ) {
    res.status(400).json({ error: "latitude and longitude must both be valid numbers" });
    return;
  }
  if (!text && !buttonId && !isLocation) {
    res.status(400).json({ error: "text is required" });
    return;
  }

  // Idempotent — binds the caller's own sim number on first use. Test users are deliberately
  // left unbound: registration binds them to a fresh account of their own.
  if (target.self) addPhoneNumberForUser(ownerId, phone);

  const messageId = `sim-${crypto.randomUUID()}`;
  let message: IncomingWhatsAppMessage;
  if (isLocation) {
    recordSimMessage(phone, { role: "user", text: `[shared location ${latitude}, ${longitude}]` });
    message = { kind: "location", from: phone, messageId, latitude, longitude };
  } else if (buttonId) {
    const label = typeof req.body?.label === "string" && req.body.label.trim() ? req.body.label.trim() : buttonId;
    recordSimMessage(phone, { role: "user", text: `[tapped ${label}]` });
    message = { kind: "interactive", from: phone, messageId, buttonId };
  } else {
    recordSimMessage(phone, { role: "user", text });
    message = { kind: "text", from: phone, text, messageId };
  }

  handleIncoming(message).catch((err) => console.error("whatsapp-sim: handleIncoming failed", err));

  res.status(202).json({ phone });
});

// Sends the daily briefing to the simulated number on demand, composed exactly as the scheduled
// 07:30 send composes it (scheduler.ts's composeDailyBriefingMessage — Schengen line and all) and
// delivered down the same proactive path (outbound.ts's "digest" kind), so what lands in the
// transcript is what a real user would receive. Rebuilt from scratch on every press rather than
// reusing today's stored briefing: this is for iterating on the briefing's content and style, so
// each press must be a fresh snapshot of right now.
//
// Deliberately skips the scheduler's own gates — the `proactive` setting, the once-a-day stamp,
// and proactiveDelivery.ts's per-number dedup — because those govern *when* the briefing fires,
// which isn't what this button is for. It also only ever sends to the one simulated number, never
// to the account's real ones.
//
// Awaited rather than fire-and-forget like /send: the build is a single LLM call, and a failure in
// it (a missing API key, a dead provider) is exactly what the caller needs to see.
whatsappSimRoutes.post("/whatsapp-sim/briefing", async (req, res) => {
  const callerId = (req as unknown as AuthedRequest).userId;
  const target = resolveSimPhone(req, req.body?.phone);
  if (!target.ok) {
    refuse(res, target);
    return;
  }
  const { phone } = target;

  // Same idempotent binding as /send — the caller's own sim number may not be bound yet, and the
  // proactive path resolves the number back to an account to record the send in chat history.
  if (target.self) addPhoneNumberForUser(callerId, phone);
  // A test user has no briefing to build until its first message has run the signup flow.
  const ownerId = target.self ? callerId : resolveOwnerByPhone(phone);
  if (ownerId === null) {
    res.status(409).json({ error: "this test user hasn't signed up yet — send it a message first" });
    return;
  }

  try {
    await sendProactiveMessage(phone, await composeDailyBriefingMessage(ownerId, true), "digest");
    res.json({ ok: true });
  } catch (err) {
    console.error("whatsapp-sim: briefing send failed", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

whatsappSimRoutes.get("/whatsapp-sim/transcript", (req, res) => {
  const target = resolveSimPhone(req, req.query.phone);
  if (!target.ok) {
    refuse(res, target);
    return;
  }
  res.json({ phone: target.phone, entries: getSimTranscript(target.phone) });
});

// Test users are shared between admins (the invite list is global), which is fine for a two-person
// staging tool and means either of you can pick up a conversation the other started.
whatsappSimRoutes.get("/whatsapp-sim/test-users", (_req, res) => {
  res.json(
    listInvitedPhones()
      .filter((row) => isSimulatedTestUserPhone(row.phone))
      .map((row) => ({
        phone: row.phone,
        createdAt: row.invitedAt,
        hasAccount: resolveOwnerByPhone(row.phone) !== null,
      }))
  );
});

whatsappSimRoutes.post("/whatsapp-sim/test-users", (_req, res) => {
  let phone = newSimulatedTestUserPhone();
  // A million numbers makes a clash unlikely, not impossible — never hand out one still in use.
  while (isPhoneInvited(phone) || resolveOwnerByPhone(phone) !== null) phone = newSimulatedTestUserPhone();
  addInvitedPhone(phone);
  res.status(201).json({ phone });
});

whatsappSimRoutes.delete("/whatsapp-sim/test-users/:phone", (req, res) => {
  const phone = normalizePhone(req.params.phone);
  if (!isSimulatedTestUserPhone(phone)) {
    res.status(400).json({ error: "not a simulator test user" });
    return;
  }
  try {
    const { hadAccount } = resetTestPhone(phone);
    removeInvitedPhone(phone);
    clearSimTranscript(phone);
    res.json({ ok: true, hadAccount });
  } catch (err) {
    const offenders = err instanceof TestPhoneResetError ? err.offenders : [];
    console.error("whatsapp-sim: delete test user failed", err, { offenders });
    res.status(500).json({
      error: (err as Error).message,
      ...(offenders.length > 0 ? { offenders } : {}),
    });
  }
});
