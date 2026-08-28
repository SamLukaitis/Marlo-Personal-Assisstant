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

    const doneRes = await request(app).put(`/api/portal/todos/${todo.id}`).send({ done: true });
    expect(doneRes.body.find((t: { id: number }) => t.id === todo.id).done).toBe(true);

    const delRes = await request(app).delete(`/api/portal/todos/${todo.id}`);
    expect(delRes.body.find((t: { id: number }) => t.id === todo.id)).toBeUndefined();
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
  it("breaks down recorded calls by purpose, separately from the day/channel/model table", async () => {
    const admin = makeAdmin("usage");
    const someUser = findOrCreateUserByEmail(uniqueEmail("usage-owner"));
    recordApiUsage(someUser.id, "web", "claude-sonnet-5", "assistant_chat", 1000, 200);
    recordApiUsage(someUser.id, "background", "claude-sonnet-5", "document_extraction", 3000, 500);
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

  it("reports estimatedCost as null for a model with no entry in the price table", async () => {
    const admin = makeAdmin("usage-unknown-model");
    const someUser = findOrCreateUserByEmail(uniqueEmail("usage-owner-2"));
    recordApiUsage(someUser.id, "web", "claude-some-future-model", "assistant_chat", 1000, 200);
    const app = buildTestApp(admin.id);

    const res = await request(app).get("/api/portal/usage?days=1");
    const row = res.body.rows.find((r: { model: string }) => r.model === "claude-some-future-model");
    expect(row.estimatedCost).toBeNull();
  });
});
