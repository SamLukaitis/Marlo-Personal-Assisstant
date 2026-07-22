import { Router } from "express";
import {
  getGoogleAuthUrl,
  handleGoogleCallback,
  isGoogleConfigured,
} from "../providers/google.js";
import {
  getMicrosoftAuthUrl,
  handleMicrosoftCallback,
  isMicrosoftConfigured,
} from "../providers/microsoft.js";

export const authRoutes = Router();

const CLIENT_URL = process.env.CLIENT_URL ?? "http://localhost:5173";

authRoutes.get("/auth/google/login", (_req, res) => {
  if (!isGoogleConfigured()) {
    res.redirect(`${CLIENT_URL}/setup?error=google_not_configured`);
    return;
  }
  res.redirect(getGoogleAuthUrl());
});

authRoutes.get("/auth/google/callback", async (req, res) => {
  const code = req.query.code as string | undefined;
  if (!code) {
    res.redirect(`${CLIENT_URL}/setup?error=missing_code`);
    return;
  }
  try {
    const account = await handleGoogleCallback(code);
    res.redirect(`${CLIENT_URL}/setup?connected=${encodeURIComponent(account.email)}`);
  } catch (err) {
    console.error("Google OAuth callback failed", err);
    res.redirect(`${CLIENT_URL}/setup?error=oauth_failed`);
  }
});

authRoutes.get("/auth/microsoft/login", (_req, res) => {
  if (!isMicrosoftConfigured()) {
    res.redirect(`${CLIENT_URL}/setup?error=microsoft_not_configured`);
    return;
  }
  res.redirect(getMicrosoftAuthUrl());
});

authRoutes.get("/auth/microsoft/callback", async (req, res) => {
  const code = req.query.code as string | undefined;
  if (!code) {
    res.redirect(`${CLIENT_URL}/setup?error=missing_code`);
    return;
  }
  try {
    const account = await handleMicrosoftCallback(code);
    res.redirect(`${CLIENT_URL}/setup?connected=${encodeURIComponent(account.email)}`);
  } catch (err) {
    console.error("Microsoft OAuth callback failed", err);
    res.redirect(`${CLIENT_URL}/setup?error=oauth_failed`);
  }
});
