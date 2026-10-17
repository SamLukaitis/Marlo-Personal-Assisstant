import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { requireAdmin } from "../middleware/auth.js";
import {
  findOrCreateUserByEmail,
  setUserAdmin,
  addUnmetRequest,
  addServerLog,
  getServerLog,
  recordApiUsage,
  insertPhoneAction,
  updatePhoneAction,
} from "../db/store.js";
import type { AuthedRequest } from "../middleware/auth.js";

vi.mock("../ai/assistant.js", async () => {
  const actual = await vi.importActual<typeof import("../ai/assistant.js")>("../ai/assistant.js");
  return {
    ...actual,
    getClient: vi.fn(() => ({
      messages: {
        create: vi.fn(async () => ({
          content: [{ type: "text", text: "This looks like a one-off network blip, not a real bug." }],
        })),
      },
    })),
  };
});

const { portalRoutes } = await import("./portalRoutes.js");
const { getClient } = await import("../ai/assistant.js");

// Mirrors toolsRoutes.test.ts's pattern: stub in place of requireAuth (real session handling is
// exercised elsewhere), but include the REAL requireAdmin so each route's own gating is covered,
// not just its business logic.
function buildTestApp(userId: number) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as AuthedRequest).userId = userId;
    next();
  });
  app.use("/api/portal", requireAdmin, portalRoutes);
  return app;
}

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

function makeAdmin(prefix: string) {
  const user = findOrCreateUserByEmail(uniqueEmail(prefix));
  setUserAdmin(user.id, true);
  return user;
}

beforeEach(() => {
  vi.mocked(getClient).mockClear();
});

describe("requireAdmin gating", () => {
  it("rejects a non-admin with 403", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("plain"));
    const app = buildTestApp(user.id);
    const res = await request(app).get("/api/portal/todos");
    expect(res.status).toBe(403);
  });

  it("allows a promoted admin", async () => {
    const admin = makeAdmin("promoted");
    const app = buildTestApp(admin.id);
    const res = await request(app).get("/api/portal/todos");
    expect(res.status).toBe(200);
  });

  it("allows the app owner even without the is_admin flag set", async () => {
    // getAppOwnerUserId() defaults to samlukaitis5@gmail.com when APP_OWNER_EMAIL is unset (see
    // store.ts) — findOrCreateUserByEmail on that address gets/creates the same owner row tests
    // and the app itself would resolve to.
    const owner = findOrCreateUserByEmail("samlukaitis5@gmail.com");
    const app = buildTestApp(owner.id);
    const res = await request(app).get("/api/portal/todos");
    expect(res.status).toBe(200);
  });
});

describe("admins", () => {
  it("grants and then revokes admin status for another user", async () => {
    const admin = makeAdmin("granter");
    const target = findOrCreateUserByEmail(uniqueEmail("target"));
    const app = buildTestApp(admin.id);

    const grantRes = await request(app).post(`/api/portal/admins/${target.id}`);
    expect(grantRes.status).toBe(200);
    expect(grantRes.body.find((c: { id: number }) => c.id === target.id).isAdmin).toBe(true);

    const revokeRes = await request(app).delete(`/api/portal/admins/${target.id}`);
    expect(revokeRes.status).toBe(200);
    expect(revokeRes.body.find((c: { id: number }) => c.id === target.id).isAdmin).toBe(false);
  });

  it("refuses to revoke the app owner", async () => {
    const admin = makeAdmin("owner-guard");
    const owner = findOrCreateUserByEmail("samlukaitis5@gmail.com");
    const app = buildTestApp(admin.id);
    const res = await request(app).delete(`/api/portal/admins/${owner.id}`);
    expect(res.status).toBe(400);
  });
});

describe("unmet requests", () => {
  it("lists open ones and resolves them", async () => {
    const admin = makeAdmin("requests");
    const someUser = findOrCreateUserByEmail(uniqueEmail("asker"));
    addUnmetRequest(someUser.id, "Wanted to book a flight, no booking tool exists", "web");
    const app = buildTestApp(admin.id);

    const listRes = await request(app).get("/api/portal/unmet-requests");
    expect(listRes.status).toBe(200);
    expect(listRes.body.length).toBeGreaterThan(0);
    const id = listRes.body[0].id;

    const resolveRes = await request(app).post(`/api/portal/unmet-requests/${id}/resolve`);
    expect(resolveRes.status).toBe(200);

    const afterRes = await request(app).get("/api/portal/unmet-requests");
    expect(afterRes.body.find((r: { id: number }) => r.id === id)).toBeUndefined();
  });
});

describe("todos", () => {
  it("adds, marks done, and deletes a todo", async () => {
    const admin = makeAdmin("todos");
    const app = buildTestApp(admin.id);

    const addRes = await request(app).post("/api/portal/todos").send({ text: "Fix the thing" });
    expect(addRes.status).toBe(200);
    const todo = addRes.body.find((t: { text: string }) => t.text === "Fix the thing");
    expect(todo.done).toBe(false);
    expect(todo.replies).toEqual([]);
    expect(todo.unreadReplyCount).toBe(0);

    const doneRes = await request(app).put(`/api/portal/todos/${todo.id}`).send({ done: true });
    expect(doneRes.body.find((t: { id: number }) => t.id === todo.id).done).toBe(true);

    const delRes = await request(app).delete(`/api/portal/todos/${todo.id}`);
    expect(delRes.body.find((t: { id: number }) => t.id === todo.id)).toBeUndefined();
  });

  it("lets another admin reply, and shows the reply with author + unread count to the poster", async () => {
    const poster = makeAdmin("todo-poster");
    const replier = makeAdmin("todo-replier");
    const posterApp = buildTestApp(poster.id);
    const replierApp = buildTestApp(replier.id);

    const addRes = await request(posterApp).post("/api/portal/todos").send({ text: "Investigate the spike" });
    const todo = addRes.body.find((t: { text: string }) => t.text === "Investigate the spike");

    const replyRes = await request(replierApp)
      .post(`/api/portal/todos/${todo.id}/replies`)
      .send({ text: "Already found it, see the commit" });
    expect(replyRes.status).toBe(200);
    const afterReply = replyRes.body.find((t: { id: number }) => t.id === todo.id);
    expect(afterReply.replies).toHaveLength(1);
    expect(afterReply.replies[0]).toMatchObject({
      text: "Already found it, see the commit",
      authorEmail: replier.email,
    });

    // The poster hasn't read it yet — GET as the poster should show 1 unread.
    const posterView = await request(posterApp).get("/api/portal/todos");
    const posterTodo = posterView.body.find((t: { id: number }) => t.id === todo.id);
    expect(posterTodo.unreadReplyCount).toBe(1);

    // Posting implies having read up through your own reply — the replier sees 0 unread without
    // an explicit read-mark, while the poster (who did nothing) still sees 1. Confirms unread
    // counts are computed per-viewer, not shared.
    const replierView = await request(replierApp).get("/api/portal/todos");
    const replierTodo = replierView.body.find((t: { id: number }) => t.id === todo.id);
    expect(replierTodo.unreadReplyCount).toBe(0);
  });

  it("clears unreadReplyCount for the caller only after marking read", async () => {
    const poster = makeAdmin("todo-read-poster");
    const replier = makeAdmin("todo-read-replier");
    const posterApp = buildTestApp(poster.id);
    const replierApp = buildTestApp(replier.id);

    const addRes = await request(posterApp).post("/api/portal/todos").send({ text: "Ship the fix" });
    const todo = addRes.body.find((t: { text: string }) => t.text === "Ship the fix");
    await request(replierApp).post(`/api/portal/todos/${todo.id}/replies`).send({ text: "On it" });

    const readRes = await request(posterApp).post(`/api/portal/todos/${todo.id}/read`);
    expect(readRes.status).toBe(200);
    expect(readRes.body.find((t: { id: number }) => t.id === todo.id).unreadReplyCount).toBe(0);

    // A second reply after the read-mark should be unread again for the poster.
    await request(replierApp).post(`/api/portal/todos/${todo.id}/replies`).send({ text: "Deployed" });
    const afterSecond = await request(posterApp).get("/api/portal/todos");
    expect(afterSecond.body.find((t: { id: number }) => t.id === todo.id).unreadReplyCount).toBe(1);
  });

  it("never counts an admin's own just-sent reply as unread to themselves", async () => {
    const poster = makeAdmin("todo-self-read-poster");
    const app = buildTestApp(poster.id);

    const addRes = await request(app).post("/api/portal/todos").send({ text: "Write the docs" });
    const todo = addRes.body[0];

    const replyRes = await request(app).post(`/api/portal/todos/${todo.id}/replies`).send({ text: "Started on it" });
    expect(replyRes.body.find((t: { id: number }) => t.id === todo.id).unreadReplyCount).toBe(0);
  });

  it("rejects an empty reply", async () => {
    const admin = makeAdmin("todo-empty-reply");
    const app = buildTestApp(admin.id);
    const addRes = await request(app).post("/api/portal/todos").send({ text: "Something" });
    const todo = addRes.body[0];

    const res = await request(app).post(`/api/portal/todos/${todo.id}/replies`).send({ text: "   " });
    expect(res.status).toBe(400);
  });
});

describe("poster notes", () => {
  it("adds and deletes a note", async () => {
    const admin = makeAdmin("notes");
    const app = buildTestApp(admin.id);

    const addRes = await request(app).post("/api/portal/notes").send({ text: "Standup moved to 10am" });
    expect(addRes.status).toBe(200);
    const note = addRes.body.find((n: { text: string }) => n.text === "Standup moved to 10am");
    expect(note.authorEmail).toBeTruthy();

    const delRes = await request(app).delete(`/api/portal/notes/${note.id}`);
    expect(delRes.status).toBe(200);
  });
});

describe("logs explain", () => {
  it("calls Claude on a cache miss and caches the result", async () => {
    const admin = makeAdmin("logs-miss");
    addServerLog("error", "scheduler: alerts check failed for user 1");
    const app = buildTestApp(admin.id);

    const logsRes = await request(app).get("/api/portal/logs?limit=1");
    const logId = logsRes.body[0].id;

    const explainRes = await request(app).post(`/api/portal/logs/${logId}/explain`);
    expect(explainRes.status).toBe(200);
    expect(explainRes.body.cached).toBe(false);
    expect(getClient).toHaveBeenCalledTimes(1);
    expect(getServerLog(logId)?.explanation).toBe(explainRes.body.explanation);
  });

  it("returns the cached explanation on a second call without calling Claude again", async () => {
    const admin = makeAdmin("logs-hit");
    addServerLog("error", "assistant: tool \"foo\" threw");
    const app = buildTestApp(admin.id);
    const logsRes = await request(app).get("/api/portal/logs?limit=1");
    const logId = logsRes.body[0].id;

    await request(app).post(`/api/portal/logs/${logId}/explain`);
    vi.mocked(getClient).mockClear();
    const secondRes = await request(app).post(`/api/portal/logs/${logId}/explain`);
    expect(secondRes.status).toBe(200);
    expect(secondRes.body.cached).toBe(true);
    expect(getClient).not.toHaveBeenCalled();
  });
});

describe("usage", () => {
  it("shows message text only for admins' own chats, and messagesOnly lists just those", async () => {
    const admin = makeAdmin("usage-messages");
    const demoted = makeAdmin("usage-messages-demoted");
    const someUser = findOrCreateUserByEmail(uniqueEmail("usage-messages-owner"));
    recordApiUsage(admin.id, "whatsapp", "claude-sonnet-5", "usage_messages_test_marker", 1, 2, 3, 4, {
      userMessage: "what's on today?",
      replyText: "Two meetings.",
    });
    recordApiUsage(demoted.id, "whatsapp", "claude-sonnet-5", "usage_messages_test_marker", 1, 2, 3, 4, {
      userMessage: "old admin message",
      replyText: "old reply",
    });
    setUserAdmin(demoted.id, false);
    // Even if text somehow reached a non-admin's row, the API must not hand it out.
    recordApiUsage(someUser.id, "whatsapp", "claude-sonnet-5", "usage_messages_test_marker", 1, 2, 3, 4, {
      userMessage: "private",
      replyText: "private reply",
    });
    const app = buildTestApp(admin.id);

    const all = await request(app).get("/api/portal/usage?days=1&recentLimit=200");
    const byOwner = (id: number) => all.body.recent.find((r: { ownerId: number }) => r.ownerId === id);
    expect(byOwner(admin.id)).toMatchObject({ userMessage: "what's on today?", replyText: "Two meetings." });
    expect(byOwner(demoted.id)).toMatchObject({ userMessage: null, replyText: null });
    expect(byOwner(someUser.id)).toMatchObject({ userMessage: null, replyText: null });

    const only = await request(app).get("/api/portal/usage?days=1&recentLimit=200&messagesOnly=1");
    const owners = only.body.recent.map((r: { ownerId: number }) => r.ownerId);
    expect(owners).toContain(admin.id);
    expect(owners).not.toContain(demoted.id);
    expect(owners).not.toContain(someUser.id);
  });

  it("breaks down recorded calls by purpose, separately from the day/channel/model table", async () => {
    const admin = makeAdmin("usage");
    const someUser = findOrCreateUserByEmail(uniqueEmail("usage-owner"));
    recordApiUsage(someUser.id, "web", "claude-sonnet-5", "assistant_chat", 1000, 200, 0, 0);
    recordApiUsage(someUser.id, "background", "claude-sonnet-5", "document_extraction", 3000, 500, 0, 0);
    const app = buildTestApp(admin.id);

    const res = await request(app).get("/api/portal/usage?days=1");
    expect(res.status).toBe(200);
    expect(res.body.approx).toBe(true);

    const chatPurpose = res.body.byPurpose.find((p: { purpose: string }) => p.purpose === "assistant_chat");
    const extractionPurpose = res.body.byPurpose.find(
      (p: { purpose: string }) => p.purpose === "document_extraction"
    );
    expect(chatPurpose).toMatchObject({ calls: 1, inputTokens: 1000, outputTokens: 200 });
    expect(extractionPurpose).toMatchObject({ calls: 1, inputTokens: 3000, outputTokens: 500 });

    const dayRow = res.body.rows.find((r: { purpose: string }) => r.purpose === "assistant_chat");
    expect(dayRow.channel).toBe("web");
  });

  it("prices cache reads at 10% of the input rate and 1h-TTL cache writes at 2x", async () => {
    const admin = makeAdmin("usage-cache-pricing");
    const someUser = findOrCreateUserByEmail(uniqueEmail("usage-cache-owner"));
    // claude-sonnet-5: cacheRead $0.30/MTok, cacheWrite $6/MTok -> 1M reads + 500K writes = $3.30.
    // No plain input/output tokens, so the whole estimate comes from the cache columns — this is
    // the regression test for the original bug where cached tokens were invisible to the tracker.
    recordApiUsage(someUser.id, "web", "claude-sonnet-5", "cache_pricing_test_marker", 0, 0, 1_000_000, 500_000);
    const app = buildTestApp(admin.id);

    const res = await request(app).get("/api/portal/usage?days=1");
    expect(res.status).toBe(200);
    const row = res.body.rows.find((r: { purpose: string }) => r.purpose === "cache_pricing_test_marker");
    expect(row).toMatchObject({ cacheReadTokens: 1_000_000, cacheCreationTokens: 500_000 });
    expect(row.estimatedCost).toBeCloseTo(3.3, 5);
  });

  it("reports estimatedCost as null for a model with no entry in the price table", async () => {
    const admin = makeAdmin("usage-unknown-model");
    const someUser = findOrCreateUserByEmail(uniqueEmail("usage-owner-2"));
    recordApiUsage(someUser.id, "web", "claude-some-future-model", "assistant_chat", 1000, 200, 0, 0);
    const app = buildTestApp(admin.id);

    const res = await request(app).get("/api/portal/usage?days=1");
    const row = res.body.rows.find((r: { model: string }) => r.model === "claude-some-future-model");
    expect(row.estimatedCost).toBeNull();
  });

  it("breaks down recorded calls by owner, collapsing across purposes and models", async () => {
    const admin = makeAdmin("usage-owner-breakdown");
    const userA = findOrCreateUserByEmail(uniqueEmail("usage-owner-a"));
    const userB = findOrCreateUserByEmail(uniqueEmail("usage-owner-b"));
    recordApiUsage(userA.id, "web", "claude-sonnet-5", "assistant_chat", 1000, 200, 0, 0);
    recordApiUsage(userA.id, "background", "claude-haiku-4-5", "daily_briefing", 500, 100, 0, 0);
    recordApiUsage(userB.id, "whatsapp", "claude-sonnet-5", "assistant_chat", 2000, 400, 0, 0);
    const app = buildTestApp(admin.id);

    const res = await request(app).get("/api/portal/usage?days=1");
    expect(res.status).toBe(200);

    const ownerA = res.body.byOwner.find((o: { ownerEmail: string }) => o.ownerEmail === userA.email);
    const ownerB = res.body.byOwner.find((o: { ownerEmail: string }) => o.ownerEmail === userB.email);
    expect(ownerA).toMatchObject({ calls: 2, inputTokens: 1500, outputTokens: 300 });
    expect(ownerB).toMatchObject({ calls: 1, inputTokens: 2000, outputTokens: 400 });
    // Sorted by total tokens descending — userB's single call (2400 tok) outweighs userA's
    // combined two (1800 tok). Checked by relative position, not index 0: other tests in this
    // file share the same underlying table and may record more-tokens-having owners of their own.
    const indexA = res.body.byOwner.findIndex((o: { ownerEmail: string }) => o.ownerEmail === userA.email);
    const indexB = res.body.byOwner.findIndex((o: { ownerEmail: string }) => o.ownerEmail === userB.email);
    expect(indexB).toBeLessThan(indexA);
  });

  it('projects a monthly cost from the most recent COMPLETE day, never from today (always partial)', async () => {
    const admin = makeAdmin("usage-projection");
    const someUser = findOrCreateUserByEmail(uniqueEmail("usage-projection-owner"));

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-03-10T12:00:00Z"));
      // $3/Mtok input, $15/Mtok output for claude-sonnet-5 (see MODEL_PRICE_PER_MTOK) -> $0.06 that day.
      recordApiUsage(someUser.id, "web", "claude-sonnet-5", "assistant_chat", 10_000, 2_000, 0, 0);

      vi.setSystemTime(new Date("2026-03-11T09:00:00Z"));
      // Today's own (partial) usage must not be what gets projected.
      recordApiUsage(someUser.id, "web", "claude-sonnet-5", "assistant_chat", 999_999, 999_999, 0, 0);

      const app = buildTestApp(admin.id);
      const res = await request(app).get("/api/portal/usage?days=7");
      expect(res.status).toBe(200);
      expect(res.body.projection.day).toBe("2026-03-10");
      expect(res.body.projection.dayCost).toBeCloseTo(0.06, 5);
      expect(res.body.projection.projectedMonthlyCost).toBeCloseTo(1.8, 5);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("GET /phone-actions", () => {
  it("lists offered actions with plain-English steps and the failure", async () => {
    const admin = makeAdmin("portal-phone-admin");
    const app = buildTestApp(admin.id);
    const owner = findOrCreateUserByEmail(`portal-phone-${Date.now()}@example.com`);
    const id = insertPhoneAction({
      ownerId: owner.id, codeHash: `portal-${Date.now()}`, source: "chat", phone: null, label: "Work mode",
      steps: [{ type: "focus", name: "Work", on: true }], createdAt: Date.now(), expiresAt: Date.now() + 1000,
    });
    updatePhoneAction(id, { status: "failed", results: [{ index: 0, ok: false, error: "Focus not found", at: Date.now() }], finishedAt: Date.now() });
    const res = await request(app).get("/api/portal/phone-actions");
    expect(res.status).toBe(200);
    expect(res.body.find((r: { id: number }) => r.id === id)).toMatchObject({
      email: owner.email, source: "chat", label: "Work mode", status: "failed",
      steps: ["turn Work Focus on"], failure: "turn Work Focus on: Focus not found",
    });
  });
});
