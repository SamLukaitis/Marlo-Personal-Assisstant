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
// transcript offered. Optional { phone } picks a test user; omitted means the caller's own number.
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
  if (!text && !buttonId) {
    res.status(400).json({ error: "text is required" });
    return;
  }

  // Idempotent — binds the caller's own sim number on first use. Test users are deliberately
  // left unbound: registration binds them to a fresh account of their own.
  if (target.self) addPhoneNumberForUser(ownerId, phone);

  const messageId = `sim-${crypto.randomUUID()}`;
  let message: IncomingWhatsAppMessage;
  if (buttonId) {
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
