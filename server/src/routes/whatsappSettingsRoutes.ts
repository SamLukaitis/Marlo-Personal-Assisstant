import { Router } from "express";
import { isWhatsAppConfigured, isWhatsAppSignatureConfigured } from "../providers/whatsapp.js";
import {
  listPhoneNumbersForUser,
  addPhoneNumberForUser,
  removePhoneNumberForUser,
  normalizePhone,
} from "../db/store.js";
import type { AuthedRequest } from "../middleware/auth.js";

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
  const current = listPhoneNumbersForUser(ownerId);

  for (const row of current) {
    if (!desired.has(row.phone)) removePhoneNumberForUser(ownerId, row.id);
  }

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
  res.json({ ok: true });
});
