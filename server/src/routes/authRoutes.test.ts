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

const { authRoutes } = await import("./authRoutes.js");
const { exchangeGoogleCode, handleGoogleCallback } = await import("../providers/google.js");
const { findOrCreateUserByEmail, listAccounts, upsertAccount, createSession } = await import("../db/store.js");

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
});

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

    const callback = await request(app)
      .get(`/auth/google/callback?code=fakecode&state=${encodeURIComponent(state)}`)
      .set("Cookie", nonceCookie!);

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
      .set("Cookie", nonceCookie!);

    expect(callback.headers.location).toBe(
      "http://localhost:5173/settings?connected=connected2%40example.com"
    );
  });

  it("rejects /auth/google/login (connect) with no session", async () => {
    const app = buildApp();
    const res = await request(app).get("/auth/google/login?from=onboarding");
    expect(res.status).toBe(401);
  });
});
