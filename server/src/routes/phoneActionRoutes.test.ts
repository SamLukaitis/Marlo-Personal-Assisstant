import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../services/phoneActionFollowups.js", () => ({ handleFinishedPhoneAction: vi.fn(async () => {}) }));
process.env.MARLOWE_SHORTCUT_ICLOUD_URL = "https://www.icloud.com/shortcuts/test";

const { phoneActionRoutes } = await import("./phoneActionRoutes.js");
const { createPhoneAction, CHAT_TTL_MS } = await import("../services/phoneActions.js");
const { findOrCreateUserByEmail } = await import("../db/store.js");

const app = express();
app.use(express.json());
app.use(phoneActionRoutes);

let n = 0;
function newCode(steps: unknown[] = [{ type: "get_battery" }], label = "Battery check") {
  const u = findOrCreateUserByEmail(`phone-routes-${Date.now()}-${++n}@example.com`);
  return createPhoneAction(u.id, steps as never, { source: "chat", label, ttlMs: CHAT_TTL_MS }).code;
}

describe("GET /a/:code", () => {
  it("shows the steps, a Run button and an install link, with no session", async () => {
    const res = await request(app).get(`/a/${newCode()}`);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toContain("no-store");
    expect(res.text).toContain("send Marlo your battery level");
    expect(res.text).toContain("shortcuts://run-shortcut?name=Marlo");
    expect(res.text).toContain("https://www.icloud.com/shortcuts/test");
  });

  it("escapes step text", async () => {
    const res = await request(app).get(`/a/${newCode([{ type: "ask", prompt: "<script>x</script>" }], "<b>hi</b>")}`);
    expect(res.text).not.toContain("<script>x</script>");
    expect(res.text).toContain("&lt;script&gt;");
    expect(res.text).not.toContain("<b>hi</b>");
  });

  it("shows an expired message for an unknown code", async () => {
    const res = await request(app).get("/a/nope");
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/expired|already used/i);
  });
});

describe("GET /api/phone-actions/:code", () => {
  it("returns steps once, then 410", async () => {
    const code = newCode();
    const first = await request(app).get(`/api/phone-actions/${code}`).set("X-Marlo-Shortcut", "2");
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ steps: [{ type: "get_battery" }], reportUrl: expect.stringMatching(new RegExp(`/api/phone-actions/${code}/report$`)) });
    const second = await request(app).get(`/api/phone-actions/${code}`).set("X-Marlo-Shortcut", "2");
    expect(second.status).toBe(410);
    expect(second.body.message).toMatch(/already used/);
  });

  it("returns an update for an old version", async () => {
    const res = await request(app).get(`/api/phone-actions/${newCode()}`).set("X-Marlo-Shortcut", "0");
    expect(res.status).toBe(200);
    expect(res.body.update).toMatchObject({ installUrl: "https://www.icloud.com/shortcuts/test" });
  });
});

describe("POST /api/phone-actions/:code/report", () => {
  it("accepts a step report after fetch, 400 on a bad body, 410 when unknown", async () => {
    const code = newCode([{ type: "get_battery" }, { type: "get_location" }]);
    await request(app).get(`/api/phone-actions/${code}`).set("X-Marlo-Shortcut", "2");
    expect((await request(app).post(`/api/phone-actions/${code}/report`).send({ index: 0, ok: true, value: 80 })).status).toBe(200);
    expect((await request(app).post(`/api/phone-actions/${code}/report`).send({ index: "x" })).status).toBe(400);
    expect((await request(app).post(`/api/phone-actions/nope/report`).send({ index: 0, ok: true })).status).toBe(410);
  });
});
