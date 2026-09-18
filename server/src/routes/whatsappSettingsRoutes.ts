import { Router } from "express";
import { isWhatsAppConfigured, isWhatsAppSignatureConfigured } from "../providers/whatsapp.js";
import {
  listPhoneNumbersForUser,
  addPhoneNumberForUser,
  removePhoneNumberForUser,
  normalizePhone,
} from "../db/store.js";
import type { AuthedRequest } from "../middleware/auth.js";
import { internationalPhoneError } from "../services/phoneFormat.js";

export const whatsappSettingsRoutes = Router();

whatsappSettingsRoutes.get("/api/whatsapp/status", (_req, res) => {
  res.json({
    configured: isWhatsAppConfigured(),
    signatureConfigured: isWhatsAppSignatureConfigured(),
  });
});

whatsappSettingsRoutes.get("/api/whatsapp/allowed-numbers", (req, res) => {
  const ownerId = (req as unknown as AuthedRequest).userId;
  res.json(listPhoneNumbersForUser(ownerId).map((r) => r.phone));
});

// Replace-the-whole-list semantics, same as the old global-setting version — backed by
// user_phone_numbers now instead of one shared allow-list, so a number registered to a
// different user is rejected (addPhoneNumberForUser throws) rather than silently reassigned.
//
// Capped at one number per account (server-side, independent of whatever the client sends) —
// every number on this list receives every proactive alert for the account, not just the ones
// the owner meant to keep using, and there's no separate "can message this account" vs. "gets my
// private alerts" distinction. A stale old number left on the list after switching to a new one,
// or a second person's number added for shared testing, both silently keep receiving the
// account's alerts indefinitely — a real incident, not a hypothetical one.
whatsappSettingsRoutes.put("/api/whatsapp/allowed-numbers", (req, res) => {
  const numbers = req.body?.numbers;
  if (!Array.isArray(numbers) || !numbers.every((n) => typeof n === "string")) {
    res.status(400).json({ error: "numbers must be an array of strings" });
    return;
  }
  if (numbers.length > 1) {
    res.status(400).json({ error: "Only one WhatsApp number is supported per account right now." });
    return;
  }

  const ownerId = (req as unknown as AuthedRequest).userId;
  const desired = new Set(numbers.map(normalizePhone).filter(Boolean));

  // The same guard the invite route has always had, which this route never got. Without it a
  // number typed in national format ("07597959648") was stored verbatim and could never equal the
  // E.164 `from` WhatsApp delivers ("447597959648") — so the owner's own messages fell through to
  // registration and minted a second, phone-only account beside the binding they had just made.
  // That is exactly how one account here ended up split. See services/phoneFormat.ts.
  for (const phone of desired) {
    const formatError = internationalPhoneError(phone);
    if (formatError) {
      res.status(400).json({ error: formatError });
      return;
    }
  }

  // Bind first, unbind second. The other order left a rejected save having already deleted the
  // number the account was using: addPhoneNumberForUser throws for a number registered to someone
  // else, and by then the current row was gone — a 409 on screen and an account with no number at
  // all, which is worse than the change simply not happening.
  const errors: string[] = [];
  for (const phone of desired) {
    try {
      addPhoneNumberForUser(ownerId, phone);
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  if (errors.length) {
    res.status(409).json({ error: errors.join("; ") });
    return;
  }

  for (const row of listPhoneNumbersForUser(ownerId)) {
    if (!desired.has(row.phone)) removePhoneNumberForUser(ownerId, row.id);
  }
  res.json({ ok: true });
});
