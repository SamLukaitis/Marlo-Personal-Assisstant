import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { toolsRoutes } from "./toolsRoutes.js";
import { findOrCreateUserByEmail, getEnabledTools } from "../db/store.js";
import type { AuthedRequest } from "../middleware/auth.js";

function buildTestApp(userId: number) {
  const app = express();
  app.use(express.json());
  // Stub in place of requireAuth — real auth (cookies/sessions) is exercised elsewhere; this
  // test is about the tools routes' own logic, not the auth middleware.
  app.use((req, _res, next) => {
    (req as unknown as AuthedRequest).userId = userId;
    next();
  });
  app.use(toolsRoutes);
  return app;
}

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

describe("GET /api/tools", () => {
  it("lists the catalog with enabled:false for a user with nothing turned on", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("list-none"));
    const app = buildTestApp(user.id);
    const res = await request(app).get("/api/tools");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        key: "teams",
        label: "Microsoft Teams chat",
        description: "Let your assistant read and search your Teams conversations.",
        enabled: false,
      },
      {
        key: "travel",
        label: "Travel / Schengen day tracker",
        description:
          "Track location check-ins and count days spent in a country or the Schengen area.",
        enabled: false,
      },
    ]);
  });
});

describe("PUT /api/tools/:key", () => {
  it("enables a tool and persists it", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("enable"));
    const app = buildTestApp(user.id);
    const res = await request(app).put("/api/tools/teams").send({ enabled: true });
    expect(res.status).toBe(200);
    expect(getEnabledTools(user.id)).toEqual(new Set(["teams"]));
  });

  it("disables a previously enabled tool", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("disable"));
    const app = buildTestApp(user.id);
    await request(app).put("/api/tools/travel").send({ enabled: true });
    const res = await request(app).put("/api/tools/travel").send({ enabled: false });
    expect(res.status).toBe(200);
    expect(getEnabledTools(user.id)).toEqual(new Set());
  });

  it("rejects an unknown tool key with 400", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("bad-key"));
    const app = buildTestApp(user.id);
    const res = await request(app).put("/api/tools/finance").send({ enabled: true });
    expect(res.status).toBe(400);
  });
});
