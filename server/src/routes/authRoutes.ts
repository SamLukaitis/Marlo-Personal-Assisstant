import { Router, type Request, type Response } from "express";
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
  isMicrosoftConfigured,
  microsoftGetGraphUserId,
  microsoftIdentitySubject,
  type ExchangedMicrosoftAuth,
} from "../providers/microsoft.js";
import {
  isPhoneInvited,
  findOrCreateUserByEmail,
  getUserByEmail,
  getUser,
  setUserEmail,
  resolveOwnerByPhone,
  getReplayParkedOwner,
  createSession,
  deleteSession,
  getUserIdBySessionToken,
  listAccounts,
  upsertAccount,
  completePendingRegistration,
  consumePendingRegistrationToken,
  peekPendingRegistrationByToken,
  addPhoneNumberForUser,
  getUserIdByIdentity,
  linkIdentity,
  hasIdentity,
  type UserRow,
} from "../db/store.js";
import { isSimulatedPhone } from "../providers/whatsapp.js";
import { sendScriptedText } from "../services/whatsappReply.js";
import { clearConnectLinkCooldown } from "../services/connectMailboxLink.js";
import { sendFirstValueAndBriefingPrompt } from "../services/whatsappRegistration.js";
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
  intent: "login" | "connect" | "whatsapp_register";
  ownerId?: number;
  returnTo?: "onboarding" | "settings";
  registrationToken?: string;
  nonce: string;
}

function buildState(
  intent: "login" | "connect" | "whatsapp_register",
  ownerId?: number,
  returnTo?: "onboarding" | "settings",
  registrationToken?: string
): { state: string; nonce: string } {
  const nonce = crypto.randomBytes(16).toString("hex");
  const payload: OAuthState = { intent, ownerId, returnTo, registrationToken, nonce };
  return { state: Buffer.from(JSON.stringify(payload)).toString("base64url"), nonce };
}

function parseState(raw: string | undefined): OAuthState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      parsed &&
      (parsed.intent === "login" || parsed.intent === "connect" || parsed.intent === "whatsapp_register") &&
      typeof parsed.nonce === "string"
    ) {
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

// The state is unsigned JSON and any visitor can get a valid nonce cookie from the public
// login-signin routes, so state.ownerId alone proves nothing — an attacker could forge a connect
// state naming someone else's id and attach their own mailbox to that person's hub. The browser
// finishing a genuine connect still carries the session that started it (path "/", SameSite=Lax
// is sent on the top-level redirect back from the provider), so require it to match.
function connectOwnerFromSession(req: Request, state: OAuthState): number {
  const raw = req.cookies?.[SESSION_COOKIE_NAME] as string | undefined;
  const sessionUserId = raw ? getUserIdBySessionToken(raw) : null;
  if (!state.ownerId || sessionUserId === null || sessionUserId !== state.ownerId) {
    throw new Error("connect callback: session does not match the state's ownerId");
  }
  return sessionUserId;
}

// Which existing user (if any) a Microsoft sign-in belongs to. Graph's `mail` — which auth.email
// usually is — can be set to any address by the admin of any Entra tenant, so an email match alone
// proves nothing. A sign-in maps to a user only when:
//  - its tenant id + object id is already linked to that user, or
//  - a Microsoft account already stored on the user's hub (connected in an earlier, genuine OAuth
//    round trip) still resolves to the same Graph user — the one-time link for users who predate
//    user_identities. Must run BEFORE the new tokens are saved over that stored account.
// Returns "none" when no user has this email at all, "unverified" when one does but nothing ties
// this sign-in to them.
async function resolveMicrosoftUser(auth: ExchangedMicrosoftAuth): Promise<number | "none" | "unverified"> {
  const subject = microsoftIdentitySubject(auth);
  const linked = getUserIdByIdentity("microsoft", subject);
  if (linked !== null) return linked;

  const existing = getUserByEmail(auth.email);
  if (!existing) return "none";

  for (const account of listAccounts(existing.id, "microsoft")) {
    if ((await microsoftGetGraphUserId(account)) === auth.graphUserId) {
      linkIdentity(existing.id, "microsoft", subject);
      return existing.id;
    }
  }
  return "unverified";
}

function saveMicrosoftAccount(userId: number, auth: ExchangedMicrosoftAuth) {
  return upsertAccount(userId, {
    provider: "microsoft",
    email: auth.email,
    accessToken: auth.accessToken,
    refreshToken: auth.refreshToken,
    expiryDate: auth.expiryDate,
  });
}

// Google emails are verified, but a user row's email may have come from an unverified Microsoft
// `mail` (a WhatsApp registration via Outlook). Without this, someone could pre-create a user with
// your address that way, and your own later Google sign-in would land in their hub and connect your
// Gmail to it. A Google sign-in may use an existing user only if that user has no Microsoft identity,
// or has already connected this same Google account.
function googleMayUseExistingUser(userId: number, googleEmail: string): boolean {
  if (!hasIdentity(userId, "microsoft")) return true;
  const normalized = googleEmail.trim().toLowerCase();
  return listAccounts(userId, "google").some((a) => a.email.trim().toLowerCase() === normalized);
}

// Both OAuth callbacks need the same three-way decision once a registration completes, so it
// lives here rather than being written twice and drifting.
//
// The phone-first case is the new one: when this number already owns an account (created by
// declining email during onboarding), the address is attached to THAT row. Calling
// findOrCreateUserByEmail instead would quietly create a second account and strand every to-do,
// document and memory the person already has.
// Two very different refusals, told apart because the message each one deserves is different.
// "email_belongs_to_another_account" is what it says. "account_has_different_email" is the one
// that used to be reported as the first: the address is unclaimed, and the obstacle is that this
// number's own account already has one — which reads as nonsense if you're told your brand-new
// address belongs to someone else, and sends you looking for an account that doesn't exist.
export type RegistrationUserResult =
  | { kind: "ok"; userId: number }
  | { kind: "account_exists"; reason: "email_belongs_to_another_account" }
  | { kind: "account_exists"; reason: "account_has_different_email"; currentEmail: string };

export function resolveRegistrationUser(phone: string, email: string): RegistrationUserResult {
  const existingByEmail = getUserByEmail(email);
  // A number unbound by replay-onboarding counts as owned for this decision, exactly like a live
  // binding. Reading resolveOwnerByPhone alone was the hole that kept the original split bug alive
  // on this path: for a replayed PHONE-ONLY account (users.email still NULL, nothing for
  // getUserByEmail to find) the whole phone-first branch below was skipped, the fall-through
  // minted a brand-new account from the address, and the addPhoneNumberForUser that followed threw
  // "already registered to another account" — leaving an orphan account behind on every attempt
  // and no way to connect the mailbox. findOrCreateUserByPhone (the "No" tap) got this lookup when
  // parking was introduced; this path, the "Yes" tap, did not.
  const phoneOwnerId = resolveOwnerByPhone(phone) ?? getReplayParkedOwner(phone);

  if (phoneOwnerId !== null) {
    // Already the same account — nothing to attach, just proceed. (Also covers the "re-link the
    // same address" case: setUserEmail already wrote it, so this is a no-op, not a second write.)
    if (existingByEmail && existingByEmail.id === phoneOwnerId) {
      return { kind: "ok", userId: phoneOwnerId };
    }
    // Either the address belongs to somebody else, or the phone owner's row already has a
    // DIFFERENT address of its own (a Gmail-linked account later trying to link Outlook). Refuse
    // both rather than merge or overwrite: swapping the mailbox on an existing account isn't
    // supported, and silently moving identity half-way is worse than refusing — the old address
    // would stop resolving to this user (locking them out of web sign-in, and out of admin if
    // they're the app owner) with nothing on screen to explain why.
    const phoneOwner = getUser(phoneOwnerId);
    if (existingByEmail) {
      return { kind: "account_exists", reason: "email_belongs_to_another_account" };
    }
    if (phoneOwner?.email != null) {
      return {
        kind: "account_exists",
        reason: "account_has_different_email",
        currentEmail: phoneOwner.email,
      };
    }
    setUserEmail(phoneOwnerId, email);
    return { kind: "ok", userId: phoneOwnerId };
  }

  return { kind: "ok", userId: existingByEmail?.id ?? findOrCreateUserByEmail(email).id };
}

const ACCOUNT_EXISTS_WHATSAPP_TEXT =
  "That email already belongs to a Marlowe account I can't confirm is yours. Sign in on the website the way you did before, then add this number from Settings.";

// The other refusal: nobody holds the address they just connected — their own account simply
// already has one. Naming it is the whole point, since the generic message above had them hunting
// for an account that never existed.
function accountHasDifferentEmailText(currentEmail: string): string {
  return (
    `This number is already set up with *${currentEmail}*, and I can't swap that for a different ` +
    "address from here — it's what you sign in with on the website. To read a second mailbox as " +
    "well, sign in there and connect it from Settings."
  );
}

// Both WhatsApp-registration callbacks report a refusal the same way, so the wording stays in one
// place rather than being written three times and drifting.
function whatsappRefusalText(result: Extract<RegistrationUserResult, { kind: "account_exists" }>): string {
  return result.reason === "account_has_different_email"
    ? accountHasDifferentEmailText(result.currentEmail)
    : ACCOUNT_EXISTS_WHATSAPP_TEXT;
}

// A whatsapp_register callback that fails part-way redirects a browser tab, but the conversation
// it belongs to is on WhatsApp — and by the time most of these fire the one-time token has
// already been spent (consumePendingRegistrationToken runs before the code exchange), so the link
// they tapped is dead too. Without this the person is parked at awaiting_link_tap with no working
// link and nothing said. "resend" is the word handleAwaitingLinkTap listens for.
const REGISTRATION_RETRY_WHATSAPP_TEXT =
  "That didn't go through — tap the link again, or reply *resend* and I'll send you a fresh one.";

// The phone behind an in-flight registration callback, for the failure paths that need to say
// something and don't otherwise have it in hand. Peeks rather than consumes: on the paths that
// use it the token is either already spent or still wanted.
function registrationPhoneFromState(state: OAuthState | null): string | null {
  if (!state || state.intent !== "whatsapp_register" || !state.registrationToken) return null;
  return peekPendingRegistrationByToken(state.registrationToken)?.phone ?? null;
}

// Best-effort: a failed WhatsApp send must never turn one failure into two, and the browser has
// already been redirected by the time this runs.
function notifyRegistrationFailure(phone: string | null): void {
  if (!phone) return;
  // The message below tells them to reply "resend", so make sure that works: without this the
  // link issued moments ago is still inside the resend cooldown and their retry comes back as
  // "still working on it" — about an attempt that has already failed.
  clearConnectLinkCooldown(phone);
  sendScriptedText(phone, REGISTRATION_RETRY_WHATSAPP_TEXT).catch(() => {});
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

// --- "Register via WhatsApp" — unauthenticated, no session exists yet. Reached by tapping the
// magic link services/whatsappRegistration.ts sends over WhatsApp once someone mid-conversation
// has typed an invited email. The token (not a session or ownerId) is what authorizes this round
// trip — see store.ts's pending_whatsapp_registrations functions. ---

authRoutes.get("/auth/google/register", (req, res) => {
  const token = req.query.token as string | undefined;
  const reg = token ? peekPendingRegistrationByToken(token) : null;
  if (!reg) {
    res.redirect(`${CLIENT_URL}/connected?error=expired`);
    return;
  }
  if (!isGoogleConfigured()) {
    res.redirect(`${CLIENT_URL}/connected?error=google_not_configured`);
    return;
  }
  const { state, nonce } = buildState("whatsapp_register", undefined, undefined, token);
  setNonceCookie(res, nonce);
  res.redirect(getGoogleAuthUrl(state, reg.typedEmail ?? undefined));
});

authRoutes.get("/auth/microsoft/register", (req, res) => {
  const token = req.query.token as string | undefined;
  const reg = token ? peekPendingRegistrationByToken(token) : null;
  if (!reg) {
    res.redirect(`${CLIENT_URL}/connected?error=expired`);
    return;
  }
  if (!isMicrosoftConfigured()) {
    res.redirect(`${CLIENT_URL}/connected?error=microsoft_not_configured`);
    return;
  }
  const { state, nonce } = buildState("whatsapp_register", undefined, undefined, token);
  setNonceCookie(res, nonce);
  res.redirect(getMicrosoftAuthUrl(state, reg.typedEmail ?? undefined));
});

// --- Shared callbacks — one redirect URI per provider handles both intents, so Google/Microsoft
// only ever needed one callback URL registered, avoiding a second round of console setup ---

authRoutes.get("/auth/google/callback", async (req, res) => {
  const code = req.query.code as string | undefined;
  const cookieNonce = req.cookies?.[NONCE_COOKIE] as string | undefined;
  res.clearCookie(NONCE_COOKIE, { path: "/auth" });
  const state = parseState(req.query.state as string | undefined);

  if (!code || !state || !cookieNonce || state.nonce !== cookieNonce) {
    // Cancelling at the consent screen lands here with a valid state and no `code`. The token
    // hasn't been spent (we return before consuming it), so their original link still works —
    // say so rather than leaving the chat silent. Gated on the nonce matching, so this can only
    // be triggered by the browser that actually started the round trip.
    if (state && cookieNonce && state.nonce === cookieNonce) {
      notifyRegistrationFailure(registrationPhoneFromState(state));
    }
    res.redirect(`${CLIENT_URL}/?error=oauth_failed`);
    return;
  }

  // Captured for the catch below, which otherwise can't see `reg` (scoped inside the try) and so
  // had no way to reach the user on WhatsApp at all.
  let registrationPhone: string | null = registrationPhoneFromState(state);

  try {
    if (state.intent === "connect") {
      const account = await handleGoogleCallback(code, connectOwnerFromSession(req, state));
      res.redirect(`${CLIENT_URL}${connectReturnPath(state)}?connected=${encodeURIComponent(account.email)}`);
      return;
    }

    if (state.intent === "whatsapp_register") {
      if (!state.registrationToken) {
        res.redirect(`${CLIENT_URL}/connected?error=expired`);
        return;
      }
      const reg = consumePendingRegistrationToken(state.registrationToken);
      if (!reg) {
        res.redirect(`${CLIENT_URL}/connected?error=expired`);
        return;
      }
      registrationPhone = reg.phone;
      const auth = await exchangeGoogleCode(code);
      // Authoritative re-check of the same gate whatsappRegistration.ts's first-contact check
      // already passed — re-checked here in case the invite was revoked mid-conversation, same
      // defense-in-depth shape the email version used.
      if (!isPhoneInvited(reg.phone)) {
        res.redirect(`${CLIENT_URL}/connected?error=not_invited`);
        sendScriptedText(
          reg.phone,
          "This number isn't invited yet — ask whoever's running the beta to add it, then message again."
        ).catch(() => {});
        return;
      }
      const existingUser = getUserByEmail(auth.email);
      if (existingUser && !googleMayUseExistingUser(existingUser.id, auth.email)) {
        res.redirect(`${CLIENT_URL}/connected?error=account_exists`);
        sendScriptedText(reg.phone, ACCOUNT_EXISTS_WHATSAPP_TEXT).catch(() => {});
        return;
      }
      // Captured before resolveRegistrationUser runs (same phoneOwnerId check it does internally)
      // so sendFirstValueAndBriefingPrompt below can tell a fresh signup from a mailbox linked
      // onto an account that already existed — see that function's linkedExistingAccount comment.
      const linkedExistingAccount = resolveOwnerByPhone(reg.phone) !== null;
      const resolution = resolveRegistrationUser(reg.phone, auth.email);
      if (resolution.kind === "account_exists") {
        res.redirect(`${CLIENT_URL}/connected?error=account_exists`);
        sendScriptedText(reg.phone, whatsappRefusalText(resolution)).catch(() => {});
        return;
      }
      const user = getUser(resolution.userId) as UserRow;
      try {
        addPhoneNumberForUser(user.id, reg.phone);
      } catch {
        res.redirect(`${CLIENT_URL}/connected?error=phone_taken`);
        sendScriptedText(reg.phone, "This WhatsApp number is already connected to a different Marlowe account.").catch(
          () => {}
        );
        return;
      }
      // This exact mailbox is already connected: the link was a reconnect (connect_email for a
      // broken connection — connectMailboxLink.ts's "reconnect"), not a signup. Same handling as
      // the Microsoft callback's isReconnect below.
      const isReconnect = listAccounts(user.id, "google").some(
        (a) => a.email.toLowerCase() === auth.email.toLowerCase()
      );
      upsertAccount(user.id, {
        provider: "google",
        email: auth.email,
        accessToken: auth.accessToken,
        refreshToken: auth.refreshToken,
        expiryDate: auth.expiryDate,
      });
      // Nice-to-have: the same phone's browser is now also logged into the website — except for
      // the WhatsApp Simulator, whose "phone" is the operator's own admin browser (see
      // isSimulatedPhone): switching that session would demote them mid-test.
      if (!isSimulatedPhone(reg.phone)) setSessionCookie(res, createSession(user.id));
      res.redirect(`${CLIENT_URL}/connected`);
      if (isReconnect) {
        completePendingRegistration(reg.phone);
        sendScriptedText(reg.phone, `✓ Reconnected ${auth.email} — I can see your mail and calendar again.`).catch(
          (err) => console.error("whatsapp-register: reconnect message failed", err)
        );
        return;
      }
      // Fire-and-forget — this is the proactive WhatsApp push confirming the connection, which
      // has to happen from here since this moment (finishing OAuth in a browser) is outside any
      // inbound webhook the conversation state machine could otherwise react to.
      sendFirstValueAndBriefingPrompt(user.id, reg.phone, linkedExistingAccount).catch((err) =>
        console.error("whatsapp-register: post-connect message failed", err)
      );
      return;
    }

    const auth = await exchangeGoogleCode(code);
    // Registration only happens via WhatsApp now (gated by phone invite there) — a brand-new
    // email hitting this plain web sign-in with no account yet is turned away here, same as
    // before, just no longer checked against an email invite list. A RETURNING user (already has
    // an account, from having gone through WhatsApp registration) is never blocked — this is
    // their normal sign-in, not a new signup.
    const user = getUserByEmail(auth.email);
    if (!user) {
      res.redirect(`${CLIENT_URL}/?not_invited=1`);
      return;
    }
    if (!googleMayUseExistingUser(user.id, auth.email)) {
      res.redirect(`${CLIENT_URL}/?error=google_unverified`);
      return;
    }
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
    // The token was already spent above, so their link is dead as well as their attempt —
    // without this the conversation just stops.
    notifyRegistrationFailure(registrationPhone);
    const errorDest =
      state.intent === "connect"
        ? `${CLIENT_URL}${connectReturnPath(state)}`
        : state.intent === "whatsapp_register"
        ? `${CLIENT_URL}/connected`
        : CLIENT_URL;
    res.redirect(`${errorDest}?error=oauth_failed`);
  }
});

authRoutes.get("/auth/microsoft/callback", async (req, res) => {
  const code = req.query.code as string | undefined;
  const cookieNonce = req.cookies?.[NONCE_COOKIE] as string | undefined;
  res.clearCookie(NONCE_COOKIE, { path: "/auth" });
  const state = parseState(req.query.state as string | undefined);

  if (!code || !state || !cookieNonce || state.nonce !== cookieNonce) {
    // See the Google callback's copy of this — same cancel-at-consent case.
    if (state && cookieNonce && state.nonce === cookieNonce) {
      notifyRegistrationFailure(registrationPhoneFromState(state));
    }
    res.redirect(`${CLIENT_URL}/?error=oauth_failed`);
    return;
  }

  let registrationPhone: string | null = registrationPhoneFromState(state);

  try {
    if (state.intent === "connect") {
      const ownerId = connectOwnerFromSession(req, state);
      const auth = await exchangeMicrosoftCode(code);
      const account = saveMicrosoftAccount(ownerId, auth);
      // The session proves who the user is and the OAuth round trip proves the Microsoft account, so
      // this is a verified link — it's what lets that account sign in on its own later. A no-op if
      // the identity is already linked (to this user or, e.g. a shared mailbox, to someone else).
      linkIdentity(ownerId, "microsoft", microsoftIdentitySubject(auth));
      res.redirect(`${CLIENT_URL}${connectReturnPath(state)}?connected=${encodeURIComponent(account.email)}`);
      return;
    }

    if (state.intent === "whatsapp_register") {
      if (!state.registrationToken) {
        res.redirect(`${CLIENT_URL}/connected?error=expired`);
        return;
      }
      const reg = consumePendingRegistrationToken(state.registrationToken);
      if (!reg) {
        res.redirect(`${CLIENT_URL}/connected?error=expired`);
        return;
      }
      registrationPhone = reg.phone;
      const auth = await exchangeMicrosoftCode(code);
      // Authoritative re-check — see the matching comment on the Google callback above.
      if (!isPhoneInvited(reg.phone)) {
        res.redirect(`${CLIENT_URL}/connected?error=not_invited`);
        sendScriptedText(
          reg.phone,
          "This number isn't invited yet — ask whoever's running the beta to add it, then message again."
        ).catch(() => {});
        return;
      }
      const resolved = await resolveMicrosoftUser(auth);
      if (resolved === "unverified") {
        res.redirect(`${CLIENT_URL}/connected?error=account_exists`);
        sendScriptedText(reg.phone, ACCOUNT_EXISTS_WHATSAPP_TEXT).catch(() => {});
        return;
      }
      // See the matching comment on the Google callback above. Computed unconditionally, before
      // either branch below — NOT only on the resolveRegistrationUser (resolved === "none") path.
      // resolveMicrosoftUser resolves from user_identities (authRoutes.ts above), which survives
      // deleteAccount (accountRoutes.ts): a user who connects Outlook, later disconnects the
      // mailbox, then asks Marlowe to connect email again reaches the `else` branch below with
      // listAccounts(userId) empty but resolved !== "none". Reading it only inside the "none"
      // branch left that case permanently false, which made startPostConnectSetup run the full
      // fresh-signup chain (including the topics overwrite Task 8 exists to prevent) on an
      // established account.
      const linkedExistingAccount = resolveOwnerByPhone(reg.phone) !== null;
      let userId: number;
      if (resolved === "none") {
        const resolution = resolveRegistrationUser(reg.phone, auth.email);
        if (resolution.kind === "account_exists") {
          res.redirect(`${CLIENT_URL}/connected?error=account_exists`);
          sendScriptedText(reg.phone, whatsappRefusalText(resolution)).catch(() => {});
          return;
        }
        userId = resolution.userId;
      } else {
        userId = resolved;
      }
      try {
        addPhoneNumberForUser(userId, reg.phone);
      } catch {
        res.redirect(`${CLIENT_URL}/connected?error=phone_taken`);
        sendScriptedText(reg.phone, "This WhatsApp number is already connected to a different Marlowe account.").catch(
          () => {}
        );
        return;
      }
      // This exact mailbox is already connected: the link was a reconnect (sendConnectLink's
      // "enable_send", to pick up Mail.Send), not a signup — refresh the tokens and say so, rather
      // than rerunning the new-user setup chain (inbox preview, briefing questions) at them.
      const reconnected = listAccounts(userId, "microsoft").find(
        (a) => a.email.toLowerCase() === auth.email.toLowerCase()
      );
      const isReconnect = reconnected !== undefined;
      linkIdentity(userId, "microsoft", microsoftIdentitySubject(auth));
      saveMicrosoftAccount(userId, auth);
      // Same simulator carve-out as the Google callback above.
      if (!isSimulatedPhone(reg.phone)) setSessionCookie(res, createSession(userId));
      res.redirect(`${CLIENT_URL}/connected`);
      if (isReconnect) {
        completePendingRegistration(reg.phone);
        // A broken connection (connect_email's "reconnect") vs the Mail.Send upgrade ("enable_send").
        sendScriptedText(
          reg.phone,
          reconnected.authBroken
            ? `✓ Reconnected ${auth.email} — I can see your mail and calendar again.`
            : `✓ Reconnected ${auth.email} — I can send email from Outlook now. Just ask me to send it again.`
        ).catch((err) => console.error("whatsapp-register: reconnect message failed", err));
        return;
      }
      sendFirstValueAndBriefingPrompt(userId, reg.phone, linkedExistingAccount).catch((err) =>
        console.error("whatsapp-register: post-connect message failed", err)
      );
      return;
    }

    const auth = await exchangeMicrosoftCode(code);
    // See the matching comment on the Google callback above — blocks only a brand-new signup. Unlike
    // Google, an email match isn't enough to sign in as that user — see resolveMicrosoftUser.
    const resolved = await resolveMicrosoftUser(auth);
    if (resolved === "none") {
      res.redirect(`${CLIENT_URL}/?not_invited=1`);
      return;
    }
    if (resolved === "unverified") {
      res.redirect(`${CLIENT_URL}/?error=microsoft_unverified`);
      return;
    }
    const userId = resolved;
    // Same ordering reasoning as the Google callback above.
    const hasAccounts = listAccounts(userId).length > 0;
    saveMicrosoftAccount(userId, auth);
    setSessionCookie(res, createSession(userId));
    res.redirect(`${CLIENT_URL}${hasAccounts ? "/assistant" : "/onboarding"}`);
  } catch (err) {
    console.error("Microsoft OAuth callback failed", err);
    notifyRegistrationFailure(registrationPhone);
    const errorDest =
      state.intent === "connect"
        ? `${CLIENT_URL}${connectReturnPath(state)}`
        : state.intent === "whatsapp_register"
        ? `${CLIENT_URL}/connected`
        : CLIENT_URL;
    res.redirect(`${errorDest}?error=oauth_failed`);
  }
});
