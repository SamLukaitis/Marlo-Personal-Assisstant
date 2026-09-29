import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import {
  addPhoneNumberForUser,
  findOrCreateUserByEmail,
  isPhoneInvited,
  listPhoneNumbersForUser,
  recordInboundMessage,
  resolveOwnerByPhone,
} from "../db/store.js";
import { newSimulatedTestUserPhone, simulatedPhoneForOwner } from "../providers/whatsapp.js";
import { getSimTranscript, recordSimMessage } from "../providers/whatsappSimTranscript.js";
import type { AuthedRequest } from "../middleware/auth.js";

// handleIncoming itself (registration, batching, tool calls, ...) is already covered by
// whatsappRoutes.test.ts — this file only needs to prove the route layer wires into it correctly:
// real userId -> the right simulated number -> a correctly-shaped inbound message.
vi.mock("./whatsappRoutes.js", () => ({
  handleIncoming: vi.fn().mockResolvedValue(undefined),
}));

// Composing the briefing is scheduler.ts/briefing.ts's job (and their tests') — it makes a real
// LLM call. Stubbing it here leaves what this route layer is actually responsible for: building
// for the right account, forcing a fresh build, and handing the text to the real proactive send.
vi.mock("../services/scheduler.js", () => ({
  composeDailyBriefingMessage: vi.fn().mockResolvedValue("Sunny. 3 unread. Nothing on today."),
}));

const { whatsappSimRoutes } = await import("./whatsappSimRoutes.js");
const { handleIncoming } = await import("./whatsappRoutes.js");
const { composeDailyBriefingMessage } = await import("../services/scheduler.js");

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

function buildTestApp(userId: number) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as AuthedRequest).userId = userId;
    next();
  });
  app.use(whatsappSimRoutes);
  return app;
}

function newAdminApp(prefix: string) {
  const user = findOrCreateUserByEmail(uniqueEmail(prefix));
  return { user, app: buildTestApp(user.id) };
}

beforeEach(() => {
  vi.mocked(handleIncoming).mockClear();
  vi.mocked(composeDailyBriefingMessage).mockClear();
});

describe("POST /whatsapp-sim/send — chat as me", () => {
  it("binds the reserved sim number to the caller's account and forwards the message to handleIncoming", async () => {
    const { user, app } = newAdminApp("wa-sim");
    const phone = simulatedPhoneForOwner(user.id);

    const res = await request(app).post("/whatsapp-sim/send").send({ text: "hello from the simulator" });

    expect(res.status).toBe(202);
    expect(res.body.phone).toBe(phone);
    expect(listPhoneNumbersForUser(user.id).map((r) => r.phone)).toContain(phone);
    expect(handleIncoming).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(handleIncoming).mock.calls[0][0];
    expect(arg).toMatchObject({ kind: "text", from: phone, text: "hello from the simulator" });
    expect((arg as { messageId: string }).messageId).toMatch(/^sim-/);
    expect(getSimTranscript(phone).map((e) => [e.role, e.text])).toEqual([["user", "hello from the simulator"]]);
  });

  it("rejects an empty message with 400 and never calls handleIncoming", async () => {
    const { app } = newAdminApp("wa-sim-empty");

    const res = await request(app).post("/whatsapp-sim/send").send({ text: "   " });

    expect(res.status).toBe(400);
    expect(handleIncoming).not.toHaveBeenCalled();
  });

  it("is idempotent — sending twice doesn't duplicate the phone binding", async () => {
    const { user, app } = newAdminApp("wa-sim-twice");

    await request(app).post("/whatsapp-sim/send").send({ text: "first" });
    await request(app).post("/whatsapp-sim/send").send({ text: "second" });

    const phone = simulatedPhoneForOwner(user.id);
    expect(listPhoneNumbersForUser(user.id).filter((r) => r.phone === phone)).toHaveLength(1);
  });

  it("sends a tapped button as a button reply, recorded by its label", async () => {
    const { user, app } = newAdminApp("wa-sim-tap");
    const phone = simulatedPhoneForOwner(user.id);

    const res = await request(app)
      .post("/whatsapp-sim/send")
      .send({ buttonId: "provider_gmail", label: "Gmail" });

    expect(res.status).toBe(202);
    const arg = vi.mocked(handleIncoming).mock.calls[0][0];
    expect(arg).toMatchObject({ kind: "interactive", from: phone, buttonId: "provider_gmail" });
    expect(getSimTranscript(phone).at(-1)?.text).toBe("[tapped Gmail]");
  });

  it("sends a shared location as a location message", async () => {
    const { user, app } = newAdminApp("wa-sim-location");
    const phone = simulatedPhoneForOwner(user.id);

    const res = await request(app).post("/whatsapp-sim/send").send({ latitude: 51.5308, longitude: -0.1238 });

    expect(res.status).toBe(202);
    const arg = vi.mocked(handleIncoming).mock.calls[0][0];
    expect(arg).toMatchObject({ kind: "location", from: phone, latitude: 51.5308, longitude: -0.1238 });
    expect(getSimTranscript(phone).at(-1)?.text).toBe("[shared location 51.5308, -0.1238]");
  });

  it("rejects an out-of-range or half-specified location with 400", async () => {
    const { app } = newAdminApp("wa-sim-location-bad");

    for (const body of [{ latitude: 91, longitude: 0 }, { latitude: 10 }, { latitude: "x", longitude: 1 }]) {
      const res = await request(app).post("/whatsapp-sim/send").send(body);
      expect(res.status).toBe(400);
    }
    expect(handleIncoming).not.toHaveBeenCalled();
  });

  it("refuses to drive a number that is neither the caller's own nor a simulator test user", async () => {
    const { app } = newAdminApp("wa-sim-foreign");

    const other = await request(app).post("/whatsapp-sim/send").send({ text: "hi", phone: "447000000001" });
    const otherAdmin = await request(app)
      .post("/whatsapp-sim/send")
      .send({ text: "hi", phone: simulatedPhoneForOwner(999_999) });

    expect(other.status).toBe(400);
    expect(otherAdmin.status).toBe(400);
    expect(handleIncoming).not.toHaveBeenCalled();
  });
});

describe("simulator test users", () => {
  it("creates an invited, unbound test number that goes through signup rather than the caller's account", async () => {
    const { user, app } = newAdminApp("wa-sim-new");

    const created = await request(app).post("/whatsapp-sim/test-users");
    expect(created.status).toBe(201);
    const phone: string = created.body.phone;
    expect(phone).toMatch(/^999100\d{6}$/);
    expect(isPhoneInvited(phone)).toBe(true);
    expect(resolveOwnerByPhone(phone)).toBeNull();

    const list = await request(app).get("/whatsapp-sim/test-users");
    expect(list.body).toContainEqual(expect.objectContaining({ phone, hasAccount: false }));

    const res = await request(app).post("/whatsapp-sim/send").send({ text: "hi", phone });
    expect(res.status).toBe(202);
    expect(vi.mocked(handleIncoming).mock.calls[0][0]).toMatchObject({ kind: "text", from: phone });
    // Never bound to the operator's own account — handleIncoming's registration flow owns it.
    expect(listPhoneNumbersForUser(user.id).map((r) => r.phone)).not.toContain(phone);
    expect(resolveOwnerByPhone(phone)).toBeNull();
  });

  it("refuses to send as a test-user number that was never created (or was deleted)", async () => {
    const { app } = newAdminApp("wa-sim-unknown");

    const res = await request(app).post("/whatsapp-sim/send").send({ text: "hi", phone: newSimulatedTestUserPhone() });

    expect(res.status).toBe(404);
    expect(handleIncoming).not.toHaveBeenCalled();
  });

  it("delete wipes the test user's account, invite and transcript", async () => {
    const { app } = newAdminApp("wa-sim-del");
    const { phone } = (await request(app).post("/whatsapp-sim/test-users")).body as { phone: string };
    // Stand in for a completed signup: an account bound to the test number.
    const testUser = findOrCreateUserByEmail(uniqueEmail("wa-sim-signedup"));
    addPhoneNumberForUser(testUser.id, phone);
    recordSimMessage(phone, { role: "assistant", text: "welcome" });

    const res = await request(app).delete(`/whatsapp-sim/test-users/${phone}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, hadAccount: true });
    expect(resolveOwnerByPhone(phone)).toBeNull();
    expect(isPhoneInvited(phone)).toBe(false);
    expect(getSimTranscript(phone)).toEqual([]);
  });

  it("delete refuses anything that isn't a simulator test-user number", async () => {
    const { user, app } = newAdminApp("wa-sim-del-guard");

    const own = await request(app).delete(`/whatsapp-sim/test-users/${simulatedPhoneForOwner(user.id)}`);
    const real = await request(app).delete("/whatsapp-sim/test-users/447000000001");

    expect(own.status).toBe(400);
    expect(real.status).toBe(400);
  });
});

describe("GET /whatsapp-sim/transcript", () => {
  it("returns the recorded conversation for the caller's own number", async () => {
    const { user, app } = newAdminApp("wa-sim-transcript");
    const phone = simulatedPhoneForOwner(user.id);
    recordSimMessage(phone, { role: "assistant", text: "Gmail or Outlook?", choices: [{ id: "g", title: "Gmail" }] });

    const res = await request(app).get("/whatsapp-sim/transcript");

    expect(res.status).toBe(200);
    expect(res.body.phone).toBe(phone);
    expect(res.body.entries).toEqual([
      expect.objectContaining({ role: "assistant", text: "Gmail or Outlook?", choices: [{ id: "g", title: "Gmail" }] }),
    ]);
  });

  it("refuses a number that isn't the caller's own or a known test user", async () => {
    const { app } = newAdminApp("wa-sim-transcript-guard");

    const res = await request(app).get("/whatsapp-sim/transcript?phone=447000000001");

    expect(res.status).toBe(400);
  });
});

// The simulator's "Send daily briefing" button — the loop for iterating on briefing content/style
// without waiting for the scheduled send.
describe("POST /whatsapp-sim/briefing", () => {
  it("builds a fresh briefing for the caller's account and delivers it to their sim number", async () => {
    const { user, app } = newAdminApp("wa-sim-brief");
    const phone = simulatedPhoneForOwner(user.id);
    addPhoneNumberForUser(user.id, phone);
    // An inbound message on record means the 24h free-form window is open, so the briefing goes
    // out as ordinary chat text rather than the template.
    recordInboundMessage(phone);

    const res = await request(app).post("/whatsapp-sim/briefing");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    // `true` is the refresh flag: every press must rebuild, not replay today's stored briefing.
    expect(composeDailyBriefingMessage).toHaveBeenCalledWith(user.id, true);
    expect(getSimTranscript(phone).at(-1)).toMatchObject({
      role: "assistant",
      text: "Sunny. 3 unread. Nothing on today.",
    });
  });

  it("binds the caller's sim number on first use, like /send does", async () => {
    const { user, app } = newAdminApp("wa-sim-brief-bind");

    const res = await request(app).post("/whatsapp-sim/briefing");

    expect(res.status).toBe(200);
    expect(listPhoneNumbersForUser(user.id).map((r) => r.phone)).toContain(simulatedPhoneForOwner(user.id));
  });

  it("falls back to the digest template when the free-form window is closed, as a real send would", async () => {
    const { user, app } = newAdminApp("wa-sim-brief-template");
    const phone = simulatedPhoneForOwner(user.id);

    const res = await request(app).post("/whatsapp-sim/briefing");

    expect(res.status).toBe(200);
    expect(getSimTranscript(phone).at(-1)?.text).toBe("[template marlowe_digest] Sunny. 3 unread. Nothing on today.");
  });

  it("builds for the test user's own account, not the caller's", async () => {
    const { app } = newAdminApp("wa-sim-brief-testuser");
    const { phone } = (await request(app).post("/whatsapp-sim/test-users")).body as { phone: string };
    const testUser = findOrCreateUserByEmail(uniqueEmail("wa-sim-brief-signedup"));
    addPhoneNumberForUser(testUser.id, phone);

    const res = await request(app).post("/whatsapp-sim/briefing").send({ phone });

    expect(res.status).toBe(200);
    expect(composeDailyBriefingMessage).toHaveBeenCalledWith(testUser.id, true);
  });

  it("refuses a test user that hasn't signed up yet with 409 and never builds", async () => {
    const { app } = newAdminApp("wa-sim-brief-nosignup");
    const { phone } = (await request(app).post("/whatsapp-sim/test-users")).body as { phone: string };

    const res = await request(app).post("/whatsapp-sim/briefing").send({ phone });

    expect(res.status).toBe(409);
    expect(composeDailyBriefingMessage).not.toHaveBeenCalled();
  });

  it("refuses a number that is neither the caller's own nor a simulator test user", async () => {
    const { app } = newAdminApp("wa-sim-brief-foreign");

    const res = await request(app).post("/whatsapp-sim/briefing").send({ phone: "447000000001" });

    expect(res.status).toBe(400);
    expect(composeDailyBriefingMessage).not.toHaveBeenCalled();
  });

  it("surfaces a failed build as a 500 rather than silently sending nothing", async () => {
    const { app } = newAdminApp("wa-sim-brief-fail");
    vi.mocked(composeDailyBriefingMessage).mockRejectedValueOnce(new Error("ANTHROPIC_API_KEY is not set"));

    const res = await request(app).post("/whatsapp-sim/briefing");

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("ANTHROPIC_API_KEY is not set");
  });
});
