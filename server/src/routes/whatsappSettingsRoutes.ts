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
whatsappSettingsRoutes.put("/api/whatsapp/allowed-numbers", (req, res) => {
  const numbers = req.body?.numbers;
  if (!Array.isArray(numbers) || !numbers.every((n) => typeof n === "string")) {
    res.status(400).json({ error: "numbers must be an array of strings" });
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
