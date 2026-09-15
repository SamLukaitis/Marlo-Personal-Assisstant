import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { findOrCreateUserByEmail, listPhoneNumbersForUser } from "../db/store.js";
import type { AuthedRequest } from "../middleware/auth.js";

const { whatsappSettingsRoutes } = await import("./whatsappSettingsRoutes.js");

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}
function uniquePhone(): string {
  counter += 1;
  return `4478${String(Date.now()).slice(-6)}${counter}`;
}

function buildTestApp(userId: number) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as AuthedRequest).userId = userId;
    next();
  });
  app.use(whatsappSettingsRoutes);
  return app;
}

// Regression coverage for a real incident: the account's registered-numbers list is
// replace-the-whole-array (whatsappSettingsRoutes.ts), but the old client UI let a user *add* to
// it indefinitely, and every number on the list receives every proactive alert — not just the
// ones the account owner meant to keep using. A stale old number and, in one real case, a
// cofounder's personal number both stayed registered and kept getting the account owner's private
// email alerts. Capping this server-side at one number is defense in depth, independent of
// whatever the client sends.
describe("PUT /api/whatsapp/allowed-numbers", () => {
  it("accepts a single number", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("wa-settings-single"));
    const app = buildTestApp(user.id);
    const phone = uniquePhone();

    const res = await request(app).put("/api/whatsapp/allowed-numbers").send({ numbers: [phone] });

    expect(res.status).toBe(200);
    expect(listPhoneNumbersForUser(user.id).map((r) => r.phone)).toEqual([phone.replace(/\D/g, "")]);
  });

  it("rejects more than one number with 400, unchanged", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("wa-settings-multi"));
    const app = buildTestApp(user.id);

    const res = await request(app)
      .put("/api/whatsapp/allowed-numbers")
      .send({ numbers: [uniquePhone(), uniquePhone()] });

    expect(res.status).toBe(400);
    expect(listPhoneNumbersForUser(user.id)).toHaveLength(0);
  });

  it("replaces the existing number with a new one rather than adding to it", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("wa-settings-replace"));
    const app = buildTestApp(user.id);
    const first = uniquePhone();
    const second = uniquePhone();

    await request(app).put("/api/whatsapp/allowed-numbers").send({ numbers: [first] });
    const res = await request(app).put("/api/whatsapp/allowed-numbers").send({ numbers: [second] });

    expect(res.status).toBe(200);
    expect(listPhoneNumbersForUser(user.id).map((r) => r.phone)).toEqual([second.replace(/\D/g, "")]);
  });

  it("allows clearing to zero numbers", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("wa-settings-clear"));
    const app = buildTestApp(user.id);
    await request(app).put("/api/whatsapp/allowed-numbers").send({ numbers: [uniquePhone()] });

    const res = await request(app).put("/api/whatsapp/allowed-numbers").send({ numbers: [] });

    expect(res.status).toBe(200);
    expect(listPhoneNumbersForUser(user.id)).toHaveLength(0);
  });

  it("still rejects a number already registered to a different account", async () => {
    const owner = findOrCreateUserByEmail(uniqueEmail("wa-settings-owner"));
    const other = findOrCreateUserByEmail(uniqueEmail("wa-settings-other"));
    const phone = uniquePhone();
    await request(buildTestApp(owner.id)).put("/api/whatsapp/allowed-numbers").send({ numbers: [phone] });

    const res = await request(buildTestApp(other.id))
      .put("/api/whatsapp/allowed-numbers")
      .send({ numbers: [phone] });

    expect(res.status).toBe(409);
    expect(listPhoneNumbersForUser(other.id)).toHaveLength(0);
  });
});
