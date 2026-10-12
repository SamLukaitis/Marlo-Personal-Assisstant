// One-tap phone actions through the "Marlowe" Apple Shortcut. Marlowe stores a validated list of
// steps under a random one-time code; the link opens a small page (/a/:code) that launches the
// Shortcut, which fetches the steps from here, runs them and reports each one back. Only the
// SHA-256 of the code is stored. See docs/superpowers/specs/2026-10-12-marlowe-shortcut-design.md.
import { createHash, randomBytes } from "node:crypto";
import { SERVER_URL } from "../config.js";
import {
  insertPhoneAction,
  getPhoneActionByCodeHash,
  updatePhoneAction,
  listStalledPhoneActions,
  recordShortcutSeen,
  type PhoneActionRow,
  type PhoneActionSource,
  type PhoneStepJson,
  type PhoneStepResult,
} from "../db/store.js";
import { describeStep, unsupportedSteps, type PhoneStep } from "./phoneSteps.js";
import { handleFinishedPhoneAction } from "./phoneActionFollowups.js";

const HOUR = 60 * 60 * 1000;
export const CHAT_TTL_MS = 24 * HOUR;
export const PROACTIVE_TTL_MS = 36 * HOUR;
export const REPORT_WINDOW_MS = 10 * 60 * 1000;
export const STALL_MS = 5 * 60 * 1000;
const MAX_VALUE_JSON = 2000;
const MAX_ERROR = 300;

export function isPhoneActionsConfigured(): boolean {
  return Boolean(process.env.MARLOWE_SHORTCUT_ICLOUD_URL?.trim());
}

export function shortcutInstallUrl(): string {
  return process.env.MARLOWE_SHORTCUT_ICLOUD_URL?.trim() ?? "";
}

export function currentShortcutVersion(): number {
  const v = Number(process.env.MARLOWE_SHORTCUT_VERSION);
  return Number.isInteger(v) && v > 0 ? v : 1;
}

export function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

export function actionPageUrl(code: string): string {
  return `${SERVER_URL}/a/${code}`;
}

export function actionFetchUrl(code: string): string {
  return `${SERVER_URL}/api/phone-actions/${code}`;
}

export function shortcutRunUrl(code: string): string {
  return `shortcuts://run-shortcut?name=Marlowe&input=text&text=${encodeURIComponent(actionFetchUrl(code))}`;
}

export function createPhoneAction(
  ownerId: number,
  steps: PhoneStep[],
  opts: { source: PhoneActionSource; label: string; phone?: string | null; ttlMs: number; notAfter?: number; now?: number }
): { code: string; url: string; summary: string[] } {
  const now = opts.now ?? Date.now();
  const code = randomBytes(16).toString("base64url");
  insertPhoneAction({
    ownerId,
    codeHash: hashCode(code),
    source: opts.source,
    phone: opts.phone ?? null,
    label: opts.label,
    steps: steps as unknown as PhoneStepJson[],
    createdAt: now,
    expiresAt: Math.min(now + opts.ttlMs, opts.notAfter ?? Infinity),
  });
  return { code, url: actionPageUrl(code), summary: steps.map(describeStep) };
}

function usable(row: PhoneActionRow | null, now: number): row is PhoneActionRow {
  return row !== null && row.status === "offered" && now <= row.expiresAt;
}

export type PhoneActionView =
  | { state: "ready"; label: string; summary: string[]; runUrl: string; installUrl: string }
  | { state: "gone"; installUrl: string };

// The landing page only reads: WhatsApp's link preview and a second look must not use up the code.
export function viewPhoneAction(code: string, now = Date.now()): PhoneActionView {
  const row = getPhoneActionByCodeHash(hashCode(code));
  if (!usable(row, now)) return { state: "gone", installUrl: shortcutInstallUrl() };
  return {
    state: "ready",
    label: row.label,
    summary: (row.steps as unknown as PhoneStep[]).map(describeStep),
    runUrl: shortcutRunUrl(code),
    installUrl: shortcutInstallUrl(),
  };
}

export type FetchOutcome =
  | { kind: "steps"; steps: PhoneStepJson[]; reportUrl: string }
  | { kind: "update"; installUrl: string; message: string }
  | { kind: "gone"; message: string };

export function fetchPhoneAction(code: string, version: number, now = Date.now()): FetchOutcome {
  const row = getPhoneActionByCodeHash(hashCode(code));
  // Read before the guard: the guard narrows `row` to null on the failing branch.
  const used = row !== null && row.status !== "offered";
  if (!usable(row, now)) {
    return { kind: "gone", message: used ? "This link was already used. Ask Marlowe again." : "This link has expired. Ask Marlowe again." };
  }
  recordShortcutSeen(row.ownerId, version, now);
  const missing = unsupportedSteps(row.steps as unknown as PhoneStep[], version);
  if (missing.length) {
    // Not consumed: once they've added the new version, the same link works.
    return {
      kind: "update",
      installUrl: shortcutInstallUrl(),
      message: "Your Marlowe Shortcut needs an update for this. Add the new version, then tap the link again.",
    };
  }
  updatePhoneAction(row.id, { status: "fetched", fetchedAt: now, version });
  return { kind: "steps", steps: row.steps, reportUrl: `${actionFetchUrl(code)}/report` };
}

function clampValue(value: unknown): unknown {
  const json = JSON.stringify(value);
  if (json === undefined) return undefined;
  return json.length > MAX_VALUE_JSON ? json.slice(0, MAX_VALUE_JSON) : value;
}

async function finish(row: PhoneActionRow, status: "done" | "failed", results: PhoneStepResult[], now: number): Promise<void> {
  updatePhoneAction(row.id, { status, results, finishedAt: now });
  await handleFinishedPhoneAction({ ...row, status, results, finishedAt: now }, now).catch((err) =>
    console.error(`phoneActions: follow-up failed for action ${row.id}`, err)
  );
}

export type ReportOutcome = "ok" | "gone" | "bad_request";

export async function reportPhoneStep(code: string, body: Record<string, unknown>, now = Date.now()): Promise<ReportOutcome> {
  const row = getPhoneActionByCodeHash(hashCode(code));
  if (!row || row.status !== "fetched" || row.fetchedAt === null || now - row.fetchedAt > REPORT_WINDOW_MS) return "gone";

  if (body.done === true) {
    await finish(row, "done", row.results, now);
    return "ok";
  }
  const index = body.index;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= row.steps.length) return "bad_request";
  if (typeof body.ok !== "boolean") return "bad_request";
  // The Shortcut may retry a POST on a flaky connection — the first report for a step wins.
  if (row.results.some((r) => r.index === index)) return "ok";

  const result: PhoneStepResult = { index, ok: body.ok, at: now };
  const value = clampValue(body.value);
  if (value !== undefined) result.value = value;
  if (typeof body.error === "string") result.error = body.error.slice(0, MAX_ERROR);
  const results = [...row.results, result];

  if (!body.ok) {
    await finish(row, "failed", results, now);
  } else if (results.length === row.steps.length) {
    // Every step reported ok — don't wait on the final "done" POST, which may never arrive.
    await finish(row, "done", results, now);
  } else {
    updatePhoneAction(row.id, { results });
  }
  return "ok";
}

// Shortcuts has no try/catch: a failing step usually stops the run silently. A run fetched over
// STALL_MS ago that never finished is failed at the first step that didn't report.
export async function sweepStalledPhoneActions(now = Date.now()): Promise<void> {
  for (const row of listStalledPhoneActions(now - STALL_MS)) {
    const reported = new Set(row.results.map((r) => r.index));
    const next = row.steps.findIndex((_, i) => !reported.has(i));
    if (next === -1) {
      await finish(row, "done", row.results, now);
      continue;
    }
    await finish(
      row,
      "failed",
      [...row.results, { index: next, ok: false, error: "the Shortcut stopped before finishing this step", at: now }],
      now
    );
  }
}
