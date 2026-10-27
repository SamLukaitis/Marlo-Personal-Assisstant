// One-tap phone actions through the "Marlo" Apple Shortcut. Marlo stores a validated list of
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
  getShortcutStatus,
  listRecentFinishedPhoneActions,
  recordShortcutSeen,
  type PhoneActionRow,
  type PhoneActionSource,
  type PhoneStepJson,
  type PhoneStepResult,
} from "../db/store.js";
import { describeStep, unsupportedSteps, validateSteps, supportedStepTypes, type PhoneStep } from "./phoneSteps.js";
import { cleanText, InputError } from "./appLinks.js";
import { handleFinishedPhoneAction, formatReportedValue, PROBLEM_TTL_MS } from "./phoneActionFollowups.js";

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
  return `shortcuts://run-shortcut?name=Marlo&input=text&text=${encodeURIComponent(actionFetchUrl(code))}`;
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
// The model sometimes writes a Marlo link itself, copying the shape of an earlier one, or re-pastes
// a link that was already used. Either way the user taps a dead link. Every action link in a reply
// must be one that exists and is still unused; anything else is replaced so the user isn't misled.
export function scrubUnknownActionLinks(text: string, now = Date.now()): string {
  const prefix = actionPageUrl("").replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return text.replace(new RegExp(`${prefix}([A-Za-z0-9_-]{22})(?![A-Za-z0-9_-])`, "g"), (link, code: string) => {
    const row = getPhoneActionByCodeHash(hashCode(code));
    return usable(row, now) ? link : "(that link isn't valid — ask me again for a fresh one)";
  });
}

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
    return { kind: "gone", message: used ? "This link was already used. Ask Marlo again." : "This link has expired. Ask Marlo again." };
  }
  recordShortcutSeen(row.ownerId, version, now);
  const missing = unsupportedSteps(row.steps as unknown as PhoneStep[], version);
  if (missing.length) {
    // Not consumed: once they've added the new version, the same link works.
    return {
      kind: "update",
      installUrl: shortcutInstallUrl(),
      message: "Your Marlo Shortcut needs an update for this. Add the new version, then tap the link again.",
    };
  }
  updatePhoneAction(row.id, { status: "fetched", fetchedAt: now, version });
  return { kind: "steps", steps: row.steps, reportUrl: `${actionFetchUrl(code)}/report` };
}

// Only a free-text `ask` answer can legitimately run long. Cutting a JSON string would hand the model
// corrupt data, so strings are cut as text and anything else that is too large is dropped instead.
function clampValue(value: unknown): unknown {
  if (typeof value === "string") {
    const chars = Array.from(value);
    return chars.length > MAX_VALUE_JSON ? `${chars.slice(0, MAX_VALUE_JSON).join("")}…` : value;
  }
  const json = JSON.stringify(value);
  if (json === undefined) return undefined;
  return json.length > MAX_VALUE_JSON ? undefined : value;
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

const RECENT_RESULTS_MS = 2 * HOUR;

// The Shortcut version this user's phone last reported, or the published one before it ever ran.
// Everything Marlo offers is checked against this, so a phone is never sent a step it can't run.
export function userShortcutVersion(ownerId: number): number {
  return getShortcutStatus(ownerId)?.version ?? currentShortcutVersion();
}

// Per-user context for the chat system prompt. Empty when the feature is off, so nothing about
// phone actions reaches the model on servers without the Shortcut configured.
export function phonePromptSection(ownerId: number, now = Date.now()): string {
  if (!isPhoneActionsConfigured()) return "";
  const lines = [
    "Phone actions: with make_phone_action you can send a one-tap link that runs steps on the user's iPhone through the Marlo Shortcut " +
      `(${supportedStepTypes(userShortcutVersion(ownerId)).join(", ")}). Offer one whenever it saves them effort, not only when asked — e.g. an alarm before an early flight, ` +
      "a Focus during a long meeting, a text to say they're running late. Combine related steps into one link. Never say it's done — say \"tap to …\". " +
      "Put the link on its own line. iPhone only. Never write a Marlo link yourself or reuse one from earlier in the chat: " +
      "every link must be the url make_phone_action just returned, and each link works only once.",
    // Without these the model reaches for email when the user says "message mum", and refuses a
    // calendar event when no Google/Microsoft calendar is connected.
    "Picking the channel: when they ask you to \"message\" or \"text\" someone, use a phone text step. When they say WhatsApp, " +
      "use make_app_link app=whatsapp (look the number up with search_contacts if you can). Use email only when they say email or give an email address. " +
      "If they want something in their calendar and no calendar account is connected, use a calendar_event step instead of asking them to connect one. " +
      "\"remind me…\" stays set_reminder (a WhatsApp nudge from you); use a reminder step only when they mention their Reminders app.",
  ];
  const status = getShortcutStatus(ownerId);
  if (!status) {
    lines.push("The user hasn't run the Marlo Shortcut yet: make_phone_action returns an install_url — send it first (\"first time: add the Marlo Shortcut\"), then the action link.");
  } else {
    lines.push(`Their Marlo Shortcut is version ${status.version}.`);
    const problems = status.knownProblems.filter((p) => now - p.at <= PROBLEM_TTL_MS);
    if (problems.length) {
      lines.push(
        `Recent failures on their phone: ${problems.map((p) => `${p.detail} (${p.error})`).join("; ")}. ` +
          "If they ask for one of these again, mention it failed last time, but still call make_phone_action — a new link is the only way to retry."
      );
    }
  }
  const recent = listRecentFinishedPhoneActions(ownerId, now - RECENT_RESULTS_MS).map((a) => {
    const steps = a.steps as unknown as PhoneStep[];
    const values = a.results
      .filter((r) => steps[r.index])
      .map((r) => (r.ok ? formatReportedValue(steps[r.index], r.value) : `failed to ${describeStep(steps[r.index])}: ${r.error ?? "unknown"}`))
      .filter(Boolean);
    return `${new Date(a.finishedAt!).toISOString().slice(11, 16)} UTC "${a.label}" ${a.status}${values.length ? ` — ${values.join("; ")}` : ""}`;
  });
  if (recent.length) lines.push(`Recent phone actions: ${recent.join(" | ")}.`);
  return lines.join("\n");
}

export function makePhoneActionForChat(
  ownerId: number,
  input: Record<string, unknown>,
  phone: string | null,
  now = Date.now()
): { url: string; summary: string[]; install_url?: string } | { error: string } {
  const status = getShortcutStatus(ownerId);
  const validated = validateSteps(input.steps, userShortcutVersion(ownerId));
  if ("error" in validated) {
    // Only point at an update when a newer Shortcut than theirs has actually been published.
    return status && status.version < currentShortcutVersion() && validated.error.includes("can't do")
      ? { error: `${validated.error} Ask them to add the updated Marlo Shortcut: ${shortcutInstallUrl()}` }
      : validated;
  }
  let label: string;
  try {
    label = cleanText(input.label, "label", 80) ?? "Phone action";
  } catch (e) {
    if (e instanceof InputError) return { error: e.message };
    throw e;
  }
  const { url, summary } = createPhoneAction(ownerId, validated.steps, { source: "chat", label, phone, ttlMs: CHAT_TTL_MS, now });
  return status ? { url, summary } : { url, summary, install_url: shortcutInstallUrl() };
}

const MAX_SUGGESTIONS = 3;
// [[phone|<label>|<steps JSON array>]] — the array is captured up to the "]" that's followed by the
// closing "]]", so a "]" inside the JSON can't end it early. Step values never contain "]]]".
const MARKER = /\[\[phone\|([^|\n\]]{1,80})\|(\[[\s\S]*?\])\]\]/g;

// Briefing/digest models read outsider-controlled text (calendar titles, email senders/subjects), so a
// marker they emit is untrusted. Only the benign, prompt-listed step types may become a link; anything
// else (run_shortcut, open_url, text, report-back steps…) is dropped, whatever label it carries.
export const PROACTIVE_STEP_TYPES = ["alarm", "timer", "reminder", "focus", "directions", "low_power"] as const;

export function phoneSuggestionsEnabled(ownerId: number): boolean {
  return isPhoneActionsConfigured() && getShortcutStatus(ownerId) !== null;
}

export const PHONE_SUGGESTION_PROMPT = [
  "The user has the Marlo Shortcut on their iPhone, so you can offer up to 3 one-tap actions — but only when the calendar or bookings give a concrete reason:",
  "an early start or flight (an alarm, a Sleep Focus the night before), a long meeting (a Focus for its length), travel to an address (directions). No reason, no suggestion.",
  'Write each one on its own line exactly as [[phone|<what tapping does, a few words starting "Tap to">|<JSON array of steps>]], e.g.',
  '[[phone|Tap to set a 05:15 alarm and Sleep Focus at 22:30|[{"type":"alarm","time":"05:15","label":"Flight BA117"},{"type":"focus","name":"Sleep","on":true}]]]',
  "Step types: alarm {time HH:MM, label?}, timer {minutes}, reminder {title, due? YYYY-MM-DDTHH:MM}, focus {name, on, until? HH:MM}, directions {destination}, low_power {on}.",
  "Never say the action is done. The lines don't count toward your word limit.",
].join("\n");

export function expandPhoneMarkers(ownerId: number, text: string, source: "briefing" | "digest", now = Date.now()): string {
  const enabled = phoneSuggestionsEnabled(ownerId);
  const version = userShortcutVersion(ownerId);
  let made = 0;
  let matched = false;
  const out = text.replace(MARKER, (_whole, rawLabel: string, json: string) => {
    matched = true;
    if (!enabled || made >= MAX_SUGGESTIONS) return "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return "";
    }
    const validated = validateSteps(parsed, version);
    if ("error" in validated) return "";
    if (validated.steps.some((st) => !(PROACTIVE_STEP_TYPES as readonly string[]).includes(st.type))) return "";
    const label = cleanText(rawLabel, "label", 80);
    if (!label) return "";
    made++;
    const { url } = createPhoneAction(ownerId, validated.steps, { source, label, ttlMs: PROACTIVE_TTL_MS, now });
    return `${label}: ${url}`;
  });
  // No marker: hand the text back untouched, so feature-off output stays exactly as it was.
  if (!matched) return text;
  return tidyAfterMarkers(out);
}

// Dropped markers leave doubled spaces / blank lines behind.
function tidyAfterMarkers(text: string): string {
  return text.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Marker removal with no link creation — the fallback when expansion itself fails, so a briefing still goes out.
export function stripPhoneMarkers(text: string): string {
  const out = text.replace(MARKER, "");
  return out === text ? text : tidyAfterMarkers(out);
}
