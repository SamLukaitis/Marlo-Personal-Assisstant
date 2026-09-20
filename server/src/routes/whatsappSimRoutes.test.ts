import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { findOrCreateUserByEmail, listPhoneNumbersForUser } from "../db/store.js";
import { simulatedPhoneForOwner } from "../providers/whatsapp.js";
import type { AuthedRequest } from "../middleware/auth.js";

// handleIncoming itself (registration, batching, tool calls, ...) is already covered by
// whatsappRoutes.test.ts — this file only needs to prove the route layer wires into it correctly:
// real userId -> real phone binding -> a correctly-shaped IncomingTextMessage.
vi.mock("./whatsappRoutes.js", () => ({
  handleIncoming: vi.fn().mockResolvedValue(undefined),
}));

const { whatsappSimRoutes } = await import("./whatsappSimRoutes.js");
const { handleIncoming } = await import("./whatsappRoutes.js");

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

beforeEach(() => {
  vi.mocked(handleIncoming).mockClear();
});

describe("POST /whatsapp-sim/send", () => {
  it("binds the reserved sim number to the caller's account and forwards the message to handleIncoming", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("wa-sim"));
    const app = buildTestApp(user.id);
    const phone = simulatedPhoneForOwner(user.id);

    const res = await request(app).post("/whatsapp-sim/send").send({ text: "hello from the simulator" });

    expect(res.status).toBe(202);
    expect(res.body.phone).toBe(phone);
    expect(listPhoneNumbersForUser(user.id).map((r) => r.phone)).toContain(phone);
    expect(handleIncoming).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(handleIncoming).mock.calls[0][0];
    expect(arg).toMatchObject({ kind: "text", from: phone, text: "hello from the simulator" });
    expect((arg as { messageId: string }).messageId).toMatch(/^sim-/);
  });

  it("rejects an empty message with 400 and never calls handleIncoming", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("wa-sim-empty"));
    const app = buildTestApp(user.id);

    const res = await request(app).post("/whatsapp-sim/send").send({ text: "   " });

    expect(res.status).toBe(400);
    expect(handleIncoming).not.toHaveBeenCalled();
  });

  it("is idempotent — sending twice doesn't duplicate the phone binding", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("wa-sim-twice"));
    const app = buildTestApp(user.id);

    await request(app).post("/whatsapp-sim/send").send({ text: "first" });
    await request(app).post("/whatsapp-sim/send").send({ text: "second" });

    const phone = simulatedPhoneForOwner(user.id);
    expect(listPhoneNumbersForUser(user.id).filter((r) => r.phone === phone)).toHaveLength(1);
  });
});
