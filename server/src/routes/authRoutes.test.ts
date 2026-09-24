import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

// Only the actual network-calling provider functions are mocked — everything else (DB, session
// cookies, the nonce/state handshake, requireAuth) runs for real, same posture as
// toolsRoutes.test.ts. getGoogleAuthUrl returns a URL whose `state` query param is real and
// readable, so tests can carry it through the handshake exactly like a real browser round trip.
vi.mock("../providers/google.js", () => ({
  isGoogleConfigured: () => true,
  getGoogleAuthUrl: (state: string) => `https://accounts.google.com/mock?state=${state}`,
  exchangeGoogleCode: vi.fn(),
  handleGoogleCallback: vi.fn(),
}));

vi.mock("../providers/microsoft.js", () => ({
  isMicrosoftConfigured: () => true,
  getMicrosoftAuthUrl: (state: string) => `https://login.microsoftonline.com/mock?state=${state}`,
  exchangeMicrosoftCode: vi.fn(),
  microsoftGetGraphUserId: vi.fn(),
  microsoftIdentitySubject: (auth: { tenantId: string; objectId: string }) => `${auth.tenantId}:${auth.objectId}`,
}));
vi.mock("../providers/whatsapp.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../providers/whatsapp.js")>();
  return {
    // The simulated-number helpers are pure — kept real so the callbacks' simulator check runs.
    isSimulatedPhone: actual.isSimulatedPhone,
    newSimulatedTestUserPhone: actual.newSimulatedTestUserPhone,
    sendWhatsAppMessage: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock("../services/whatsappRegistration.js", () => ({
  sendFirstValueAndBriefingPrompt: vi.fn().mockResolvedValue(undefined),
}));

const { authRoutes } = await import("./authRoutes.js");
const { exchangeGoogleCode, handleGoogleCallback } = await import("../providers/google.js");
const { sendWhatsAppMessage, newSimulatedTestUserPhone } = await import("../providers/whatsapp.js");
const { exchangeMicrosoftCode, microsoftGetGraphUserId } = await import("../providers/microsoft.js");
const { sendFirstValueAndBriefingPrompt } = await import("../services/whatsappRegistration.js");
const {
  findOrCreateUserByEmail,
  findOrCreateUserByPhone,
  getUserByEmail,
  listAccounts,
  upsertAccount,
  createSession,
  linkIdentity,
  getUserIdByIdentity,
  addInvitedPhone,
  upsertPendingRegistration,
  setPendingRegistrationToken,
  listPhoneNumbersForUser,
  resolveOwnerByPhone,
} = await import("../db/store.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(authRoutes);
  return app;
}

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

/** Cookie-jar helper: mirrors what a real browser does across the redirect chain. */
function parseSetCookie(res: request.Response, name: string): string | undefined {
  const raw = res.headers["set-cookie"] as unknown as string[] | undefined;
  const line = raw?.find((c) => c.startsWith(`${name}=`));
  return line?.split(";")[0];
}

beforeEach(() => {
  vi.mocked(exchangeGoogleCode).mockReset();
  vi.mocked(handleGoogleCallback).mockReset();
  vi.mocked(exchangeMicrosoftCode).mockReset();
  vi.mocked(microsoftGetGraphUserId).mockReset().mockResolvedValue(null);
});

/** The same unsigned base64url JSON shape authRoutes.ts builds — what an attacker can hand-craft. */
function forgeConnectState(ownerId: number, nonce: string): string {
  return Buffer.from(JSON.stringify({ intent: "connect", ownerId, returnTo: "settings", nonce })).toString(
    "base64url"
  );
}

describe("GET /auth/google/callback — login intent", () => {
  // Registration only happens via WhatsApp now (gated by phone invite there, see
  // whatsappRegistration.test.ts) — this plain web sign-in must turn away an email with no
  // existing account rather than creating one, regardless of anything else about the request.
  it("blocks a brand-new email with no existing account", async () => {
    const app = buildApp();
    const email = uniqueEmail("never-registered");

    const start = await request(app).get("/auth/google/login-signin");
    const nonceCookie = parseSetCookie(start, "oauth_nonce");
    const state = new URL(start.headers.location).searchParams.get("state")!;

    vi.mocked(exchangeGoogleCode).mockResolvedValue({
      email,
      accessToken: "at",
      refreshToken: "rt",
      expiryDate: Date.now() + 3600_000,
    });

    const callback = await request(app)
      .get(`/auth/google/callback?code=fakecode&state=${encodeURIComponent(state)}`)
      .set("Cookie", nonceCookie!);

    expect(callback.headers.location).toBe("http://localhost:5173/?not_invited=1");
    expect(listAccounts(findOrCreateUserByEmail(email).id)).toHaveLength(0);
  });

  it("a user who already has an account (e.g. from WhatsApp registration) but never signed into the web before auto-connects Google AND still lands on /onboarding", async () => {
    const app = buildApp();
    const email = uniqueEmail("first-web-login");
    // Simulates having already gone through WhatsApp registration — a users row exists, but no
    // Google/Microsoft account has ever been connected via this web sign-in path yet.
    findOrCreateUserByEmail(email);

    const start = await request(app).get("/auth/google/login-signin");
    const nonceCookie = parseSetCookie(start, "oauth_nonce");
    const state = new URL(start.headers.location).searchParams.get("state")!;
    expect(nonceCookie).toBeDefined();

    vi.mocked(exchangeGoogleCode).mockResolvedValue({
      email,
      accessToken: "at",
      refreshToken: "rt",
      expiryDate: Date.now() + 3600_000,
    });

    const callback = await request(app)
      .get(`/auth/google/callback?code=fakecode&state=${encodeURIComponent(state)}`)
      .set("Cookie", nonceCookie!);

    // The core regression this test guards: even though sign-in auto-connects Google (checked
    // below), a user with NO accounts before this login must still be sent to onboarding, not
    // straight past it — the "has accounts" check has to run before the auto-connect write.
    expect(callback.headers.location).toBe("http://localhost:5173/onboarding");

    const user = findOrCreateUserByEmail(email);
    const accounts = listAccounts(user.id);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ provider: "google", email });
  });

  it("a returning user who already has a connected account skips onboarding", async () => {
    const app = buildApp();
    const email = uniqueEmail("returning-login");
    const user = findOrCreateUserByEmail(email);
    upsertAccount(user.id, {
      provider: "google",
      email,
      accessToken: "at",
      refreshToken: "rt",
      expiryDate: Date.now() + 3600_000,
    });

    const start = await request(app).get("/auth/google/login-signin");
    const nonceCookie = parseSetCookie(start, "oauth_nonce");
    const state = new URL(start.headers.location).searchParams.get("state")!;

    vi.mocked(exchangeGoogleCode).mockResolvedValue({
      email,
      accessToken: "at2",
      refreshToken: "rt2",
      expiryDate: Date.now() + 3600_000,
    });

    const callback = await request(app)
      .get(`/auth/google/callback?code=fakecode&state=${encodeURIComponent(state)}`)
      .set("Cookie", nonceCookie!);

    expect(callback.headers.location).toBe("http://localhost:5173/assistant");
  });

  it("rejects a callback whose nonce cookie doesn't match its state", async () => {
    const app = buildApp();
    const start = await request(app).get("/auth/google/login-signin");
    const state = new URL(start.headers.location).searchParams.get("state")!;

    const callback = await request(app)
      .get(`/auth/google/callback?code=fakecode&state=${encodeURIComponent(state)}`)
      .set("Cookie", "oauth_nonce=not-the-real-nonce");

    expect(callback.headers.location).toBe("http://localhost:5173/?error=oauth_failed");
    expect(exchangeGoogleCode).not.toHaveBeenCalled();
  });
});

describe("GET /auth/google/callback — connect intent", () => {
  async function startConnect(app: express.Express, sessionCookie: string, from?: string) {
    return request(app)
      .get(`/auth/google/login${from ? `?from=${from}` : ""}`)
      .set("Cookie", sessionCookie);
  }

  it("connecting from onboarding (?from=onboarding) returns to /onboarding, not /settings", async () => {
    const app = buildApp();
    const email = uniqueEmail("connect-onboarding");
    const user = findOrCreateUserByEmail(email);
    const token = createSession(user.id);

    const start = await startConnect(app, `session=${token}`, "onboarding");
    const nonceCookie = parseSetCookie(start, "oauth_nonce");
    const state = new URL(start.headers.location).searchParams.get("state")!;

    vi.mocked(handleGoogleCallback).mockResolvedValue({
      id: 1,
      ownerId: user.id,
      provider: "google",
      email: "connected@example.com",
      accessToken: "at",
      refreshToken: "rt",
      expiryDate: Date.now(),
      authBroken: false,
      authBrokenAt: null,
    });

    // A real browser sends the session cookie (path "/", SameSite=Lax) along with the nonce on the
    // top-level redirect back from Google.
    const callback = await request(app)
      .get(`/auth/google/callback?code=fakecode&state=${encodeURIComponent(state)}`)
      .set("Cookie", [nonceCookie!, `session=${token}`]);

    expect(callback.headers.location).toBe(
      "http://localhost:5173/onboarding?connected=connected%40example.com"
    );
  });

  it("connecting from Settings (no ?from) returns to /settings", async () => {
    const app = buildApp();
    const email = uniqueEmail("connect-settings");
    const user = findOrCreateUserByEmail(email);
    const token = createSession(user.id);

    const start = await startConnect(app, `session=${token}`);
    const nonceCookie = parseSetCookie(start, "oauth_nonce");
    const state = new URL(start.headers.location).searchParams.get("state")!;

    vi.mocked(handleGoogleCallback).mockResolvedValue({
      id: 2,
      ownerId: user.id,
      provider: "google",
      email: "connected2@example.com",
      accessToken: "at",
      refreshToken: "rt",
      expiryDate: Date.now(),
      authBroken: false,
      authBrokenAt: null,
    });

    const callback = await request(app)
      .get(`/auth/google/callback?code=fakecode&state=${encodeURIComponent(state)}`)
      .set("Cookie", [nonceCookie!, `session=${token}`]);

    expect(callback.headers.location).toBe(
      "http://localhost:5173/settings?connected=connected2%40example.com"
    );
  });

  // Security regression: the state is unsigned JSON and any visitor can obtain a valid nonce cookie
  // from the public login-signin route, so a hand-crafted connect state naming someone else's
  // ownerId used to attach the attacker's mailbox to that victim's hub.
  it("rejects a forged connect state naming another user when the caller has no session", async () => {
    const app = buildApp();
    const victim = findOrCreateUserByEmail(uniqueEmail("forged-victim"));

    const start = await request(app).get("/auth/google/login-signin");
    const nonceCookie = parseSetCookie(start, "oauth_nonce")!;
    const nonce = nonceCookie.split("=")[1];

    const callback = await request(app)
      .get(`/auth/google/callback?code=fakecode&state=${forgeConnectState(victim.id, nonce)}`)
      .set("Cookie", nonceCookie);

    expect(handleGoogleCallback).not.toHaveBeenCalled();
    expect(callback.headers.location).toBe("http://localhost:5173/settings?error=oauth_failed");
  });

  it("rejects a forged connect state naming another user even with the attacker's own session", async () => {
    const app = buildApp();
    const victim = findOrCreateUserByEmail(uniqueEmail("forged-victim-2"));
    const attacker = findOrCreateUserByEmail(uniqueEmail("forged-attacker"));
    const attackerToken = createSession(attacker.id);

    const start = await request(app).get("/auth/google/login-signin");
    const nonceCookie = parseSetCookie(start, "oauth_nonce")!;
    const nonce = nonceCookie.split("=")[1];

    const callback = await request(app)
      .get(`/auth/google/callback?code=fakecode&state=${forgeConnectState(victim.id, nonce)}`)
      .set("Cookie", [nonceCookie, `session=${attackerToken}`]);

    expect(handleGoogleCallback).not.toHaveBeenCalled();
    expect(callback.headers.location).toBe("http://localhost:5173/settings?error=oauth_failed");
  });

  it("rejects a forged connect state on the Microsoft callback too", async () => {
    const app = buildApp();
    const victim = findOrCreateUserByEmail(uniqueEmail("forged-victim-ms"));

    const start = await request(app).get("/auth/microsoft/login-signin");
    const nonceCookie = parseSetCookie(start, "oauth_nonce")!;
    const nonce = nonceCookie.split("=")[1];

    const callback = await request(app)
      .get(`/auth/microsoft/callback?code=fakecode&state=${forgeConnectState(victim.id, nonce)}`)
      .set("Cookie", nonceCookie);

    expect(exchangeMicrosoftCode).not.toHaveBeenCalled();
    expect(callback.headers.location).toBe("http://localhost:5173/settings?error=oauth_failed");
  });

  it("rejects /auth/google/login (connect) with no session", async () => {
    const app = buildApp();
    const res = await request(app).get("/auth/google/login?from=onboarding");
    expect(res.status).toBe(401);
  });
});

// --- Microsoft identity (review finding #2) ------------------------------------------------------
// Microsoft sign-in used to find the user by Graph's `mail`, which any Entra tenant admin can set to
// someone else's address. People are now identified by tenant id + object id; an existing user is
// only linked when a Microsoft account already stored on their hub resolves to the same Graph user.

let phoneCounter = 0;
function freshPhone(): string {
  phoneCounter += 1;
  return `44700009${String(phoneCounter).padStart(4, "0")}`;
}

function msAuth(email: string, tenantId: string, objectId: string, graphUserId: string) {
  return {
    email,
    accessToken: "ms-at",
    refreshToken: "ms-rt",
    expiryDate: Date.now() + 3600_000,
    tenantId,
    objectId,
    graphUserId,
  };
}

async function microsoftLogin(app: express.Express) {
  const start = await request(app).get("/auth/microsoft/login-signin");
  const nonceCookie = parseSetCookie(start, "oauth_nonce")!;
  const state = new URL(start.headers.location).searchParams.get("state")!;
  return request(app)
    .get(`/auth/microsoft/callback?code=fakecode&state=${encodeURIComponent(state)}`)
    .set("Cookie", nonceCookie);
}

function seedStoredMicrosoftAccount(userId: number, email: string) {
  return upsertAccount(userId, {
    provider: "microsoft",
    email,
    accessToken: "stored-at",
    refreshToken: "stored-rt",
    expiryDate: Date.now() + 3600_000,
  });
}

describe("GET /auth/microsoft/callback — login intent identity", () => {
  it("refuses an existing user's email when nothing proves it's the same Microsoft account", async () => {
    const app = buildApp();
    const email = uniqueEmail("ms-spoofed-victim");
    findOrCreateUserByEmail(email);
    vi.mocked(exchangeMicrosoftCode).mockResolvedValue(msAuth(email, "attacker-tenant", "attacker-obj", "attacker-graph"));

    const callback = await microsoftLogin(app);

    expect(callback.headers.location).toBe("http://localhost:5173/?error=microsoft_unverified");
    expect(parseSetCookie(callback, "session")).toBeUndefined();
  });

  it("refuses when the victim's stored Microsoft account belongs to a different Graph user", async () => {
    const app = buildApp();
    const email = uniqueEmail("ms-mismatch-victim");
    const victim = findOrCreateUserByEmail(email);
    seedStoredMicrosoftAccount(victim.id, email);
    vi.mocked(microsoftGetGraphUserId).mockResolvedValue("victim-graph");
    vi.mocked(exchangeMicrosoftCode).mockResolvedValue(msAuth(email, "attacker-tenant", "attacker-obj", "attacker-graph"));

    const callback = await microsoftLogin(app);

    expect(callback.headers.location).toBe("http://localhost:5173/?error=microsoft_unverified");
    expect(parseSetCookie(callback, "session")).toBeUndefined();
  });

  it("links and signs in an existing user whose stored Microsoft account is the same Graph user", async () => {
    const app = buildApp();
    const email = uniqueEmail("ms-grandfathered");
    const user = findOrCreateUserByEmail(email);
    seedStoredMicrosoftAccount(user.id, email);
    vi.mocked(microsoftGetGraphUserId).mockResolvedValue("same-graph");
    vi.mocked(exchangeMicrosoftCode).mockResolvedValue(msAuth(email, "tenant-g", "obj-g", "same-graph"));

    const callback = await microsoftLogin(app);

    expect(callback.headers.location).toBe("http://localhost:5173/assistant");
    expect(parseSetCookie(callback, "session")).toBeDefined();
    expect(getUserIdByIdentity("microsoft", "tenant-g:obj-g")).toBe(user.id);
  });

  it("signs in by linked identity, without needing the stored-account check", async () => {
    const app = buildApp();
    const email = uniqueEmail("ms-linked");
    const user = findOrCreateUserByEmail(email);
    linkIdentity(user.id, "microsoft", "tenant-l:obj-l");
    vi.mocked(exchangeMicrosoftCode).mockResolvedValue(msAuth(email, "tenant-l", "obj-l", "graph-l"));

    const callback = await microsoftLogin(app);

    expect(parseSetCookie(callback, "session")).toBeDefined();
    expect(microsoftGetGraphUserId).not.toHaveBeenCalled();
  });

  it("still turns away an email with no account at all", async () => {
    const app = buildApp();
    const email = uniqueEmail("ms-never-registered");
    vi.mocked(exchangeMicrosoftCode).mockResolvedValue(msAuth(email, "t", "o", "g"));

    const callback = await microsoftLogin(app);

    expect(callback.headers.location).toBe("http://localhost:5173/?not_invited=1");
    expect(getUserByEmail(email)).toBeNull();
  });
});

describe("GET /auth/microsoft/callback — connect intent identity", () => {
  it("links the connected Microsoft identity to the signed-in user, so it can sign in later", async () => {
    const app = buildApp();
    const user = findOrCreateUserByEmail(uniqueEmail("ms-connect-link"));
    const token = createSession(user.id);

    const start = await request(app).get("/auth/microsoft/login").set("Cookie", `session=${token}`);
    const nonceCookie = parseSetCookie(start, "oauth_nonce")!;
    const state = new URL(start.headers.location).searchParams.get("state")!;
    const outlookEmail = uniqueEmail("ms-connect-outlook");
    vi.mocked(exchangeMicrosoftCode).mockResolvedValue(msAuth(outlookEmail, "tenant-c", "obj-c", "graph-c"));

    const callback = await request(app)
      .get(`/auth/microsoft/callback?code=fakecode&state=${encodeURIComponent(state)}`)
      .set("Cookie", [nonceCookie, `session=${token}`]);

    expect(callback.headers.location).toBe(
      `http://localhost:5173/settings?connected=${encodeURIComponent(outlookEmail)}`
    );
    expect(listAccounts(user.id, "microsoft").map((a) => a.email)).toEqual([outlookEmail]);
    expect(getUserIdByIdentity("microsoft", "tenant-c:obj-c")).toBe(user.id);
  });
});

// Module-scoped (not nested in a describe) so the "linkedExistingAccount" describe block below
// can reuse it without duplicating a second copy that could drift from this one.
async function registerViaMicrosoft(app: express.Express, phone: string, typedEmail: string) {
  addInvitedPhone(phone);
  upsertPendingRegistration(phone, { step: "awaiting_link_tap", typedEmail, provider: "microsoft" });
  const token = setPendingRegistrationToken(phone);
  const start = await request(app).get(`/auth/microsoft/register?token=${token}`);
  const nonceCookie = parseSetCookie(start, "oauth_nonce")!;
  const state = new URL(start.headers.location).searchParams.get("state")!;
  return request(app)
    .get(`/auth/microsoft/callback?code=fakecode&state=${encodeURIComponent(state)}`)
    .set("Cookie", nonceCookie);
}

describe("GET /auth/microsoft/callback — WhatsApp registration identity", () => {

  it("refuses to bind a new phone to an existing user's email without proof of the same Microsoft account", async () => {
    const app = buildApp();
    const phone = freshPhone();
    const email = uniqueEmail("ms-reg-victim");
    const victim = findOrCreateUserByEmail(email);
    vi.mocked(exchangeMicrosoftCode).mockResolvedValue(msAuth(email, "attacker-tenant", "attacker-obj", "attacker-graph"));

    const callback = await registerViaMicrosoft(app, phone, email);

    expect(callback.headers.location).toBe("http://localhost:5173/connected?error=account_exists");
    expect(listPhoneNumbersForUser(victim.id)).toEqual([]);
    expect(resolveOwnerByPhone(phone)).toBeNull();
  });

  it("creates a brand-new user and links the identity when the email is unused", async () => {
    const app = buildApp();
    const phone = freshPhone();
    const email = uniqueEmail("ms-reg-new");
    vi.mocked(exchangeMicrosoftCode).mockResolvedValue(msAuth(email, "tenant-n", "obj-n", "graph-n"));

    const callback = await registerViaMicrosoft(app, phone, email);

    expect(callback.headers.location).toBe("http://localhost:5173/connected");
    const user = getUserByEmail(email)!;
    expect(resolveOwnerByPhone(phone)).toBe(user.id);
    expect(getUserIdByIdentity("microsoft", "tenant-n:obj-n")).toBe(user.id);
  });

  it("reuses the user a linked identity belongs to", async () => {
    const app = buildApp();
    const phone = freshPhone();
    const email = uniqueEmail("ms-reg-linked");
    const user = findOrCreateUserByEmail(email);
    linkIdentity(user.id, "microsoft", "tenant-r:obj-r");
    vi.mocked(exchangeMicrosoftCode).mockResolvedValue(msAuth(email, "tenant-r", "obj-r", "graph-r"));

    const callback = await registerViaMicrosoft(app, phone, email);

    expect(callback.headers.location).toBe("http://localhost:5173/connected");
    expect(resolveOwnerByPhone(phone)).toBe(user.id);
  });
});

// This flag is the seam the whole hazard-guard in postConnectSetup.ts hinges on (review finding
// #3): inverting it either re-onboards a long-time phone-only user (the exact bug this task exists
// to prevent) or silently drops the onboarding chain for a genuine new signup. Asserted directly
// against the mocked sendFirstValueAndBriefingPrompt call, not just indirectly through
// resolveRegistrationUser (which the earlier e2e test in assistant.connectEmail.test.ts already
// covers but which bypasses this derivation entirely).
async function registerViaGoogle(app: express.Express, phone: string, email: string) {
  addInvitedPhone(phone);
  upsertPendingRegistration(phone, { step: "awaiting_link_tap", typedEmail: email, provider: "google" });
  const token = setPendingRegistrationToken(phone);
  const start = await request(app).get(`/auth/google/register?token=${token}`);
  const nonceCookie = parseSetCookie(start, "oauth_nonce")!;
  const state = new URL(start.headers.location).searchParams.get("state")!;
  return request(app)
    .get(`/auth/google/callback?code=fakecode&state=${encodeURIComponent(state)}`)
    .set("Cookie", nonceCookie);
}

describe("linkedExistingAccount signal passed to sendFirstValueAndBriefingPrompt", () => {
  it("Google: true when the phone already owned a (phone-only) account before this connection", async () => {
    const app = buildApp();
    const phone = freshPhone();
    const existing = findOrCreateUserByPhone(phone);
    const email = uniqueEmail("google-link-existing");
    vi.mocked(exchangeGoogleCode).mockResolvedValue({
      email,
      accessToken: "at",
      refreshToken: "rt",
      expiryDate: Date.now() + 3600_000,
    });

    await registerViaGoogle(app, phone, email);

    expect(sendFirstValueAndBriefingPrompt).toHaveBeenCalledWith(existing.id, phone, true);
  });

  it("Google: false for a fresh signup with no prior account on this phone", async () => {
    const app = buildApp();
    const phone = freshPhone();
    const email = uniqueEmail("google-link-fresh");
    vi.mocked(exchangeGoogleCode).mockResolvedValue({
      email,
      accessToken: "at",
      refreshToken: "rt",
      expiryDate: Date.now() + 3600_000,
    });

    await registerViaGoogle(app, phone, email);

    const user = getUserByEmail(email)!;
    expect(sendFirstValueAndBriefingPrompt).toHaveBeenCalledWith(user.id, phone, false);
  });

  it("Microsoft: true when the phone already owned a (phone-only) account before this connection", async () => {
    const app = buildApp();
    const phone = freshPhone();
    const existing = findOrCreateUserByPhone(phone);
    const email = uniqueEmail("ms-link-existing");
    vi.mocked(exchangeMicrosoftCode).mockResolvedValue(msAuth(email, "tenant-le1", "obj-le1", "graph-le1"));

    await registerViaMicrosoft(app, phone, email);

    expect(sendFirstValueAndBriefingPrompt).toHaveBeenCalledWith(existing.id, phone, true);
  });

  it("Microsoft: false for a fresh signup with no prior account on this phone", async () => {
    const app = buildApp();
    const phone = freshPhone();
    const email = uniqueEmail("ms-link-fresh");
    vi.mocked(exchangeMicrosoftCode).mockResolvedValue(msAuth(email, "tenant-le2", "obj-le2", "graph-le2"));

    await registerViaMicrosoft(app, phone, email);

    const user = getUserByEmail(email)!;
    expect(sendFirstValueAndBriefingPrompt).toHaveBeenCalledWith(user.id, phone, false);
  });

  it("Microsoft: true when a linked identity's mailbox was already disconnected — resolveMicrosoftUser resolves from user_identities, which deleteAccount doesn't touch, so this reaches the `else` branch with listAccounts empty (review finding #3)", async () => {
    const app = buildApp();
    const phone = freshPhone();
    const email = uniqueEmail("ms-link-reconnect");
    // The phone already owns an account (from earlier registration) with a Microsoft identity
    // linked but no accounts row — exactly what's left after connecting Outlook and then
    // disconnecting it via accountRoutes' deleteAccount, which removes the account but not the
    // user_identities row.
    const existing = findOrCreateUserByPhone(phone);
    linkIdentity(existing.id, "microsoft", "tenant-recon:obj-recon");
    expect(listAccounts(existing.id, "microsoft")).toEqual([]);
    vi.mocked(exchangeMicrosoftCode).mockResolvedValue(msAuth(email, "tenant-recon", "obj-recon", "graph-recon"));

    await registerViaMicrosoft(app, phone, email);

    expect(sendFirstValueAndBriefingPrompt).toHaveBeenCalledWith(existing.id, phone, true);
  });
});

describe("Google sign-in can't take over a Microsoft-identified user", () => {
  // Closes the pre-hijack path the Microsoft fix would otherwise leave: someone creates a user via
  // Outlook registration with an unverified `mail` set to your address; your later Google sign-in
  // must not land in (and auto-connect your Gmail to) that hub.
  async function googleLogin(app: express.Express, email: string) {
    const start = await request(app).get("/auth/google/login-signin");
    const nonceCookie = parseSetCookie(start, "oauth_nonce")!;
    const state = new URL(start.headers.location).searchParams.get("state")!;
    vi.mocked(exchangeGoogleCode).mockResolvedValue({
      email,
      accessToken: "at",
      refreshToken: "rt",
      expiryDate: Date.now() + 3600_000,
    });
    return request(app)
      .get(`/auth/google/callback?code=fakecode&state=${encodeURIComponent(state)}`)
      .set("Cookie", nonceCookie);
  }

  it("refuses when the user has a Microsoft identity but no Google account with this email", async () => {
    const app = buildApp();
    const email = uniqueEmail("google-prehijack");
    const user = findOrCreateUserByEmail(email);
    linkIdentity(user.id, "microsoft", `tenant-p:obj-${email}`);

    const callback = await googleLogin(app, email);

    expect(callback.headers.location).toBe("http://localhost:5173/?error=google_unverified");
    expect(parseSetCookie(callback, "session")).toBeUndefined();
    expect(listAccounts(user.id, "google")).toEqual([]);
  });

  it("allows it once that user has already connected this Google account", async () => {
    const app = buildApp();
    const email = uniqueEmail("google-connected-too");
    const user = findOrCreateUserByEmail(email);
    linkIdentity(user.id, "microsoft", `tenant-q:obj-${email}`);
    upsertAccount(user.id, { provider: "google", email, accessToken: "a", refreshToken: "r", expiryDate: null });

    const callback = await googleLogin(app, email);

    expect(parseSetCookie(callback, "session")).toBeDefined();
  });
});

// A WhatsApp registration that dies inside the callback used to redirect the browser and say
// nothing in the chat — where the whole conversation is happening. The token is already spent by
// then (consumePendingRegistrationToken runs before the code exchange), so the link they tapped
// is dead too: without a message they are parked at awaiting_link_tap with no working link and
// no idea anything went wrong. not_invited/account_exists/phone_taken already messaged; these are
// the paths that didn't.
describe("WhatsApp registration failures reach the user on WhatsApp", () => {
  it("Google: tells them how to retry when the code exchange throws", async () => {
    const app = buildApp();
    const phone = freshPhone();
    vi.mocked(sendWhatsAppMessage).mockClear();
    vi.mocked(exchangeGoogleCode).mockRejectedValue(new Error("token endpoint exploded"));

    const res = await registerViaGoogle(app, phone, uniqueEmail("google-boom"));

    expect(res.headers.location).toContain("error=oauth_failed");
    expect(sendWhatsAppMessage).toHaveBeenCalledWith(phone, expect.stringContaining("resend"));
  });

  it("Microsoft: tells them how to retry when the code exchange throws", async () => {
    const app = buildApp();
    const phone = freshPhone();
    vi.mocked(sendWhatsAppMessage).mockClear();
    vi.mocked(exchangeMicrosoftCode).mockRejectedValue(new Error("token endpoint exploded"));

    const res = await registerViaMicrosoft(app, phone, uniqueEmail("ms-boom"));

    expect(res.headers.location).toContain("error=oauth_failed");
    expect(sendWhatsAppMessage).toHaveBeenCalledWith(phone, expect.stringContaining("resend"));
  });

  // Cancelling at Google's consent screen comes back with no `code` at all. The state (and so the
  // phone) is still readable, so there is no reason for this to be silent either.
  it("Google: tells them how to retry when they cancel at the consent screen", async () => {
    const app = buildApp();
    const phone = freshPhone();
    addInvitedPhone(phone);
    upsertPendingRegistration(phone, { step: "awaiting_link_tap", provider: "google" });
    const token = setPendingRegistrationToken(phone);
    const start = await request(app).get(`/auth/google/register?token=${token}`);
    const nonceCookie = parseSetCookie(start, "oauth_nonce")!;
    const state = new URL(start.headers.location).searchParams.get("state")!;
    vi.mocked(sendWhatsAppMessage).mockClear();

    await request(app)
      .get(`/auth/google/callback?error=access_denied&state=${encodeURIComponent(state)}`)
      .set("Cookie", nonceCookie);

    expect(sendWhatsAppMessage).toHaveBeenCalledWith(phone, expect.stringContaining("resend"));
  });
});

// The WhatsApp Simulator's "Connect Gmail/Outlook" link is opened in the operator's own browser,
// already signed in as an admin. Logging that browser into the new test user (the "same phone's
// browser is now logged in too" nicety real signups get) silently demoted the operator mid-test:
// every simulator request then failed requireAdmin with "not allowed".
describe("WhatsApp registration from a simulated number", () => {
  const googleAuth = (email: string) => ({
    email,
    accessToken: "at",
    refreshToken: "rt",
    expiryDate: Date.now() + 3600_000,
  });

  it("Google: completes the signup but leaves the browser's existing session alone", async () => {
    const app = buildApp();
    const phone = newSimulatedTestUserPhone();
    const email = uniqueEmail("sim-google");
    vi.mocked(exchangeGoogleCode).mockResolvedValue(googleAuth(email));

    const callback = await registerViaGoogle(app, phone, email);

    expect(callback.headers.location).toBe("http://localhost:5173/connected");
    expect(resolveOwnerByPhone(phone)).toBe(getUserByEmail(email)!.id);
    expect(parseSetCookie(callback, "session")).toBeUndefined();
  });

  it("Microsoft: completes the signup but leaves the browser's existing session alone", async () => {
    const app = buildApp();
    const phone = newSimulatedTestUserPhone();
    const email = uniqueEmail("sim-ms");
    vi.mocked(exchangeMicrosoftCode).mockResolvedValue(msAuth(email, "tenant-sim", "obj-sim", "graph-sim"));

    const callback = await registerViaMicrosoft(app, phone, email);

    expect(callback.headers.location).toBe("http://localhost:5173/connected");
    expect(resolveOwnerByPhone(phone)).toBe(getUserByEmail(email)!.id);
    expect(parseSetCookie(callback, "session")).toBeUndefined();
  });

  it("a real phone's signup still logs its browser in", async () => {
    const app = buildApp();
    const phone = freshPhone();
    const email = uniqueEmail("real-google");
    vi.mocked(exchangeGoogleCode).mockResolvedValue(googleAuth(email));

    const callback = await registerViaGoogle(app, phone, email);

    expect(parseSetCookie(callback, "session")).toBeDefined();
  });
});
