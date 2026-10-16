import { Router } from "express";
import {
  getUser,
  listRecentServerLogs,
  listAdminTodos,
  addAdminTodo,
  setAdminTodoDone,
  deleteAdminTodo,
  addAdminTodoReply,
  markAdminTodoRepliesRead,
} from "../db/store.js";
import {
  addFlaggedRequestNote,
  getJoyceUsageByDay,
  getJoyceUsageByPurpose,
  listFlaggedRequests,
  listRecentJoyceUsage,
  resolveFlaggedRequest,
} from "../joyce/adminRecords.js";
import { estimateCost } from "./portalRoutes.js";
import type { AuthedRequest } from "../middleware/auth.js";

// Joyce's admin portal: the same sections as Marlowe's Portal (portalRoutes.ts) for the parts
// that apply to her — flagged requests, a to-do list, server logs and API usage. Every route
// returns the same shape as its Marlowe counterpart, so the client renders both with the same
// components (client/src/pages/PortalPage.tsx).
//
// This file lives outside src/joyce/ on purpose: it needs Marlowe's admin auth and users table,
// and Joyce's own code isn't allowed to import Marlowe's. Nothing here can reach a family's data
// — adminRecords.ts holds only flagged-request summaries (with an anonymous family label) and
// token counts.
//
// Mounted behind requireAdmin in index.ts, like the Portal.
export const joycePortalRoutes = Router();

function adminId(req: import("express").Request): number {
  return (req as unknown as AuthedRequest).userId;
}

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) ? id : null;
}

// --- Flagged requests ---------------------------------------------------------------------------
// Shaped like Marlowe's unmet requests. `channel` carries the anonymous family label, which the
// client shows in the same badge Marlowe uses for "whatsapp"/"web".

function flaggedRequestsForPortal(includeResolved: boolean) {
  const emailById = new Map<number, string | null>();
  const emailOf = (id: number) => {
    if (!emailById.has(id)) emailById.set(id, getUser(id)?.email ?? null);
    return emailById.get(id)!;
  };
  return listFlaggedRequests(includeResolved).map((r) => ({
    id: r.id,
    ownerId: 0,
    summary: r.summary,
    channel: r.familyLabel,
    createdAt: r.createdAt,
    resolvedAt: r.resolvedAt,
    notes: r.notes.map((n) => ({ ...n, authorEmail: emailOf(n.authorId) })),
  }));
}

joycePortalRoutes.get("/unmet-requests", (req, res) => {
  res.json(flaggedRequestsForPortal(req.query.includeResolved === "true"));
});

joycePortalRoutes.post("/unmet-requests/:id/resolve", (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  resolveFlaggedRequest(id);
  res.json({ ok: true });
});

joycePortalRoutes.post("/unmet-requests/:id/notes", (req, res) => {
  const id = parseId(req.params.id);
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (id === null) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  if (!text) {
    res.status(400).json({ error: "text is required" });
    return;
  }
  addFlaggedRequestNote(id, adminId(req), text);
  res.json(flaggedRequestsForPortal(req.query.includeResolved === "true"));
});

// --- Logs ---------------------------------------------------------------------------------------
// Only Joyce's lines. "Explain this" uses the Portal's endpoint — it's the same log table.

joycePortalRoutes.get("/logs", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  res.json(listRecentServerLogs(limit, "joyce:"));
});

// --- Usage --------------------------------------------------------------------------------------
// Totals only: Joyce's usage isn't recorded per family, so there is no "who's using it".

joycePortalRoutes.get("/usage", (req, res) => {
  const days = Math.min(Number(req.query.days) || 30, 365);
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const withCost = <T extends {
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  }>(r: T) => ({
    ...r,
    estimatedCost: estimateCost(r.model, r.inputTokens, r.outputTokens, r.cacheReadTokens, r.cacheCreationTokens),
  });

  const rows = getJoyceUsageByDay(sinceMs).map((r) => ({ ...withCost(r), channel: "whatsapp" }));

  const costByPurpose = new Map<string, number>();
  const costByDay = new Map<string, number>();
  for (const r of rows) {
    if (r.estimatedCost == null) continue;
    costByPurpose.set(r.purpose, (costByPurpose.get(r.purpose) ?? 0) + r.estimatedCost);
    costByDay.set(r.day, (costByDay.get(r.day) ?? 0) + r.estimatedCost);
  }
  const byPurpose = getJoyceUsageByPurpose(sinceMs).map((r) => ({
    ...r,
    estimatedCost: costByPurpose.get(r.purpose) ?? null,
  }));

  // Same "if every day looked like the last complete one" projection as the Portal's.
  const todayUtc = new Date().toISOString().slice(0, 10);
  const lastFullDay = Array.from(costByDay.keys())
    .filter((d) => d < todayUtc)
    .sort()
    .pop();
  const projection =
    lastFullDay !== undefined
      ? {
          day: lastFullDay,
          dayCost: costByDay.get(lastFullDay)!,
          projectedMonthlyCost: costByDay.get(lastFullDay)! * 30,
        }
      : null;

  const recentLimit = Math.min(Number(req.query.recentLimit) || 50, 200);
  const recent = listRecentJoyceUsage(recentLimit).map((r) => ({
    ...withCost(r),
    channel: "whatsapp",
    ownerId: null,
    ownerExists: 0,
    ownerEmail: null,
  }));

  res.json({ rows, byPurpose, byOwner: [], projection, recent, approx: true });
});

// --- To-do list ---------------------------------------------------------------------------------
// Marlowe's admin to-do table, scoped to product "joyce" so the two lists stay separate.

joycePortalRoutes.get("/todos", (req, res) => {
  res.json(listAdminTodos(adminId(req), "joyce"));
});

joycePortalRoutes.post("/todos", (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text) {
    res.status(400).json({ error: "text is required" });
    return;
  }
  addAdminTodo(text, adminId(req), "joyce");
  res.json(listAdminTodos(adminId(req), "joyce"));
});

joycePortalRoutes.put("/todos/:id", (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  setAdminTodoDone(id, !!req.body?.done);
  res.json(listAdminTodos(adminId(req), "joyce"));
});

joycePortalRoutes.delete("/todos/:id", (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  deleteAdminTodo(id);
  res.json(listAdminTodos(adminId(req), "joyce"));
});

joycePortalRoutes.post("/todos/:id/replies", (req, res) => {
  const id = parseId(req.params.id);
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (id === null) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  if (!text) {
    res.status(400).json({ error: "text is required" });
    return;
  }
  addAdminTodoReply(id, adminId(req), text);
  // Writing a reply means you've seen the thread up to it.
  markAdminTodoRepliesRead(id, adminId(req));
  res.json(listAdminTodos(adminId(req), "joyce"));
});

joycePortalRoutes.post("/todos/:id/read", (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  markAdminTodoRepliesRead(id, adminId(req));
  res.json(listAdminTodos(adminId(req), "joyce"));
});
