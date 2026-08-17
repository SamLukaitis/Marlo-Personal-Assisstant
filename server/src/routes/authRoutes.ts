import { Router, type Response } from "express";
import crypto from "node:crypto";
import {
  getGoogleAuthUrl,
  exchangeGoogleCode,
  handleGoogleCallback,
  isGoogleConfigured,
} from "../providers/google.js";
import {
  getMicrosoftAuthUrl,
  exchangeMicrosoftCode,
  handleMicrosoftCallback,
  isMicrosoftConfigured,
} from "../providers/microsoft.js";
import {
  isEmailInvited,
  findOrCreateUserByEmail,
  createSession,
  deleteSession,
  listAccounts,
  upsertAccount,
} from "../db/store.js";
import { requireAuth, SESSION_COOKIE_NAME, type AuthedRequest } from "../middleware/auth.js";

export const authRoutes = Router();

authRoutes.post("/auth/logout", (req, res) => {
  const raw = req.cookies?.[SESSION_COOKIE_NAME] as string | undefined;
  if (raw) deleteSession(raw);
  res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
  res.json({ ok: true });
});

const CLIENT_URL = process.env.CLIENT_URL ?? "http://localhost:5173";
const NONCE_COOKIE = "oauth_nonce";
const isProd = process.env.NODE_ENV === "production";
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, matches store.ts's session TTL

// Two very different things share this OAuth flow: "log into the app" (identity — who's
// browsing) and "connect a data source" (attach a Gmail/Outlook mailbox the assistant can read,
// independent of who's logged in). A `state` param carries which one this round trip is, plus a
// nonce checked against a short-lived cookie set right before redirecting — the standard
// CSRF-safe OAuth `state` pattern, not a new crypto scheme.
//
// `returnTo` carries where a "connect" round trip started, so finishing it lands back where the
// user was — specifically, connecting an account from mid-onboarding must not eject them into
// the main app before they've picked their tools/briefing. Only meaningful for intent "connect";
// "login" always decides its own destination (see the login-intent branch of each callback).
interface OAuthState {
  intent: "login" | "connect";
  ownerId?: number;
  returnTo?: "onboarding" | "settings";
  nonce: string;
}

function buildState(
  intent: "login" | "connect",
  ownerId?: number,
  returnTo?: "onboarding" | "settings"
): { state: string; nonce: string } {
  const nonce = crypto.randomBytes(16).toString("hex");
  const payload: OAuthState = { intent, ownerId, returnTo, nonce };
  return { state: Buffer.from(JSON.stringify(payload)).toString("base64url"), nonce };
}

function parseState(raw: string | undefined): OAuthState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (parsed && (parsed.intent === "login" || parsed.intent === "connect") && typeof parsed.nonce === "string") {
      return parsed as OAuthState;
    }
    return null;
  } catch {
    return null;
  }
}

// Where a "connect" callback sends the browser once the account is saved — mirrors whichever
// page's Connect button the user actually clicked, not always Settings.
function connectReturnPath(state: OAuthState): string {
  return state.returnTo === "onboarding" ? "/onboarding" : "/settings";
}

function setNonceCookie(res: Response, nonce: string): void {
  res.cookie(NONCE_COOKIE, nonce, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    maxAge: 5 * 60 * 1000, // 5 minutes — just long enough for the OAuth round trip
    path: "/auth",
  });
}

function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    maxAge: SESSION_MAX_AGE_MS,
    path: "/",
  });
}

// --- "Log into the app" — unauthenticated, invite-gated identity flow ---

authRoutes.get("/auth/google/login-signin", (_req, res) => {
  if (!isGoogleConfigured()) {
    res.redirect(`${CLIENT_URL}/?error=google_not_configured`);
    return;
  }
  const { state, nonce } = buildState("login");
  setNonceCookie(res, nonce);
  res.redirect(getGoogleAuthUrl(state));
});

authRoutes.get("/auth/microsoft/login-signin", (_req, res) => {
  if (!isMicrosoftConfigured()) {
    res.redirect(`${CLIENT_URL}/?error=microsoft_not_configured`);
    return;
  }
  const { state, nonce } = buildState("login");
  setNonceCookie(res, nonce);
  res.redirect(getMicrosoftAuthUrl(state));
});

// --- "Connect a data source" — requires an existing session, attaches a mail/calendar account ---

// The Connect button on OnboardingPage.tsx links here with ?from=onboarding; the one on
// SettingsPage.tsx links here with no query param at all, which defaults to "settings" below.
function returnToFromQuery(req: { query: Record<string, unknown> }): "onboarding" | "settings" {
  return req.query.from === "onboarding" ? "onboarding" : "settings";
}

authRoutes.get("/auth/google/login", requireAuth, (req, res) => {
  const returnTo = returnToFromQuery(req);
  if (!isGoogleConfigured()) {
    res.redirect(`${CLIENT_URL}${returnTo === "onboarding" ? "/onboarding" : "/settings"}?error=google_not_configured`);
    return;
  }
  const { state, nonce } = buildState("connect", (req as unknown as AuthedRequest).userId, returnTo);
  setNonceCookie(res, nonce);
  res.redirect(getGoogleAuthUrl(state));
});

authRoutes.get("/auth/microsoft/login", requireAuth, (req, res) => {
  const returnTo = returnToFromQuery(req);
  if (!isMicrosoftConfigured()) {
    res.redirect(`${CLIENT_URL}${returnTo === "onboarding" ? "/onboarding" : "/settings"}?error=microsoft_not_configured`);
    return;
  }
  const { state, nonce } = buildState("connect", (req as unknown as AuthedRequest).userId, returnTo);
  setNonceCookie(res, nonce);
  res.redirect(getMicrosoftAuthUrl(state));
});

// --- Shared callbacks — one redirect URI per provider handles both intents, so Google/Microsoft
// only ever needed one callback URL registered, avoiding a second round of console setup ---

authRoutes.get("/auth/google/callback", async (req, res) => {
  const code = req.query.code as string | undefined;
  const cookieNonce = req.cookies?.[NONCE_COOKIE] as string | undefined;
  res.clearCookie(NONCE_COOKIE, { path: "/auth" });
  const state = parseState(req.query.state as string | undefined);

  if (!code || !state || !cookieNonce || state.nonce !== cookieNonce) {
    res.redirect(`${CLIENT_URL}/?error=oauth_failed`);
    return;
  }

  try {
    if (state.intent === "connect") {
      if (!state.ownerId) throw new Error("connect intent missing ownerId");
      const account = await handleGoogleCallback(code, state.ownerId);
      res.redirect(`${CLIENT_URL}${connectReturnPath(state)}?connected=${encodeURIComponent(account.email)}`);
      return;
    }

    const auth = await exchangeGoogleCode(code);
    if (!isEmailInvited(auth.email)) {
      res.redirect(`${CLIENT_URL}/?not_invited=1`);
      return;
    }
    const user = findOrCreateUserByEmail(auth.email);
    // Read BEFORE the auto-connect below — this is what decides onboarding vs. straight into the
    // app, and it must reflect what the user had connected walking in, not what signing in is
    // about to add. Otherwise a brand-new user's very first sign-in would immediately count as
    // "has an account" (from the auto-connect two lines down) and skip onboarding entirely.
    const hasAccounts = listAccounts(user.id).length > 0;
    // Signing in with Google already requested the same scopes "Connect" would (see SCOPES in
    // google.ts) — save these tokens as a connected account too, so a user isn't asked to
    // reconnect the exact provider they just authenticated with. Safe to run on every login:
    // upsertAccount is keyed on (owner, provider, email), so this just refreshes tokens (and
    // clears any stale "auth broken" flag) on repeat sign-ins rather than duplicating anything.
    upsertAccount(user.id, {
      provider: "google",
      email: auth.email,
      accessToken: auth.accessToken,
      refreshToken: auth.refreshToken,
      expiryDate: auth.expiryDate,
    });
    setSessionCookie(res, createSession(user.id));
    res.redirect(`${CLIENT_URL}${hasAccounts ? "/assistant" : "/onboarding"}`);
  } catch (err) {
    console.error("Google OAuth callback failed", err);
    res.redirect(`${state.intent === "connect" ? `${CLIENT_URL}${connectReturnPath(state)}` : CLIENT_URL}?error=oauth_failed`);
  }
});

authRoutes.get("/auth/microsoft/callback", async (req, res) => {
  const code = req.query.code as string | undefined;
  const cookieNonce = req.cookies?.[NONCE_COOKIE] as string | undefined;
  res.clearCookie(NONCE_COOKIE, { path: "/auth" });
  const state = parseState(req.query.state as string | undefined);

  if (!code || !state || !cookieNonce || state.nonce !== cookieNonce) {
    res.redirect(`${CLIENT_URL}/?error=oauth_failed`);
    return;
  }

  try {
    if (state.intent === "connect") {
      if (!state.ownerId) throw new Error("connect intent missing ownerId");
      const account = await handleMicrosoftCallback(code, state.ownerId);
      res.redirect(`${CLIENT_URL}${connectReturnPath(state)}?connected=${encodeURIComponent(account.email)}`);
      return;
    }

    const auth = await exchangeMicrosoftCode(code);
    if (!isEmailInvited(auth.email)) {
      res.redirect(`${CLIENT_URL}/?not_invited=1`);
      return;
    }
    const user = findOrCreateUserByEmail(auth.email);
    // Same ordering reasoning as the Google callback above.
    const hasAccounts = listAccounts(user.id).length > 0;
    upsertAccount(user.id, {
      provider: "microsoft",
      email: auth.email,
      accessToken: auth.accessToken,
      refreshToken: auth.refreshToken,
      expiryDate: auth.expiryDate,
    });
    setSessionCookie(res, createSession(user.id));
    res.redirect(`${CLIENT_URL}${hasAccounts ? "/assistant" : "/onboarding"}`);
  } catch (err) {
    console.error("Microsoft OAuth callback failed", err);
    res.redirect(`${state.intent === "connect" ? `${CLIENT_URL}${connectReturnPath(state)}` : CLIENT_URL}?error=oauth_failed`);
  }
});
