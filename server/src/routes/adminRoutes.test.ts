import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";

// Stubbed so approving a waitlisted number doesn't try to reach Meta — what matters here is that
// the route sends it at all, with the right text and template kind.
vi.mock("../services/outbound.js", () => ({
  sendProactiveMessage: vi.fn().mockResolvedValue(undefined),
}));

import {
  findOrCreateUserByEmail,
  getAppOwnerUserId,
  addPhoneNumberForUser,
  appendWhatsAppMessage,
  setPendingSetup,
  clearPendingSetup,
  setUserAdmin,
  recordWaitlistRequest,
  listWaitlistRequests,
  isPhoneInvited,
} from "../db/store.js";

const { sendProactiveMessage } = await import("../services/outbound.js");
import type { AuthedRequest } from "../middleware/auth.js";

const { adminRoutes } = await import("./adminRoutes.js");
const { configureTrustProxy } = await import("../config.js");

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}
function uniquePhone(): string {
  counter += 1;
  return `4479${String(Date.now()).slice(-6)}${counter}`;
}

function buildTestApp(userId: number) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as AuthedRequest).userId = userId;
    next();
  });
  app.use(adminRoutes);
  return app;
}

describe("GET /api/admin/messages", () => {
  it("rejects a non-admin with 403", async () => {
    const stranger = findOrCreateUserByEmail(uniqueEmail("not-an-admin"));
    const app = buildTestApp(stranger.id);

    const res = await request(app).get("/api/admin/messages").query({ phone: "447900000000" });

    expect(res.status).toBe(403);
  });

  it("rejects a missing phone with 400", async () => {
    const app = buildTestApp(getAppOwnerUserId());

    const res = await request(app).get("/api/admin/messages");

    expect(res.status).toBe(400);
  });

  it("returns 404 when no account is bound to that phone", async () => {
    const app = buildTestApp(getAppOwnerUserId());

    const res = await request(app).get("/api/admin/messages").query({ phone: uniquePhone() });

    expect(res.status).toBe(404);
  });

  it("returns the WhatsApp history merged with onboarding step events, oldest first", async () => {
    const testUser = findOrCreateUserByEmail(uniqueEmail("conversation-viewer-target"));
    const phone = uniquePhone();
    addPhoneNumberForUser(testUser.id, phone);
    setPendingSetup(testUser.id, "ask_name");
    appendWhatsAppMessage(testUser.id, phone, "assistant", "Before we get started — what should I call you?");
    appendWhatsAppMessage(testUser.id, phone, "user", "Sam");
    clearPendingSetup(testUser.id);

    const app = buildTestApp(getAppOwnerUserId());
    const res = await request(app).get("/api/admin/messages").query({ phone });

    expect(res.status).toBe(200);
    expect(res.body.timeline.map((e: { kind: string }) => e.kind)).toEqual([
      "step",
      "message",
      "message",
      "step",
    ]);
    const messages = res.body.timeline.filter((e: { kind: string }) => e.kind === "message");
    expect(messages.map((m: { content: string }) => m.content)).toEqual([
      "Before we get started — what should I call you?",
      "Sam",
    ]);
  });
});

// Invite-only access is gated by phone number, not email — see db/store.ts's
// isPhoneInvited/addInvitedPhone. These are the admin CRUD endpoints behind Settings' "Invited
// testers" section.
describe("/api/admin/invites", () => {
  it("rejects a non-admin with 403 on every method", async () => {
    const stranger = findOrCreateUserByEmail(uniqueEmail("not-an-admin"));
    const app = buildTestApp(stranger.id);
    const phone = uniquePhone();

    expect((await request(app).get("/api/admin/invites")).status).toBe(403);
    expect((await request(app).post("/api/admin/invites").send({ phone })).status).toBe(403);
    expect((await request(app).delete(`/api/admin/invites/${phone}`)).status).toBe(403);
  });

  it("adds, lists, and removes an invited phone number", async () => {
    const app = buildTestApp(getAppOwnerUserId());
    const phone = uniquePhone();

    const afterAdd = await request(app).post("/api/admin/invites").send({ phone });
    expect(afterAdd.status).toBe(200);
    expect(afterAdd.body.map((r: { phone: string }) => r.phone)).toContain(phone);

    const listed = await request(app).get("/api/admin/invites");
    expect(listed.body.map((r: { phone: string }) => r.phone)).toContain(phone);

    const afterRemove = await request(app).delete(`/api/admin/invites/${phone}`);
    expect(afterRemove.status).toBe(200);
    expect(afterRemove.body.map((r: { phone: string }) => r.phone)).not.toContain(phone);
  });

  it("rejects an empty/invalid phone with 400", async () => {
    const app = buildTestApp(getAppOwnerUserId());

    const res = await request(app).post("/api/admin/invites").send({ phone: "" });

    expect(res.status).toBe(400);
  });

  // normalizePhone strips non-digits, so without a length check "abc1" would be stored as the
  // invite "1" — a row that can never match a real inbound number.
  it("rejects a phone that normalizes to too few digits", async () => {
    const app = buildTestApp(getAppOwnerUserId());

    const res = await request(app).post("/api/admin/invites").send({ phone: "abc1" });

    expect(res.status).toBe(400);
  });

  // WhatsApp delivers `from` in E.164 with no leading 0, so a national-format invite would
  // silently never match and the tester would just be told they aren't invited.
  it("rejects a national-format number with a leading 0", async () => {
    const app = buildTestApp(getAppOwnerUserId());

    const res = await request(app).post("/api/admin/invites").send({ phone: "07911123456" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/country code/i);
  });
});

// The waitlist: uninvited numbers that messaged Marlowe get logged (whatsappRegistration.ts) so
// admins can see who asked. Approving is just POST /api/admin/invites — it clears the entry and
// messages the person that they're in.
describe("/api/admin/waitlist", () => {
  it("rejects a non-admin with 403 on every method", async () => {
    const stranger = findOrCreateUserByEmail(uniqueEmail("not-an-admin"));
    const app = buildTestApp(stranger.id);
    const phone = uniquePhone();

    expect((await request(app).get("/api/admin/waitlist")).status).toBe(403);
    expect((await request(app).delete(`/api/admin/waitlist/${phone}`)).status).toBe(403);
  });

  it("lists a recorded request with its repeat count", async () => {
    const app = buildTestApp(getAppOwnerUserId());
    const phone = uniquePhone();
    recordWaitlistRequest(phone);
    recordWaitlistRequest(phone);

    const res = await request(app).get("/api/admin/waitlist");

    expect(res.status).toBe(200);
    const entry = res.body.find((r: { phone: string }) => r.phone === phone);
    expect(entry.requestCount).toBe(2);
  });

  it("dismisses a request without inviting the number", async () => {
    const app = buildTestApp(getAppOwnerUserId());
    const phone = uniquePhone();
    recordWaitlistRequest(phone);

    const res = await request(app).delete(`/api/admin/waitlist/${phone}`);

    expect(res.status).toBe(200);
    expect(res.body.map((r: { phone: string }) => r.phone)).not.toContain(phone);
    expect(isPhoneInvited(phone)).toBe(false);
  });

  // The promise in MARLOWE_WAITLIST_TEXT is that we message them when they're in — so approving
  // has to both clear the entry and actually send that message.
  it("clears the waitlist entry and messages the person when they're invited", async () => {
    const app = buildTestApp(getAppOwnerUserId());
    const phone = uniquePhone();
    recordWaitlistRequest(phone);
    vi.mocked(sendProactiveMessage).mockClear();

    const res = await request(app).post("/api/admin/invites").send({ phone });

    expect(res.status).toBe(200);
    expect(isPhoneInvited(phone)).toBe(true);
    expect(listWaitlistRequests().map((r) => r.phone)).not.toContain(phone);
    expect(sendProactiveMessage).toHaveBeenCalledWith(
      phone,
      expect.stringContaining("You're in"),
      "alert"
    );
  });

  // Inviting someone who never messaged must not cold-message them out of nowhere.
  it("does not message a number that was invited without ever asking", async () => {
    const app = buildTestApp(getAppOwnerUserId());
    const phone = uniquePhone();
    vi.mocked(sendProactiveMessage).mockClear();

    await request(app).post("/api/admin/invites").send({ phone });

    expect(sendProactiveMessage).not.toHaveBeenCalled();
  });

  // The invite row is already written by the time we try to notify, so a Meta failure must not
  // make the invite itself look like it failed.
  it("still reports the invite as successful when the notification fails to send", async () => {
    const app = buildTestApp(getAppOwnerUserId());
    const phone = uniquePhone();
    recordWaitlistRequest(phone);
    vi.mocked(sendProactiveMessage).mockRejectedValueOnce(new Error("meta is down"));

    const res = await request(app).post("/api/admin/invites").send({ phone });

    expect(res.status).toBe(200);
    expect(isPhoneInvited(phone)).toBe(true);
  });
});

// The Admin settings section is gated on isAdmin, not isAppOwner — a cofounder promoted via the
// Portal's Admins tab runs the beta too and needs the same invite/reset/replay/viewer tools.
describe("admin routes for a promoted (non-owner) admin", () => {
  function buildPromotedAdminApp() {
    const admin = findOrCreateUserByEmail(uniqueEmail("promoted-admin"));
    setUserAdmin(admin.id, true);
    return { app: buildTestApp(admin.id), admin };
  }

  it("allows the full invite CRUD cycle", async () => {
    const { app } = buildPromotedAdminApp();
    const phone = uniquePhone();

    expect((await request(app).get("/api/admin/invites")).status).toBe(200);

    const afterAdd = await request(app).post("/api/admin/invites").send({ phone });
    expect(afterAdd.status).toBe(200);
    expect(afterAdd.body.map((r: { phone: string }) => r.phone)).toContain(phone);

    const afterRemove = await request(app).delete(`/api/admin/invites/${phone}`);
    expect(afterRemove.status).toBe(200);
    expect(afterRemove.body.map((r: { phone: string }) => r.phone)).not.toContain(phone);
  });

  it("allows replay-onboarding on their own account", async () => {
    const { app } = buildPromotedAdminApp();

    const res = await request(app).post("/api/admin/replay-onboarding");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("allows the conversation viewer and ip-check", async () => {
    const { app } = buildPromotedAdminApp();

    // 404, not 403: past the gate, just no account bound to that number.
    expect((await request(app).get("/api/admin/messages").query({ phone: uniquePhone() })).status).toBe(404);
    expect((await request(app).get("/api/admin/ip-check")).status).toBe(200);
  });

  it("allows reset-test-phone", async () => {
    const { app } = buildPromotedAdminApp();

    const res = await request(app).post("/api/admin/reset-test-phone").send({ phone: uniquePhone() });

    expect(res.status).toBe(200);
    expect(res.body.hadAccount).toBe(false);
  });

  // Losing the promotion closes the door again on the next request — the check is per-request,
  // not baked into the session.
  it("stops allowing access once the promotion is revoked", async () => {
    const { app, admin } = buildPromotedAdminApp();
    expect((await request(app).get("/api/admin/invites")).status).toBe(200);

    setUserAdmin(admin.id, false);

    expect((await request(app).get("/api/admin/invites")).status).toBe(403);
  });
});

// How many proxy hops to trust is a deployment fact we can't know from here (see
// config.ts's configureTrustProxy) — this endpoint reports what Express actually saw so it can be
// read off a real request instead of guessed.
describe("GET /api/admin/ip-check", () => {
  function buildProxiedTestApp(userId: number) {
    const app = express();
    configureTrustProxy(app, { NODE_ENV: "production" });
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as AuthedRequest).userId = userId;
      next();
    });
    app.use(adminRoutes);
    return app;
  }

  it("rejects a non-admin with 403", async () => {
    const stranger = findOrCreateUserByEmail(uniqueEmail("ip-check-stranger"));

    const res = await request(buildTestApp(stranger.id)).get("/api/admin/ip-check");

    expect(res.status).toBe(403);
  });

  it("reports the forwarded chain, the address the rate limiters use, and the trusted hop count", async () => {
    const app = buildProxiedTestApp(getAppOwnerUserId());

    const res = await request(app)
      .get("/api/admin/ip-check")
      .set("X-Forwarded-For", "203.0.113.7, 10.0.0.1");

    expect(res.status).toBe(200);
    expect(res.body.forwardedFor).toBe("203.0.113.7, 10.0.0.1");
    expect(res.body.chain).toEqual(["203.0.113.7", "10.0.0.1"]);
    // Rightmost entry: the one the hop closest to us added — what a per-visitor limit keys on.
    expect(res.body.rateLimitKey).toBe("10.0.0.1");
    expect(res.body.trustedHops).toBe(1);
  });

  it("reports no trusted hops when the app is not behind a proxy", async () => {
    const res = await request(buildTestApp(getAppOwnerUserId())).get("/api/admin/ip-check");

    expect(res.status).toBe(200);
    expect(res.body.trustedHops).toBe(0);
  });
});
