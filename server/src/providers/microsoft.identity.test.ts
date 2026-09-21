// Microsoft sign-in used to identify people by Graph's `mail` field, which the admin of any Entra
// tenant can set to an arbitrary address — so anyone could sign in as an existing user by giving one
// of their own tenant's users that user's email. Identity now comes from the tenant id + object id in
// the id_token the token endpoint returns directly (never from a user-editable profile field).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AccountRow } from "../db/store.js";

vi.mock("../db/store.js", () => ({
  updateAccountTokens: vi.fn(),
  upsertAccount: vi.fn(),
}));

const { exchangeMicrosoftCode, getMicrosoftAuthUrl, microsoftGetGraphUserId } = await import("./microsoft.js");

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

function fakeIdToken(claims: Record<string, unknown>): string {
  const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(claims)}.signature`;
}

function fakeAccount(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: 1,
    ownerId: 1,
    provider: "microsoft",
    email: "test@example.com",
    accessToken: "stored-access-token",
    refreshToken: "stored-refresh-token",
    expiryDate: Date.now() + 3600_000,
    authBroken: false,
    authBrokenAt: null,
    canRead: true,
    canSend: true,
    canDelete: true,
    historyId: null,
    ...overrides,
  };
}

beforeEach(() => {
  process.env.MS_CLIENT_ID = "client-id";
  process.env.MS_CLIENT_SECRET = "client-secret";
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getMicrosoftAuthUrl", () => {
  it("requests the openid scope so the token response includes an id_token", () => {
    const scope = new URL(getMicrosoftAuthUrl("state")).searchParams.get("scope") ?? "";
    expect(scope.split(" ")).toContain("openid");
  });

  // Microsoft only puts `oid` — half of the identity readIdTokenIdentity requires — in the id_token
  // when `profile` is requested ("the profile scope is required to receive this claim", ID token
  // claims reference). Asking for `openid` alone yields a token carrying `sub` and `tid` but no
  // `oid`, so every real sign-in threw "missing the tenant/object id claims". The tests above build
  // their own id_tokens, so only this assertion catches it.
  it("requests the profile scope, without which Microsoft omits the oid claim", () => {
    const scope = new URL(getMicrosoftAuthUrl("state")).searchParams.get("scope") ?? "";
    expect(scope.split(" ")).toContain("profile");
  });
});

describe("exchangeMicrosoftCode", () => {
  it("returns the tenant id and object id from the id_token, and the Graph user id", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "at",
          refresh_token: "rt",
          expires_in: 3600,
          id_token: fakeIdToken({ tid: "tenant-1", oid: "object-1" }),
        })
      )
      .mockResolvedValueOnce(jsonResponse({ id: "graph-user-1", mail: "victim@example.com" }));

    const auth = await exchangeMicrosoftCode("code");

    expect(auth).toMatchObject({
      email: "victim@example.com",
      tenantId: "tenant-1",
      objectId: "object-1",
      graphUserId: "graph-user-1",
    });
  });

  it("refuses a token response with no usable id_token rather than falling back to email", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ access_token: "at", refresh_token: "rt", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ id: "graph-user-1", mail: "victim@example.com" }));

    await expect(exchangeMicrosoftCode("code")).rejects.toThrow(/id_token/);
  });
});

describe("microsoftGetGraphUserId", () => {
  it("returns the Graph user id for a stored account", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ id: "graph-user-9" }));
    expect(await microsoftGetGraphUserId(fakeAccount())).toBe("graph-user-9");
  });

  it("returns null when the stored account can't be reached, instead of throwing", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ error: "InvalidAuthenticationToken" }, false, 401));
    expect(await microsoftGetGraphUserId(fakeAccount())).toBeNull();
  });
});
