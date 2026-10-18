import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { requireAdmin, type AuthedRequest } from "../middleware/auth.js";
import { findOrCreateUserByEmail, setUserAdmin, addServerLog, listAdminTodos } from "../db/store.js";
import { handleOnboarding } from "../joyce/onboarding.js";
import { flagRequest, recordJoyceUsage } from "../joyce/adminRecords.js";
import type { FamilySession } from "../joyce/familyDb.js";
import { joycePortalRoutes } from "./joycePortalRoutes.js";

// Same shape as portalRoutes.test.ts: a stub for requireAuth, but the REAL requireAdmin, so the
// gate is covered along with the routes.
function buildTestApp(userId: number) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as AuthedRequest).userId = userId;
    next();
  });
  app.use("/api/joyce-portal", requireAdmin, joycePortalRoutes);
  return app;
}

let counter = 0;
function makeUser(prefix: string, admin: boolean) {
  counter += 1;
  const user = findOrCreateUserByEmail(`${prefix}-${Date.now()}-${counter}@example.com`);
  if (admin) setUserAdmin(user.id, true);
  return user;
}

let phoneCounter = 0;
function newFamily(): FamilySession {
  phoneCounter += 1;
  const phone = `1555333${String(phoneCounter).padStart(4, "0")}`;
  handleOnboarding(phone, "hi");
  const outcome = handleOnboarding(phone, "new");
  if (!outcome.done) throw new Error("expected a family to be created");
  return outcome.session;
}

describe("Joyce portal routes", () => {
  it("turns the built-in calendar off and on, and rejects anything but true or false", async () => {
    const app = buildTestApp(makeUser("joyce-admin-settings", true).id);
    expect((await request(app).get("/api/joyce-portal/settings")).body).toEqual({ builtInCalendar: true });

    const off = await request(app).put("/api/joyce-portal/settings").send({ builtInCalendar: false });
    expect(off.body).toEqual({ builtInCalendar: false });
    expect((await request(app).get("/api/joyce-portal/settings")).body).toEqual({ builtInCalendar: false });

    expect((await request(app).put("/api/joyce-portal/settings").send({ builtInCalendar: "off" })).status).toBe(400);

    const on = await request(app).put("/api/joyce-portal/settings").send({ builtInCalendar: true });
    expect(on.body).toEqual({ builtInCalendar: true });
  });

  it("won't let a non-admin change settings", async () => {
    const app = buildTestApp(makeUser("joyce-nonadmin-settings", false).id);
    expect((await request(app).put("/api/joyce-portal/settings").send({ builtInCalendar: false })).status).toBe(403);
  });

  it("refuses anyone who isn't an admin", async () => {
    const user = makeUser("joyce-nonadmin", false);
    const res = await request(buildTestApp(user.id)).get("/api/joyce-portal/unmet-requests");
    expect(res.status).toBe(403);
  });

  it("lists flagged requests with an anonymous family label that's the same for one family", async () => {
    const admin = makeUser("joyce-admin", true);
    const a = newFamily();
    const b = newFamily();
    flagRequest(a, "asked to book a dentist appointment");
    flagRequest(a, "asked to order groceries");
    flagRequest(b, "asked to pay a school bill");

    const res = await request(buildTestApp(admin.id)).get("/api/joyce-portal/unmet-requests");
    expect(res.status).toBe(200);
    const bySummary = new Map(res.body.map((r: { summary: string; channel: string }) => [r.summary, r.channel]));
    const labelA = bySummary.get("asked to book a dentist appointment");
    expect(labelA).toMatch(/^Family [0-9A-F]{6}$/);
    expect(bySummary.get("asked to order groceries")).toBe(labelA);
    expect(bySummary.get("asked to pay a school bill")).not.toBe(labelA);
    // The label is not the family's internal id.
    expect(labelA).not.toContain(a.familyId.slice(0, 6).toUpperCase());
  });

  it("resolves a flagged request and keeps admin notes with the author's email", async () => {
    const admin = makeUser("joyce-admin-notes", true);
    const app = buildTestApp(admin.id);
    flagRequest(newFamily(), "asked to split a restaurant bill");
    const list = await request(app).get("/api/joyce-portal/unmet-requests");
    const id = list.body.find((r: { summary: string }) => r.summary === "asked to split a restaurant bill").id;

    const noted = await request(app)
      .post(`/api/joyce-portal/unmet-requests/${id}/notes`)
      .send({ text: "on the list" });
    const row = noted.body.find((r: { id: number }) => r.id === id);
    expect(row.notes).toEqual([expect.objectContaining({ text: "on the list", authorEmail: admin.email })]);

    await request(app).post(`/api/joyce-portal/unmet-requests/${id}/resolve`);
    const open = await request(app).get("/api/joyce-portal/unmet-requests");
    expect(open.body.some((r: { id: number }) => r.id === id)).toBe(false);
    const all = await request(app).get("/api/joyce-portal/unmet-requests?includeResolved=true");
    expect(all.body.find((r: { id: number }) => r.id === id).resolvedAt).not.toBeNull();
  });

  it("keeps Joyce's to-do list separate from Marlowe's", async () => {
    const admin = makeUser("joyce-admin-todos", true);
    const res = await request(buildTestApp(admin.id))
      .post("/api/joyce-portal/todos")
      .send({ text: "joyce-only to-do" });
    expect(res.body.map((t: { text: string }) => t.text)).toContain("joyce-only to-do");
    expect(listAdminTodos(admin.id).map((t) => t.text)).not.toContain("joyce-only to-do");
    expect(listAdminTodos(admin.id, "joyce").map((t) => t.text)).toContain("joyce-only to-do");
  });

  it("shows only Joyce's log lines", async () => {
    const admin = makeUser("joyce-admin-logs", true);
    addServerLog("error", "joyce: tool save_note failed (portal test)");
    addServerLog("error", "scheduler: something unrelated (portal test)");
    const res = await request(buildTestApp(admin.id)).get("/api/joyce-portal/logs");
    const messages = res.body.map((l: { message: string }) => l.message);
    expect(messages).toContain("joyce: tool save_note failed (portal test)");
    expect(messages).not.toContain("scheduler: something unrelated (portal test)");
  });

  it("reports Joyce's usage totals with a cost estimate and no per-family breakdown", async () => {
    const admin = makeUser("joyce-admin-usage", true);
    recordJoyceUsage("claude-sonnet-5", "joyce_chat", { input_tokens: 1000, output_tokens: 200 });
    recordJoyceUsage("claude-sonnet-5", "joyce_file_reading", { input_tokens: 3000, output_tokens: 100 });
    const res = await request(buildTestApp(admin.id)).get("/api/joyce-portal/usage");
    expect(res.status).toBe(200);
    expect(res.body.byOwner).toEqual([]);
    expect(res.body.byPurpose.map((p: { purpose: string }) => p.purpose).sort()).toEqual([
      "joyce_chat",
      "joyce_file_reading",
    ]);
    expect(res.body.rows[0].estimatedCost).toBeGreaterThan(0);
    expect(res.body.recent[0]).toEqual(expect.objectContaining({ channel: "whatsapp", ownerId: null }));
  });
});
