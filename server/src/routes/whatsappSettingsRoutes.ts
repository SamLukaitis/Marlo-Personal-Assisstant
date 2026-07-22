import { Router } from "express";
import {
  isWhatsAppConfigured,
  isWhatsAppSignatureConfigured,
} from "../providers/whatsapp.js";
import { getWhatsAppAllowedNumbers, setWhatsAppAllowedNumbers } from "../db/store.js";

export const whatsappSettingsRoutes = Router();

whatsappSettingsRoutes.get("/api/whatsapp/status", (_req, res) => {
  res.json({
    configured: isWhatsAppConfigured(),
    signatureConfigured: isWhatsAppSignatureConfigured(),
  });
});

whatsappSettingsRoutes.get("/api/whatsapp/allowed-numbers", (_req, res) => {
  res.json(getWhatsAppAllowedNumbers());
});

whatsappSettingsRoutes.put("/api/whatsapp/allowed-numbers", (req, res) => {
  const numbers = req.body?.numbers;
  if (!Array.isArray(numbers) || !numbers.every((n) => typeof n === "string")) {
    res.status(400).json({ error: "numbers must be an array of strings" });
    return;
  }
  setWhatsAppAllowedNumbers(numbers);
  res.json({ ok: true });
});
