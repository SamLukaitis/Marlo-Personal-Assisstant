import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { alertRoutes } from "./alertRoutes.js";
import { findOrCreateUserByEmail, getSetting } from "../db/store.js";
import type { AuthedRequest } from "../middleware/auth.js";

function buildTestApp(userId: number) {
  const app = express();
  app.use(express.json());
  // Stub in place of requireAuth — real auth is exercised elsewhere (see toolsRoutes.test.ts's
  // "auth gating" block); this test is about the routes' own logic.
  app.use((req, _res, next) => {
    (req as unknown as AuthedRequest).userId = userId;
    next();
  });
  app.use(alertRoutes);
  return app;
}

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

describe("real-person alert settings", () => {
  it("defaults to enabled:true for a user who has never touched the setting", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("person-default-on"));
    const res = await request(buildTestApp(user.id)).get("/api/alerts/settings");
    expect(res.body).toEqual({ enabled: true });
  });

  it("persists an explicit opt-out and reports it back", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("person-opt-out"));
    const app = buildTestApp(user.id);
    await request(app).put("/api/alerts/settings").send({ enabled: false });
    expect(getSetting(user.id, "realtime_alerts_enabled")).toBe("false");
    expect((await request(app).get("/api/alerts/settings")).body).toEqual({ enabled: false });
  });
});

describe("GET /api/important-email-alerts/settings", () => {
  it("defaults to enabled:true for a user who has never touched the setting", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("default-on"));
    const app = buildTestApp(user.id);

    const res = await request(app).get("/api/important-email-alerts/settings");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true });
  });
});

describe("PUT /api/important-email-alerts/settings", () => {
  it("persists an explicit opt-out", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("opt-out"));
    const app = buildTestApp(user.id);

    const putRes = await request(app).put("/api/important-email-alerts/settings").send({ enabled: false });
    expect(putRes.status).toBe(200);
    expect(getSetting(user.id, "important_email_alerts_enabled")).toBe("false");

    const getRes = await request(app).get("/api/important-email-alerts/settings");
    expect(getRes.body).toEqual({ enabled: false });
  });

  it("reflects re-enabling after an opt-out immediately", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("re-enable"));
    const app = buildTestApp(user.id);

    await request(app).put("/api/important-email-alerts/settings").send({ enabled: false });
    await request(app).put("/api/important-email-alerts/settings").send({ enabled: true });

    const getRes = await request(app).get("/api/important-email-alerts/settings");
    expect(getRes.body).toEqual({ enabled: true });
  });
});
