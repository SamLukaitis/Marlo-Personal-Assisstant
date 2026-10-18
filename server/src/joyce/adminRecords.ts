import path from "node:path";
import Database from "better-sqlite3";
import { JOYCE_DIR } from "./registry.js";
import { familyAdminLabel } from "./familyKey.js";
import type { FamilySession } from "./familyDb.js";

// What Joyce's admin portal shows: requests she couldn't handle, and what she costs to run, plus
// the few switches admins can flip for every family at once (the settings table).
// Kept in its own file, away from both the registry and every family's database, because it is
// the one place admins read — and so it holds nothing a family told Joyce beyond the one-line
// summary she writes when she flags something.
//
// A flagged request carries an anonymous family label (familyKey.ts's familyAdminLabel), so
// admins can tell that requests came from the same family without knowing which family it is.
// Usage rows carry no family at all.
//
// Admin notes record the admin's user id from Marlowe's users table as a plain number. Joyce
// can't import Marlowe's modules, so the portal route (routes/joycePortalRoutes.ts) looks up the
// email to show beside it.

const db = new Database(path.join(JOYCE_DIR, "admin.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS flagged_requests (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    family_label TEXT NOT NULL,
    summary      TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    resolved_at  INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_flagged_requests_created ON flagged_requests(created_at);

  CREATE TABLE IF NOT EXISTS flagged_request_notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id INTEGER NOT NULL REFERENCES flagged_requests(id),
    author_id  INTEGER NOT NULL,
    text       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_flagged_request_notes_request ON flagged_request_notes(request_id);

  CREATE TABLE IF NOT EXISTS usage (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    model                 TEXT NOT NULL,
    purpose               TEXT NOT NULL,
    input_tokens          INTEGER NOT NULL,
    output_tokens         INTEGER NOT NULL,
    cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    created_at            INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_usage_created ON usage(created_at);

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// --- Flagged requests --------------------------------------------------------------------------

/** Called by Joyce's flag_unmet_request tool. The family comes from the session, never an argument. */
export function flagRequest(session: FamilySession, summary: string): number {
  const res = db
    .prepare(`INSERT INTO flagged_requests (family_label, summary, created_at) VALUES (?, ?, ?)`)
    .run(familyAdminLabel(session.familyId), summary.trim().slice(0, 500), Date.now());
  return Number(res.lastInsertRowid);
}

/** Removes a flagged request (and admins' notes on it) when the message it came from is deleted. */
export function deleteFlaggedRequest(id: number): void {
  db.prepare(`DELETE FROM flagged_request_notes WHERE request_id = ?`).run(id);
  db.prepare(`DELETE FROM flagged_requests WHERE id = ?`).run(id);
}

export interface FlaggedRequestNote {
  id: number;
  requestId: number;
  text: string;
  authorId: number;
  createdAt: number;
}

export interface FlaggedRequest {
  id: number;
  familyLabel: string;
  summary: string;
  createdAt: number;
  resolvedAt: number | null;
  notes: FlaggedRequestNote[];
}

export function listFlaggedRequests(includeResolved: boolean): FlaggedRequest[] {
  const requests = db
    .prepare(
      `SELECT id, family_label AS familyLabel, summary, created_at AS createdAt,
              resolved_at AS resolvedAt
         FROM flagged_requests
        ${includeResolved ? "" : "WHERE resolved_at IS NULL"}
        ORDER BY created_at DESC`
    )
    .all() as Omit<FlaggedRequest, "notes">[];
  const notes = db
    .prepare(
      `SELECT id, request_id AS requestId, text, author_id AS authorId, created_at AS createdAt
         FROM flagged_request_notes ORDER BY created_at ASC, id ASC`
    )
    .all() as FlaggedRequestNote[];
  return requests.map((r) => ({ ...r, notes: notes.filter((n) => n.requestId === r.id) }));
}

export function resolveFlaggedRequest(id: number): void {
  db.prepare(`UPDATE flagged_requests SET resolved_at = ? WHERE id = ?`).run(Date.now(), id);
}

export function addFlaggedRequestNote(requestId: number, authorId: number, text: string): void {
  db.prepare(
    `INSERT INTO flagged_request_notes (request_id, author_id, text, created_at) VALUES (?, ?, ?, ?)`
  ).run(requestId, authorId, text, Date.now());
}

// --- API usage ---------------------------------------------------------------------------------

export type JoyceUsagePurpose = "joyce_chat" | "joyce_file_reading";

/** Never throws: a failure to record spend must not cost a family their reply. */
export function recordJoyceUsage(
  model: string,
  purpose: JoyceUsagePurpose,
  usage:
    | {
        input_tokens?: number | null;
        output_tokens?: number | null;
        cache_read_input_tokens?: number | null;
        cache_creation_input_tokens?: number | null;
      }
    | undefined
): void {
  try {
    db.prepare(
      `INSERT INTO usage (model, purpose, input_tokens, output_tokens, cache_read_tokens,
                          cache_creation_tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      model,
      purpose,
      usage?.input_tokens ?? 0,
      usage?.output_tokens ?? 0,
      usage?.cache_read_input_tokens ?? 0,
      usage?.cache_creation_input_tokens ?? 0,
      Date.now()
    );
  } catch (err) {
    console.error("joyce: couldn't record API usage", err);
  }
}

interface TokenTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

const TOTALS = `COUNT(*) AS calls, SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens,
  SUM(cache_read_tokens) AS cacheReadTokens, SUM(cache_creation_tokens) AS cacheCreationTokens`;

export function getJoyceUsageByDay(
  sinceMs: number
): (TokenTotals & { day: string; model: string; purpose: string })[] {
  return db
    .prepare(
      `SELECT date(created_at / 1000, 'unixepoch') AS day, model, purpose, ${TOTALS}
         FROM usage WHERE created_at >= ?
        GROUP BY day, model, purpose ORDER BY day DESC, purpose`
    )
    .all(sinceMs) as (TokenTotals & { day: string; model: string; purpose: string })[];
}

export function getJoyceUsageByPurpose(sinceMs: number): (TokenTotals & { purpose: string })[] {
  return db
    .prepare(
      `SELECT purpose, ${TOTALS} FROM usage WHERE created_at >= ?
        GROUP BY purpose ORDER BY inputTokens + outputTokens DESC`
    )
    .all(sinceMs) as (TokenTotals & { purpose: string })[];
}

export function listRecentJoyceUsage(limit: number): {
  id: number;
  model: string;
  purpose: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  createdAt: number;
}[] {
  return db
    .prepare(
      `SELECT id, model, purpose, input_tokens AS inputTokens, output_tokens AS outputTokens,
              cache_read_tokens AS cacheReadTokens, cache_creation_tokens AS cacheCreationTokens,
              created_at AS createdAt
         FROM usage ORDER BY created_at DESC, id DESC LIMIT ?`
    )
    .all(limit) as ReturnType<typeof listRecentJoyceUsage>;
}

// --- Settings -----------------------------------------------------------------------------------
// Switches admins flip in the Joyce portal. They apply to every family at once.

const BUILT_IN_CALENDAR_KEY = "built_in_calendar";

/**
 * Whether a family that hasn't connected Google Calendar falls back to Joyce's own calendar
 * (store.ts's events, with the subscribe link). On unless an admin turns it off. Off, such a
 * family has no calendar until someone connects Google. See assistant.ts's calendarMode.
 */
export function isBuiltInCalendarEnabled(): boolean {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(BUILT_IN_CALENDAR_KEY) as
    | { value: string }
    | undefined;
  return row?.value !== "off";
}

export function setBuiltInCalendarEnabled(enabled: boolean): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(BUILT_IN_CALENDAR_KEY, enabled ? "on" : "off");
}
