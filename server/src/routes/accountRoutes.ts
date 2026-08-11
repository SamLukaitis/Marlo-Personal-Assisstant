import { Router } from "express";
import { listAccounts, deleteAccount } from "../db/store.js";
import { isGoogleConfigured } from "../providers/google.js";
import { isMicrosoftConfigured } from "../providers/microsoft.js";
import type { AuthedRequest } from "../middleware/auth.js";

export const accountRoutes = Router();

accountRoutes.get("/api/providers", (_req, res) => {
  res.json([
    {
      provider: "google",
      label: "Google (Gmail, Calendar, Drive)",
      configured: isGoogleConfigured(),
      loginPath: "/auth/google/login",
    },
    {
      provider: "microsoft",
      label: "Microsoft 365 (Outlook mail, Calendar, Teams chat, OneDrive)",
      configured: isMicrosoftConfigured(),
      loginPath: "/auth/microsoft/login",
    },
  ]);
});

accountRoutes.get("/api/accounts", (req, res) => {
  res.json(
    listAccounts((req as unknown as AuthedRequest).userId).map((a) => ({
      id: a.id,
      provider: a.provider,
      email: a.email,
      authBroken: a.authBroken,
      authBrokenAt: a.authBrokenAt,
    }))
  );
});

accountRoutes.delete("/api/accounts/:id", (req, res) => {
  deleteAccount((req as unknown as AuthedRequest).userId, Number(req.params.id));
  res.json({ ok: true });
});
