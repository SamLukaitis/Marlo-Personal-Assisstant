import { Router } from "express";
import crypto from "node:crypto";
import { addPhoneNumberForUser } from "../db/store.js";
import { simulatedPhoneForOwner } from "../providers/whatsapp.js";
import { handleIncoming } from "./whatsappRoutes.js";
import type { AuthedRequest } from "../middleware/auth.js";

// Backs the in-app WhatsApp Simulator page (client/src/pages/WhatsAppSimPage.tsx) — lets Sam/Jake
// exercise the real inbound-message pipeline (registration, debounced batching, choice buttons,
// link/media handling) from a browser instead of a real phone. Only mounted when
// ENABLE_WHATSAPP_SIMULATOR is set (see index.ts) and always behind requireAdmin.
export const whatsappSimRoutes = Router();

// Fire-and-forget, same shape as the real webhook handler (whatsappRoutes.ts) — the assistant
// reply is debounced (services/messageBatching.ts) so it isn't ready by the time this returns.
// The client picks it up by polling GET /api/admin/messages (adminRoutes.ts), which already reads
// the same whatsapp_messages history a real WhatsApp reply would land in.
whatsappSimRoutes.post("/whatsapp-sim/send", (req, res) => {
  const ownerId = (req as unknown as AuthedRequest).userId;
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text) {
    res.status(400).json({ error: "text is required" });
    return;
  }

  const phone = simulatedPhoneForOwner(ownerId);
  addPhoneNumberForUser(ownerId, phone); // idempotent — binds the reserved sim number on first use

  handleIncoming({
    kind: "text",
    from: phone,
    text,
    messageId: `sim-${crypto.randomUUID()}`,
  }).catch((err) => console.error("whatsapp-sim: handleIncoming failed", err));

  res.status(202).json({ phone });
});
