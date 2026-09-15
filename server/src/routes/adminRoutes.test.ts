import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import {
  findOrCreateUserByEmail,
  getAppOwnerUserId,
  addPhoneNumberForUser,
  appendWhatsAppMessage,
  setPendingSetup,
  clearPendingSetup,
} from "../db/store.js";
import type { AuthedRequest } from "../middleware/auth.js";

const { adminRoutes } = await import("./adminRoutes.js");

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
  it("rejects a non-owner with 403", async () => {
    const stranger = findOrCreateUserByEmail(uniqueEmail("not-the-owner"));
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
  it("rejects a non-owner with 403 on every method", async () => {
    const stranger = findOrCreateUserByEmail(uniqueEmail("not-the-owner"));
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
});
