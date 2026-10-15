# Marlowe Shortcut (phone actions) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Marlowe send a one-tap link that runs a list of steps on the user's iPhone through one general "Marlowe" Apple Shortcut. Each step reports back to Marlowe.

**Architecture:** A pure validator (`phoneSteps.ts`) defines the step vocabulary. `phoneActions.ts` stores each validated list under a random one-time code (hashed in SQLite). Public routes serve a small landing page (`/a/:code`), hand the steps to the Shortcut (`GET /api/phone-actions/:code`) and take per-step reports (`POST …/report`). Finished runs go to `phoneActionFollowups.ts`, which sends a failure message, feeds report-back values into the WhatsApp conversation, and records known problems. Offers come from four places: the chat tool `make_phone_action`, markers in the morning briefing and evening digest, and attention-gate reminders.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Express 4, better-sqlite3, vitest + supertest, luxon, React 19 client.

**Spec:** `docs/superpowers/specs/2026-10-12-marlowe-shortcut-design.md`

## Global Constraints

- Feature is dormant unless `MARLOWE_SHORTCUT_ICLOUD_URL` is set: no tool, no prompt text, no briefing/digest/reminder suggestions. `MARLOWE_SHORTCUT_VERSION` defaults to 1.
- Codes: 128 random bits, base64url; only the SHA-256 hex hash is stored. Fetched once; second fetch → 410.
- Expiry: chat 24h; briefing/digest/reminder 36h or event start, whichever is sooner. Reports accepted for 10 minutes after fetch. A fetched run with no finish after 5 minutes is failed by the sweeper.
- Max 8 steps per action. `run_shortcut` must be the last step. `text` body ≤ 500 chars; other text ≤ 200 unless stated; labels ≤ 80.
- Text cleaning uses the same rules as `appLinks.ts` `text()` (invisible formatting stripped, code-point-safe cap).
- Briefing/digest: at most 3 suggestions, only for users whose Shortcut has fetched at least once (`phone_shortcut_status` row exists).
- Follow-ups (failure message, report-back turn) are replies to a user tap: they do not go through the attention gate and don't count toward its daily cap.
- New owner-scoped tables must be purged in `deleteUserCompletely` (recurring FK bug in this repo).
- Never claim an action ran: copy says "tap to …".
- Run tests from `server/`: `npx vitest run <path>`. Full suite: `npm test`.

## Review Focus

1. **WhatsApp link preview fetching `/a/:code`.** WhatsApp fetches links to build previews, and a user may open the page twice. Expected: viewing the page never uses up the code; only the Shortcut's fetch does. Pinned in Task 4 (`page view does not consume the code`).
2. **Same step reported twice (Shortcut retry on a flaky network).** Expected: idempotent, with no duplicate result and no second follow-up. Pinned in Task 3 (`duplicate step report is ignored`).
3. **Final `done` POST lost, but every step reported ok.** Expected: the run finishes as done as soon as the last step's report arrives, without waiting 5 minutes for the sweeper. Pinned in Task 3 (`all steps reported ok finishes the run`).
4. **Briefing model writes a malformed marker** (bad JSON, unknown step, extra `]`, 4+ markers). Expected: those markers vanish, valid ones become links, and the briefing still sends. Pinned in Task 7.
5. **Flight reminder where 3h-before is already past or more than 24h away.** iOS alarms only take a clock time, so a wrong-day alarm would fire at the wrong moment. Expected: no alarm suggested. Pinned in Task 8.

---

## File Structure

| File | Responsibility |
|---|---|
| `server/src/services/appLinks.ts` (modify) | Export its `text()` cleaner as `cleanText` (with a `max` arg) and `InputError`. |
| `server/src/services/phoneSteps.ts` (new) | Pure step vocabulary: types, `validateSteps`, `unsupportedSteps`, `describeStep`. |
| `server/src/db/store.ts` (modify) | `phone_actions` + `phone_shortcut_status` tables, row types, CRUD, purge. |
| `server/src/services/phoneActions.ts` (new) | Config, code creation, page view, fetch, report, sweeper, chat tool entry, system-prompt section, marker expansion. |
| `server/src/services/phoneActionFollowups.ts` (new) | After a run finishes: failure message, known problems, check-in, report-back turn. |
| `server/src/services/phoneActionPage.ts` (new) | Pure HTML for `/a/:code`. |
| `server/src/routes/phoneActionRoutes.ts` (new) | Public routes. |
| `server/src/index.ts` (modify) | Mount routes before `/api` `requireAuth`. |
| `server/src/services/scheduler.ts` (modify) | Call the sweeper each tick. |
| `server/src/ai/assistant.ts` (modify) | `make_phone_action` tool, handler, system-prompt section. |
| `server/src/services/briefing.ts`, `emailDigest.ts` (modify) | Suggestion prompt + marker expansion. |
| `server/src/services/attentionRules.ts`, `attention.ts`, `db/store.ts` (modify) | `phoneStepsFor()` + attach link at send time. |
| `server/src/routes/portalRoutes.ts`, `client/src/api/client.ts`, `client/src/pages/PortalPage.tsx` (modify) | "Phone actions" tab. |
| `docs/marlowe-shortcut-build-guide.md`, `docs/marlowe-shortcut-device-check.md`, `README.md`, `changelog/…`, `feature-to-do/…`, `server/.env.example` | Docs. |

---

### Task 1: Step vocabulary (`phoneSteps.ts`)

**Files:**
- Modify: `server/src/services/appLinks.ts:28-45`
- Create: `server/src/services/phoneSteps.ts`
- Test: `server/src/services/phoneSteps.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `appLinks.ts`: `export class InputError extends Error`, `export function cleanText(value: unknown, field: string, max?: number): string | undefined` (throws `InputError` on non-string).
  - `phoneSteps.ts`: `STEP_TYPES`, `type StepType`, `type PhoneStep`, `REPORT_STEP_TYPES: readonly StepType[]`, `MAX_STEPS = 8`, `supportedStepTypes(version: number): readonly StepType[]`, `unsupportedSteps(steps: PhoneStep[], version: number): StepType[]`, `validateSteps(input: unknown, version: number): { steps: PhoneStep[] } | { error: string }`, `describeStep(step: PhoneStep): string`.

- [ ] **Step 1: Export the cleaner from appLinks.ts**

In `server/src/services/appLinks.ts`, change `class InputError extends Error {}` to `export class InputError extends Error {}`. Change the `text` function signature and its cap, and add the export alias right after the function:

```ts
function text(value: unknown, field: string, max: number = MAX_TEXT): string | undefined {
  // …body unchanged except the slice line:
  const cleaned = Array.from(collapsed).slice(0, max).join("").trimEnd();
  return cleaned || undefined;
}

// Shared with phoneSteps.ts so model text reaching the phone is cleaned exactly like link text.
export { text as cleanText };
```

Run: `cd server && npx vitest run src/services/appLinks.test.ts`
Expected: PASS (behaviour unchanged).

- [ ] **Step 2: Write the failing tests**

Create `server/src/services/phoneSteps.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { validateSteps, unsupportedSteps, describeStep, STEP_TYPES, type PhoneStep } from "./phoneSteps.js";

function ok(input: unknown, version = 1): PhoneStep[] {
  const r = validateSteps(input, version);
  if ("error" in r) throw new Error(`expected steps, got error: ${r.error}`);
  return r.steps;
}
function err(input: unknown, version = 1): string {
  const r = validateSteps(input, version);
  if (!("error" in r)) throw new Error(`expected an error, got ${JSON.stringify(r.steps)}`);
  return r.error;
}

describe("validateSteps — list shape", () => {
  it("rejects a non-list, an empty list and more than 8 steps", () => {
    expect(err({ type: "alarm" })).toMatch(/list of 1 to 8/);
    expect(err([])).toMatch(/list of 1 to 8/);
    expect(err(Array(9).fill({ type: "get_battery" }))).toMatch(/list of 1 to 8/);
  });

  it("rejects an unknown type with the step number", () => {
    expect(err([{ type: "get_battery" }, { type: "launch_rocket" }])).toMatch(/step 2.*unknown type/);
  });

  it("requires run_shortcut to be last", () => {
    expect(err([{ type: "run_shortcut", name: "Home" }, { type: "get_battery" }])).toMatch(/run_shortcut.*last/);
    expect(ok([{ type: "get_battery" }, { type: "run_shortcut", name: "Home" }])).toHaveLength(2);
  });
});

describe("validateSteps — fields", () => {
  it("alarm needs a 24-hour HH:MM", () => {
    expect(ok([{ type: "alarm", time: "05:15", label: "Flight" }])).toEqual([{ type: "alarm", time: "05:15", label: "Flight" }]);
    expect(err([{ type: "alarm", time: "5:15" }])).toMatch(/step 1: time must be HH:MM/);
    expect(err([{ type: "alarm", time: "24:00" }])).toMatch(/HH:MM/);
  });

  it("timer minutes must be a whole number 1–1440", () => {
    expect(ok([{ type: "timer", minutes: 10 }])).toEqual([{ type: "timer", minutes: 10 }]);
    expect(err([{ type: "timer", minutes: 0 }])).toMatch(/minutes must be a whole number from 1 to 1440/);
    expect(err([{ type: "timer", minutes: 2.5 }])).toMatch(/whole number/);
  });

  it("calendar_event needs local start/end with end after start", () => {
    expect(ok([{ type: "calendar_event", title: "Gym", start: "2026-10-13T07:00", end: "2026-10-13T08:00" }])).toHaveLength(1);
    expect(err([{ type: "calendar_event", title: "Gym", start: "2026-10-13T08:00", end: "2026-10-13T07:00" }])).toMatch(/end must be after start/);
    expect(err([{ type: "calendar_event", title: "Gym", start: "tomorrow", end: "2026-10-13T08:00" }])).toMatch(/YYYY-MM-DDTHH:MM/);
  });

  it("focus needs a name and on:boolean", () => {
    expect(ok([{ type: "focus", name: "Work", on: true, until: "17:00" }])).toEqual([{ type: "focus", name: "Work", on: true, until: "17:00" }]);
    expect(err([{ type: "focus", name: "Work", on: "yes" }])).toMatch(/on must be true or false/);
  });

  it("volume/brightness percent 0–100", () => {
    expect(ok([{ type: "volume", percent: 0 }])).toHaveLength(1);
    expect(err([{ type: "brightness", percent: 101 }])).toMatch(/percent/);
  });

  it("text caps body at 500 and strips invisible formatting", () => {
    const [step] = ok([{ type: "text", to: "Jake", body: `on\u202e my way ${"x".repeat(600)}` }]);
    expect(step).toMatchObject({ type: "text", to: "Jake" });
    const body = (step as { body: string }).body;
    expect(body.startsWith("on my way")).toBe(true);
    expect(Array.from(body).length).toBe(500);
  });

  it("open_url only takes https", () => {
    expect(ok([{ type: "open_url", url: "https://m.uber.com/ul/?action=setPickup" }])).toHaveLength(1);
    expect(err([{ type: "open_url", url: "javascript:alert(1)" }])).toMatch(/https/);
    expect(err([{ type: "open_url", url: "shortcuts://run-shortcut?name=x" }])).toMatch(/https/);
  });

  it("get_health metric is an enum, ask needs a prompt", () => {
    expect(ok([{ type: "get_health", metric: "steps_today" }])).toHaveLength(1);
    expect(err([{ type: "get_health", metric: "heart_rate" }])).toMatch(/metric must be one of/);
    expect(err([{ type: "ask" }])).toMatch(/prompt is required/);
  });

  it("drops unknown extra fields", () => {
    expect(ok([{ type: "get_battery", evil: "x" }])).toEqual([{ type: "get_battery" }]);
  });
});

describe("versions", () => {
  it("version 1 supports every step type", () => {
    const all = STEP_TYPES.map((type) => ({ type }) as PhoneStep);
    expect(unsupportedSteps(all, 1)).toEqual([]);
  });

  it("version 0 (unknown/older) supports nothing", () => {
    expect(unsupportedSteps([{ type: "get_battery" }], 0)).toEqual(["get_battery"]);
    expect(err([{ type: "get_battery" }], 0)).toMatch(/version 0.*can't do "get_battery"/);
  });

  it("a newer Shortcut than the server knows gets the newest known list", () => {
    expect(unsupportedSteps([{ type: "get_battery" }], 99)).toEqual([]);
  });
});

describe("describeStep", () => {
  it("words each step plainly", () => {
    expect(describeStep({ type: "alarm", time: "05:15", label: "Flight" })).toBe("set an alarm for 05:15 (Flight)");
    expect(describeStep({ type: "focus", name: "Work", on: true, until: "17:00" })).toBe("turn Work Focus on until 17:00");
    expect(describeStep({ type: "text", to: "Jake", body: "x".repeat(100) })).toBe(`text Jake: "${"x".repeat(60)}…"`);
    expect(describeStep({ type: "get_location" })).toBe("send Marlowe your location");
    expect(describeStep({ type: "run_shortcut", name: "Home" })).toBe('run your "Home" Shortcut');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd server && npx vitest run src/services/phoneSteps.test.ts`
Expected: FAIL, "Failed to resolve import ./phoneSteps.js".

- [ ] **Step 4: Implement `phoneSteps.ts`**

Create `server/src/services/phoneSteps.ts`:

```ts
// The vocabulary the "Marlowe" Apple Shortcut understands. Marlowe (chat tool, briefing markers,
// reminders) hands over a list of steps; this validates them into a fixed shape before anything is
// stored, so the Shortcut only ever sees fields it was built for. Pure — pinned by phoneSteps.test.ts.
// See docs/superpowers/specs/2026-10-12-marlowe-shortcut-design.md.
import { cleanText, InputError } from "./appLinks.js";

export const STEP_TYPES = [
  "alarm", "timer", "reminder", "calendar_event",
  "focus", "low_power", "volume", "brightness", "wifi", "bluetooth",
  "text", "call", "facetime",
  "open_url", "directions", "note", "clipboard",
  "run_shortcut",
  "get_location", "get_battery", "get_health", "ask",
] as const;
export type StepType = (typeof STEP_TYPES)[number];

export const REPORT_STEP_TYPES: readonly StepType[] = ["get_location", "get_battery", "get_health", "ask"];
export const MAX_STEPS = 8;

// Which step types each published Shortcut version can run. Add a key when a new Shortcut version
// ships; never edit an old one.
const STEPS_BY_VERSION: Record<number, readonly StepType[]> = { 1: STEP_TYPES };

const HEALTH_METRICS = ["sleep_last_night", "steps_today"] as const;
const DIRECTION_MODES = ["drive", "walk", "transit"] as const;

export type PhoneStep =
  | { type: "alarm"; time: string; label?: string }
  | { type: "timer"; minutes: number }
  | { type: "reminder"; title: string; due?: string; list?: string }
  | { type: "calendar_event"; title: string; start: string; end: string; location?: string }
  | { type: "focus"; name: string; on: boolean; until?: string }
  | { type: "low_power" | "wifi" | "bluetooth"; on: boolean }
  | { type: "volume" | "brightness"; percent: number }
  | { type: "text"; to: string; body: string }
  | { type: "call" | "facetime"; to: string }
  | { type: "open_url"; url: string }
  | { type: "directions"; destination: string; mode?: (typeof DIRECTION_MODES)[number] }
  | { type: "note"; title: string; body: string }
  | { type: "clipboard"; text: string }
  | { type: "run_shortcut"; name: string }
  | { type: "get_location" }
  | { type: "get_battery" }
  | { type: "get_health"; metric: (typeof HEALTH_METRICS)[number] }
  | { type: "ask"; prompt: string };

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const LOCAL_DATETIME = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/;

type Raw = Record<string, unknown>;

function req(raw: Raw, field: string, max = 200): string {
  const t = cleanText(raw[field], field, max);
  if (!t) throw new InputError(`${field} is required for this step.`);
  return t;
}
function opt(raw: Raw, field: string, max = 200): string | undefined {
  return cleanText(raw[field], field, max);
}
function bool(raw: Raw, field: string): boolean {
  if (typeof raw[field] !== "boolean") throw new InputError(`${field} must be true or false.`);
  return raw[field] as boolean;
}
function int(raw: Raw, field: string, min: number, max: number): number {
  const v = raw[field];
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new InputError(`${field} must be a whole number from ${min} to ${max}.`);
  }
  return v;
}
function hhmm(raw: Raw, field: string, required: true): string;
function hhmm(raw: Raw, field: string, required: false): string | undefined;
function hhmm(raw: Raw, field: string, required: boolean): string | undefined {
  const v = required ? req(raw, field, 5) : opt(raw, field, 5);
  if (v !== undefined && !HHMM.test(v)) throw new InputError(`${field} must be HH:MM, 24-hour.`);
  return v;
}
function localDateTime(raw: Raw, field: string, required: true): string;
function localDateTime(raw: Raw, field: string, required: false): string | undefined;
function localDateTime(raw: Raw, field: string, required: boolean): string | undefined {
  const v = required ? req(raw, field, 16) : opt(raw, field, 16);
  if (v !== undefined && !LOCAL_DATETIME.test(v)) throw new InputError(`${field} must be YYYY-MM-DDTHH:MM in the user's local time.`);
  return v;
}
function oneOf<T extends string>(raw: Raw, field: string, options: readonly T[], required: boolean): T | undefined {
  const v = raw[field];
  if (v === undefined && !required) return undefined;
  if (typeof v !== "string" || !(options as readonly string[]).includes(v)) {
    throw new InputError(`${field} must be one of: ${options.join(", ")}.`);
  }
  return v as T;
}
function httpsUrl(raw: Raw, field: string): string {
  const v = req(raw, field, 2000);
  let parsed: URL;
  try {
    parsed = new URL(v);
  } catch {
    throw new InputError(`${field} must be a full https:// link.`);
  }
  if (parsed.protocol !== "https:") throw new InputError(`${field} must be a full https:// link.`);
  return parsed.toString();
}
function withOptional<T extends object>(base: T, extras: Record<string, unknown>): T {
  for (const [k, v] of Object.entries(extras)) if (v !== undefined) (base as Raw)[k] = v;
  return base;
}

function parseStep(raw: Raw): PhoneStep {
  const type = raw.type as StepType;
  switch (type) {
    case "alarm":
      return withOptional({ type, time: hhmm(raw, "time", true) }, { label: opt(raw, "label", 80) });
    case "timer":
      return { type, minutes: int(raw, "minutes", 1, 1440) };
    case "reminder":
      return withOptional({ type, title: req(raw, "title") }, { due: localDateTime(raw, "due", false), list: opt(raw, "list", 80) });
    case "calendar_event": {
      const start = localDateTime(raw, "start", true);
      const end = localDateTime(raw, "end", true);
      if (end <= start) throw new InputError("end must be after start.");
      return withOptional({ type, title: req(raw, "title"), start, end }, { location: opt(raw, "location") });
    }
    case "focus":
      return withOptional({ type, name: req(raw, "name", 60), on: bool(raw, "on") }, { until: hhmm(raw, "until", false) });
    case "low_power":
    case "wifi":
    case "bluetooth":
      return { type, on: bool(raw, "on") };
    case "volume":
    case "brightness":
      return { type, percent: int(raw, "percent", 0, 100) };
    case "text":
      return { type, to: req(raw, "to", 100), body: req(raw, "body", 500) };
    case "call":
    case "facetime":
      return { type, to: req(raw, "to", 100) };
    case "open_url":
      return { type, url: httpsUrl(raw, "url") };
    case "directions":
      return withOptional({ type, destination: req(raw, "destination") }, { mode: oneOf(raw, "mode", DIRECTION_MODES, false) });
    case "note":
      return { type, title: req(raw, "title"), body: req(raw, "body", 2000) };
    case "clipboard":
      return { type, text: req(raw, "text", 2000) };
    case "run_shortcut":
      return { type, name: req(raw, "name", 100) };
    case "get_location":
    case "get_battery":
      return { type };
    case "get_health":
      return { type, metric: oneOf(raw, "metric", HEALTH_METRICS, true)! };
    case "ask":
      return { type, prompt: req(raw, "prompt") };
  }
}

export function supportedStepTypes(version: number): readonly StepType[] {
  // A Shortcut newer than this server gets the newest list the server knows; an unknown older one
  // gets nothing, so Marlowe asks for an update rather than guessing.
  const known = Object.keys(STEPS_BY_VERSION).map(Number).filter((v) => v <= version);
  return known.length ? STEPS_BY_VERSION[Math.max(...known)] : [];
}

export function unsupportedSteps(steps: PhoneStep[], version: number): StepType[] {
  const supported = supportedStepTypes(version);
  return [...new Set(steps.map((s) => s.type).filter((t) => !supported.includes(t)))];
}

export function validateSteps(input: unknown, version: number): { steps: PhoneStep[] } | { error: string } {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_STEPS) {
    return { error: `steps must be a list of 1 to ${MAX_STEPS} steps.` };
  }
  const steps: PhoneStep[] = [];
  for (let i = 0; i < input.length; i++) {
    const value = input[i];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { error: `step ${i + 1} must be an object with a type.` };
    }
    const type = (value as Raw).type;
    if (typeof type !== "string" || !(STEP_TYPES as readonly string[]).includes(type)) {
      return { error: `step ${i + 1} has unknown type ${JSON.stringify(type)}.` };
    }
    try {
      steps.push(parseStep(value as Raw));
    } catch (e) {
      if (e instanceof InputError) return { error: `step ${i + 1}: ${e.message}` };
      throw e;
    }
  }
  if (steps.slice(0, -1).some((s) => s.type === "run_shortcut")) {
    return { error: "run_shortcut leaves the Marlowe Shortcut, so it must be the last step." };
  }
  const missing = unsupportedSteps(steps, version);
  if (missing.length) {
    return { error: `the installed Marlowe Shortcut (version ${version}) can't do ${missing.map((t) => `"${t}"`).join(", ")} yet.` };
  }
  return { steps };
}

function quoted(s: string, max = 60): string {
  const chars = Array.from(s);
  return `"${chars.length > max ? `${chars.slice(0, max).join("")}…` : s}"`;
}
const onOff = (on: boolean) => (on ? "on" : "off");

export function describeStep(step: PhoneStep): string {
  switch (step.type) {
    case "alarm": return `set an alarm for ${step.time}${step.label ? ` (${step.label})` : ""}`;
    case "timer": return `start a ${step.minutes}-minute timer`;
    case "reminder": return `add a reminder ${quoted(step.title)}${step.due ? ` for ${step.due.replace("T", " ")}` : ""}`;
    case "calendar_event": return `add ${quoted(step.title)} to your calendar at ${step.start.replace("T", " ")}`;
    case "focus": return `turn ${step.name} Focus ${onOff(step.on)}${step.until ? ` until ${step.until}` : ""}`;
    case "low_power": return `turn Low Power Mode ${onOff(step.on)}`;
    case "wifi": return `turn Wi-Fi ${onOff(step.on)}`;
    case "bluetooth": return `turn Bluetooth ${onOff(step.on)}`;
    case "volume": return `set volume to ${step.percent}%`;
    case "brightness": return `set brightness to ${step.percent}%`;
    case "text": return `text ${step.to}: ${quoted(step.body)}`;
    case "call": return `call ${step.to}`;
    case "facetime": return `FaceTime ${step.to}`;
    case "open_url": return `open ${new URL(step.url).hostname}`;
    case "directions": return `get directions to ${step.destination}`;
    case "note": return `make a note ${quoted(step.title)}`;
    case "clipboard": return "copy text to your clipboard";
    case "run_shortcut": return `run your ${quoted(step.name)} Shortcut`;
    case "get_location": return "send Marlowe your location";
    case "get_battery": return "send Marlowe your battery level";
    case "get_health": return step.metric === "sleep_last_night" ? "send Marlowe last night's sleep" : "send Marlowe today's steps";
    case "ask": return `ask you: ${quoted(step.prompt)}`;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && npx vitest run src/services/phoneSteps.test.ts src/services/appLinks.test.ts`
Expected: PASS. If `tsc` complains about `withOptional`'s return type for the union, cast the `return` in that case to `PhoneStep`.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/appLinks.ts server/src/services/phoneSteps.ts server/src/services/phoneSteps.test.ts
git commit -m "feat: phone step vocabulary for the Marlowe Shortcut"
```

---

### Task 2: Storage (`phone_actions`, `phone_shortcut_status`)

**Files:**
- Modify: `server/src/db/store.ts` (table block after the `attention_items` block near line 1109; types and functions near the attention functions; `deleteUserCompletely` near line 3895)
- Test: `server/src/db/phoneActionsStore.test.ts`

**Interfaces:**
- Consumes: none.
- Produces (all exported from `db/store.ts`):
  ```ts
  type PhoneActionSource = "chat" | "briefing" | "digest" | "reminder";
  type PhoneActionStatus = "offered" | "fetched" | "done" | "failed";
  interface PhoneStepJson { type: string; [key: string]: unknown }
  interface PhoneStepResult { index: number; ok: boolean; value?: unknown; error?: string; at: number }
  interface PhoneActionRow { id; ownerId; codeHash; source; phone: string | null; label; steps: PhoneStepJson[]; status; results: PhoneStepResult[]; version: number | null; createdAt; expiresAt; fetchedAt: number | null; finishedAt: number | null }
  interface ShortcutKnownProblem { type: string; detail: string; error: string; at: number }
  interface ShortcutStatusRow { ownerId; version; firstSeen; lastSeen; knownProblems: ShortcutKnownProblem[] }
  insertPhoneAction(a: { ownerId; codeHash; source; phone: string | null; label; steps: PhoneStepJson[]; createdAt; expiresAt }): number
  getPhoneActionByCodeHash(codeHash: string): PhoneActionRow | null
  updatePhoneAction(id: number, patch: Partial<Pick<PhoneActionRow, "status" | "results" | "version" | "fetchedAt" | "finishedAt">>): void
  listStalledPhoneActions(fetchedBefore: number): PhoneActionRow[]
  listRecentFinishedPhoneActions(ownerId: number, since: number): PhoneActionRow[]
  listPhoneActionsForPortal(limit?: number): (PhoneActionRow & { email: string | null })[]
  getShortcutStatus(ownerId: number): ShortcutStatusRow | null
  recordShortcutSeen(ownerId: number, version: number, now: number): void
  setShortcutKnownProblems(ownerId: number, problems: ShortcutKnownProblem[]): void
  ```

- [ ] **Step 1: Write the failing test**

Create `server/src/db/phoneActionsStore.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  findOrCreateUserByEmail,
  insertPhoneAction,
  getPhoneActionByCodeHash,
  updatePhoneAction,
  listStalledPhoneActions,
  listRecentFinishedPhoneActions,
  getShortcutStatus,
  recordShortcutSeen,
  setShortcutKnownProblems,
  deleteUserCompletely,
} from "./store.js";

let n = 0;
const user = () => findOrCreateUserByEmail(`phone-store-${Date.now()}-${++n}@example.com`);

function insert(ownerId: number, codeHash: string, now = 1_000) {
  return insertPhoneAction({
    ownerId, codeHash, source: "chat", phone: null, label: "Test",
    steps: [{ type: "get_battery" }], createdAt: now, expiresAt: now + 60_000,
  });
}

describe("phone_actions", () => {
  it("round-trips a row by code hash", () => {
    const u = user();
    const id = insert(u.id, `hash-${n}-a`);
    const row = getPhoneActionByCodeHash(`hash-${n}-a`)!;
    expect(row).toMatchObject({ id, ownerId: u.id, status: "offered", steps: [{ type: "get_battery" }], results: [], fetchedAt: null });
    expect(getPhoneActionByCodeHash("nope")).toBeNull();
  });

  it("updates status/results and lists stalled fetched rows", () => {
    const u = user();
    const id = insert(u.id, `hash-${n}-b`);
    updatePhoneAction(id, { status: "fetched", fetchedAt: 2_000, version: 1 });
    expect(listStalledPhoneActions(3_000).map((r) => r.id)).toContain(id);
    expect(listStalledPhoneActions(1_500).map((r) => r.id)).not.toContain(id);
    updatePhoneAction(id, { status: "done", finishedAt: 2_500, results: [{ index: 0, ok: true, value: 80, at: 2_400 }] });
    expect(listStalledPhoneActions(3_000).map((r) => r.id)).not.toContain(id);
    expect(listRecentFinishedPhoneActions(u.id, 2_000)[0]).toMatchObject({ id, results: [{ index: 0, ok: true, value: 80 }] });
  });
});

describe("phone_shortcut_status", () => {
  it("records first/last seen and known problems", () => {
    const u = user();
    expect(getShortcutStatus(u.id)).toBeNull();
    recordShortcutSeen(u.id, 1, 100);
    recordShortcutSeen(u.id, 2, 200);
    expect(getShortcutStatus(u.id)).toMatchObject({ version: 2, firstSeen: 100, lastSeen: 200, knownProblems: [] });
    setShortcutKnownProblems(u.id, [{ type: "focus", detail: "turn Work Focus on", error: "not found", at: 150 }]);
    expect(getShortcutStatus(u.id)!.knownProblems).toHaveLength(1);
  });

  it("deleteUserCompletely removes both tables' rows", () => {
    const u = user();
    insert(u.id, `hash-${n}-c`);
    recordShortcutSeen(u.id, 1, 100);
    deleteUserCompletely(u.id);
    expect(getPhoneActionByCodeHash(`hash-${n}-c`)).toBeNull();
    expect(getShortcutStatus(u.id)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run src/db/phoneActionsStore.test.ts`
Expected: FAIL, `insertPhoneAction` is not exported.

- [ ] **Step 3: Add tables**

In `server/src/db/store.ts`, directly after the `attention_items` `db.exec` block, add:

```ts
// One row per one-tap phone action Marlowe offered: the steps it will hand the "Marlowe" Apple
// Shortcut, stored under the SHA-256 of a one-time code (the code itself only ever lives in the
// link). services/phoneActions.ts is the only writer.
// See docs/superpowers/specs/2026-10-12-marlowe-shortcut-design.md.
db.exec(`
  CREATE TABLE IF NOT EXISTS phone_actions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id    INTEGER NOT NULL REFERENCES users(id),
    code_hash   TEXT NOT NULL UNIQUE,
    source      TEXT NOT NULL,
    phone       TEXT,
    label       TEXT NOT NULL,
    steps       TEXT NOT NULL,
    status      TEXT NOT NULL,
    results     TEXT NOT NULL DEFAULT '[]',
    version     INTEGER,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    fetched_at  INTEGER,
    finished_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_phone_actions_status_fetched ON phone_actions(status, fetched_at);
  CREATE INDEX IF NOT EXISTS idx_phone_actions_owner_finished ON phone_actions(owner_id, finished_at);
  CREATE TABLE IF NOT EXISTS phone_shortcut_status (
    owner_id       INTEGER PRIMARY KEY REFERENCES users(id),
    version        INTEGER NOT NULL,
    first_seen     INTEGER NOT NULL,
    last_seen      INTEGER NOT NULL,
    known_problems TEXT NOT NULL DEFAULT '[]'
  );
`);
```

- [ ] **Step 4: Add types and functions**

Add after the attention-item functions in `store.ts`:

```ts
// --- Phone actions (Marlowe Shortcut) -----------------------------------------------------------

export type PhoneActionSource = "chat" | "briefing" | "digest" | "reminder";
export type PhoneActionStatus = "offered" | "fetched" | "done" | "failed";
export interface PhoneStepJson { type: string; [key: string]: unknown }
export interface PhoneStepResult { index: number; ok: boolean; value?: unknown; error?: string; at: number }

export interface PhoneActionRow {
  id: number;
  ownerId: number;
  codeHash: string;
  source: PhoneActionSource;
  phone: string | null;
  label: string;
  steps: PhoneStepJson[];
  status: PhoneActionStatus;
  results: PhoneStepResult[];
  version: number | null;
  createdAt: number;
  expiresAt: number;
  fetchedAt: number | null;
  finishedAt: number | null;
}

export interface ShortcutKnownProblem { type: string; detail: string; error: string; at: number }
export interface ShortcutStatusRow {
  ownerId: number;
  version: number;
  firstSeen: number;
  lastSeen: number;
  knownProblems: ShortcutKnownProblem[];
}

const PHONE_ACTION_COLUMNS = `id, owner_id AS ownerId, code_hash AS codeHash, source, phone, label, steps, status, results,
  version, created_at AS createdAt, expires_at AS expiresAt, fetched_at AS fetchedAt, finished_at AS finishedAt`;

type PhoneActionDbRow = Omit<PhoneActionRow, "steps" | "results"> & { steps: string; results: string };

function phoneActionFromDb(row: PhoneActionDbRow): PhoneActionRow {
  return { ...row, steps: JSON.parse(row.steps), results: JSON.parse(row.results) };
}

export function insertPhoneAction(a: {
  ownerId: number;
  codeHash: string;
  source: PhoneActionSource;
  phone: string | null;
  label: string;
  steps: PhoneStepJson[];
  createdAt: number;
  expiresAt: number;
}): number {
  const info = db
    .prepare(
      `INSERT INTO phone_actions (owner_id, code_hash, source, phone, label, steps, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'offered', ?, ?)`
    )
    .run(a.ownerId, a.codeHash, a.source, a.phone, a.label, JSON.stringify(a.steps), a.createdAt, a.expiresAt);
  return Number(info.lastInsertRowid);
}

export function getPhoneActionByCodeHash(codeHash: string): PhoneActionRow | null {
  const row = db.prepare(`SELECT ${PHONE_ACTION_COLUMNS} FROM phone_actions WHERE code_hash = ?`).get(codeHash) as
    | PhoneActionDbRow
    | undefined;
  return row ? phoneActionFromDb(row) : null;
}

export function updatePhoneAction(
  id: number,
  patch: Partial<Pick<PhoneActionRow, "status" | "results" | "version" | "fetchedAt" | "finishedAt">>
): void {
  const columns: Record<string, string> = {
    status: "status", results: "results", version: "version", fetchedAt: "fetched_at", finishedAt: "finished_at",
  };
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of Object.entries(columns)) {
    if (!(key in patch)) continue;
    const value = patch[key as keyof typeof patch];
    sets.push(`${column} = ?`);
    values.push(key === "results" ? JSON.stringify(value) : value);
  }
  if (!sets.length) return;
  db.prepare(`UPDATE phone_actions SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
}

export function listStalledPhoneActions(fetchedBefore: number): PhoneActionRow[] {
  return (
    db
      .prepare(`SELECT ${PHONE_ACTION_COLUMNS} FROM phone_actions WHERE status = 'fetched' AND fetched_at < ?`)
      .all(fetchedBefore) as PhoneActionDbRow[]
  ).map(phoneActionFromDb);
}

export function listRecentFinishedPhoneActions(ownerId: number, since: number): PhoneActionRow[] {
  return (
    db
      .prepare(
        `SELECT ${PHONE_ACTION_COLUMNS} FROM phone_actions
         WHERE owner_id = ? AND finished_at IS NOT NULL AND finished_at >= ? ORDER BY finished_at DESC LIMIT 10`
      )
      .all(ownerId, since) as PhoneActionDbRow[]
  ).map(phoneActionFromDb);
}

export function listPhoneActionsForPortal(limit = 200): (PhoneActionRow & { email: string | null })[] {
  return (
    db
      .prepare(
        `SELECT ${PHONE_ACTION_COLUMNS.replace(/(^|,\s*)(\w+)/g, "$1p.$2")}, u.email AS email
         FROM phone_actions p LEFT JOIN users u ON u.id = p.owner_id ORDER BY p.created_at DESC LIMIT ?`
      )
      .all(limit) as (PhoneActionDbRow & { email: string | null })[]
  ).map((r) => ({ ...phoneActionFromDb(r), email: r.email }));
}

export function getShortcutStatus(ownerId: number): ShortcutStatusRow | null {
  const row = db
    .prepare(
      `SELECT owner_id AS ownerId, version, first_seen AS firstSeen, last_seen AS lastSeen, known_problems AS knownProblems
       FROM phone_shortcut_status WHERE owner_id = ?`
    )
    .get(ownerId) as (Omit<ShortcutStatusRow, "knownProblems"> & { knownProblems: string }) | undefined;
  return row ? { ...row, knownProblems: JSON.parse(row.knownProblems) } : null;
}

export function recordShortcutSeen(ownerId: number, version: number, now: number): void {
  db.prepare(
    `INSERT INTO phone_shortcut_status (owner_id, version, first_seen, last_seen) VALUES (?, ?, ?, ?)
     ON CONFLICT(owner_id) DO UPDATE SET version = excluded.version, last_seen = excluded.last_seen`
  ).run(ownerId, version, now, now);
}

export function setShortcutKnownProblems(ownerId: number, problems: ShortcutKnownProblem[]): void {
  db.prepare(`UPDATE phone_shortcut_status SET known_problems = ? WHERE owner_id = ?`).run(JSON.stringify(problems), ownerId);
}
```

`PHONE_ACTION_COLUMNS` begins with a newline-free `id`, so the `replace` prefixes every column with `p.`. If that regex reads as too clever, write the portal query's column list out by hand instead. Either is fine; the test in Task 9 pins the result.

- [ ] **Step 5: Purge in `deleteUserCompletely`**

Next to `db.prepare(\`DELETE FROM attention_items WHERE owner_id = ?\`).run(ownerId);` add:

```ts
    db.prepare(`DELETE FROM phone_actions WHERE owner_id = ?`).run(ownerId);
    db.prepare(`DELETE FROM phone_shortcut_status WHERE owner_id = ?`).run(ownerId);
```

- [ ] **Step 6: Run tests**

Run: `cd server && npx vitest run src/db/phoneActionsStore.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/db/store.ts server/src/db/phoneActionsStore.test.ts
git commit -m "feat: phone_actions and phone_shortcut_status tables"
```

---

### Task 3: Core service (`phoneActions.ts`) — create, fetch, report, sweep

**Files:**
- Create: `server/src/services/phoneActions.ts`
- Create: `server/src/services/phoneActionFollowups.ts` (stub here; filled in Task 5)
- Test: `server/src/services/phoneActions.test.ts`

**Interfaces:**
- Consumes: Task 1 (`validateSteps`, `unsupportedSteps`, `describeStep`, `PhoneStep`), Task 2 store functions, `SERVER_URL` from `server/src/config.ts`.
- Produces (from `phoneActions.ts`):
  ```ts
  CHAT_TTL_MS, PROACTIVE_TTL_MS, REPORT_WINDOW_MS, STALL_MS  // numbers
  isPhoneActionsConfigured(): boolean
  shortcutInstallUrl(): string
  currentShortcutVersion(): number
  hashCode(code: string): string
  actionPageUrl(code: string): string          // `${SERVER_URL}/a/${code}`
  actionFetchUrl(code: string): string         // `${SERVER_URL}/api/phone-actions/${code}`
  shortcutRunUrl(code: string): string         // shortcuts://run-shortcut?name=Marlowe&input=text&text=<encoded fetch url>
  createPhoneAction(ownerId: number, steps: PhoneStep[], opts: { source: PhoneActionSource; label: string; phone?: string | null; ttlMs: number; notAfter?: number; now?: number }): { code: string; url: string; summary: string[] }
  type PhoneActionView = { state: "ready"; label: string; summary: string[]; runUrl: string; installUrl: string } | { state: "gone"; installUrl: string }
  viewPhoneAction(code: string, now?: number): PhoneActionView
  type FetchOutcome = { kind: "steps"; steps: PhoneStepJson[]; reportUrl: string } | { kind: "update"; installUrl: string; message: string } | { kind: "gone"; message: string }
  fetchPhoneAction(code: string, version: number, now?: number): FetchOutcome
  type ReportOutcome = "ok" | "gone" | "bad_request"
  reportPhoneStep(code: string, body: Record<string, unknown>, now?: number): Promise<ReportOutcome>
  sweepStalledPhoneActions(now?: number): Promise<void>
  ```
- Produces (from `phoneActionFollowups.ts`): `handleFinishedPhoneAction(row: PhoneActionRow, now: number): Promise<void>`.

- [ ] **Step 1: Create the follow-up stub**

Create `server/src/services/phoneActionFollowups.ts`:

```ts
// What Marlowe does once a phone action finishes — filled in by the follow-ups task.
import type { PhoneActionRow } from "../db/store.js";

export async function handleFinishedPhoneAction(_row: PhoneActionRow, _now: number): Promise<void> {}
```

- [ ] **Step 2: Write the failing tests**

Create `server/src/services/phoneActions.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./phoneActionFollowups.js", () => ({ handleFinishedPhoneAction: vi.fn(async () => {}) }));

process.env.MARLOWE_SHORTCUT_ICLOUD_URL = "https://www.icloud.com/shortcuts/test";
const { handleFinishedPhoneAction } = await import("./phoneActionFollowups.js");
const pa = await import("./phoneActions.js");
const { findOrCreateUserByEmail, getPhoneActionByCodeHash, getShortcutStatus } = await import("../db/store.js");

let n = 0;
const user = () => findOrCreateUserByEmail(`phone-svc-${Date.now()}-${++n}@example.com`);
const T0 = 1_700_000_000_000;

function make(ownerId: number, steps = [{ type: "alarm", time: "05:15" }, { type: "get_battery" }] as const) {
  return pa.createPhoneAction(ownerId, [...steps] as never, { source: "chat", label: "Test", ttlMs: pa.CHAT_TTL_MS, now: T0 });
}

beforeEach(() => vi.mocked(handleFinishedPhoneAction).mockClear());

describe("createPhoneAction", () => {
  it("stores only the hash and returns the page url + summary", () => {
    const u = user();
    const { code, url, summary } = make(u.id);
    expect(code).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(url).toMatch(new RegExp(`/a/${code}$`));
    expect(summary).toEqual(["set an alarm for 05:15", "send Marlowe your battery level"]);
    const row = getPhoneActionByCodeHash(pa.hashCode(code))!;
    expect(row.codeHash).not.toContain(code);
    expect(row.expiresAt).toBe(T0 + pa.CHAT_TTL_MS);
  });

  it("caps expiry at notAfter", () => {
    const u = user();
    const { code } = pa.createPhoneAction(u.id, [{ type: "get_battery" }], {
      source: "briefing", label: "x", ttlMs: pa.PROACTIVE_TTL_MS, notAfter: T0 + 1000, now: T0,
    });
    expect(getPhoneActionByCodeHash(pa.hashCode(code))!.expiresAt).toBe(T0 + 1000);
  });

  it("run url carries the fetch url as Shortcut input", () => {
    expect(pa.shortcutRunUrl("abc")).toBe(
      `shortcuts://run-shortcut?name=Marlowe&input=text&text=${encodeURIComponent(pa.actionFetchUrl("abc"))}`
    );
  });
});

describe("fetchPhoneAction", () => {
  it("hands over the steps once, records the Shortcut version, then says gone", () => {
    const u = user();
    const { code } = make(u.id);
    const first = pa.fetchPhoneAction(code, 1, T0 + 1);
    expect(first).toMatchObject({ kind: "steps", steps: [{ type: "alarm", time: "05:15" }, { type: "get_battery" }] });
    expect(getShortcutStatus(u.id)).toMatchObject({ version: 1, lastSeen: T0 + 1 });
    expect(pa.fetchPhoneAction(code, 1, T0 + 2)).toMatchObject({ kind: "gone", message: expect.stringMatching(/already used/) });
  });

  it("is gone when expired or unknown", () => {
    const u = user();
    const { code } = make(u.id);
    expect(pa.fetchPhoneAction(code, 1, T0 + pa.CHAT_TTL_MS + 1)).toMatchObject({ kind: "gone", message: expect.stringMatching(/expired/) });
    expect(pa.fetchPhoneAction("unknown-code", 1, T0)).toMatchObject({ kind: "gone" });
  });

  it("asks an old Shortcut to update without using up the code", () => {
    const u = user();
    const { code } = make(u.id);
    expect(pa.fetchPhoneAction(code, 0, T0 + 1)).toMatchObject({ kind: "update", installUrl: "https://www.icloud.com/shortcuts/test" });
    expect(pa.fetchPhoneAction(code, 1, T0 + 2)).toMatchObject({ kind: "steps" });
  });
});

describe("viewPhoneAction", () => {
  it("page view does not consume the code", () => {
    const u = user();
    const { code } = make(u.id);
    expect(pa.viewPhoneAction(code, T0 + 1)).toMatchObject({ state: "ready", label: "Test" });
    expect(pa.viewPhoneAction(code, T0 + 2)).toMatchObject({ state: "ready" });
    expect(pa.fetchPhoneAction(code, 1, T0 + 3)).toMatchObject({ kind: "steps" });
    expect(pa.viewPhoneAction(code, T0 + 4)).toMatchObject({ state: "gone" });
  });
});

describe("reportPhoneStep", () => {
  function fetched(ownerId: number) {
    const { code } = make(ownerId);
    pa.fetchPhoneAction(code, 1, T0);
    return code;
  }

  it("rejects reports before fetch, after the window, and with bad bodies", async () => {
    const u = user();
    const { code } = make(u.id);
    expect(await pa.reportPhoneStep(code, { index: 0, ok: true }, T0)).toBe("gone");
    const code2 = fetched(u.id);
    expect(await pa.reportPhoneStep(code2, { index: 5, ok: true }, T0 + 1)).toBe("bad_request");
    expect(await pa.reportPhoneStep(code2, { index: 0 }, T0 + 1)).toBe("bad_request");
    expect(await pa.reportPhoneStep(code2, { index: 0, ok: true }, T0 + pa.REPORT_WINDOW_MS + 1)).toBe("gone");
  });

  it("duplicate step report is ignored", async () => {
    const u = user();
    const code = fetched(u.id);
    await pa.reportPhoneStep(code, { index: 0, ok: true }, T0 + 1);
    await pa.reportPhoneStep(code, { index: 0, ok: true }, T0 + 2);
    expect(getPhoneActionByCodeHash(pa.hashCode(code))!.results).toHaveLength(1);
  });

  it("all steps reported ok finishes the run", async () => {
    const u = user();
    const code = fetched(u.id);
    await pa.reportPhoneStep(code, { index: 0, ok: true }, T0 + 1);
    await pa.reportPhoneStep(code, { index: 1, ok: true, value: 54 }, T0 + 2);
    const row = getPhoneActionByCodeHash(pa.hashCode(code))!;
    expect(row).toMatchObject({ status: "done", finishedAt: T0 + 2 });
    expect(handleFinishedPhoneAction).toHaveBeenCalledTimes(1);
    expect(await pa.reportPhoneStep(code, { done: true }, T0 + 3)).toBe("gone");
    expect(handleFinishedPhoneAction).toHaveBeenCalledTimes(1);
  });

  it("a failed step finishes the run as failed with the error", async () => {
    const u = user();
    const code = fetched(u.id);
    await pa.reportPhoneStep(code, { index: 0, ok: false, error: "x".repeat(400) }, T0 + 1);
    const row = getPhoneActionByCodeHash(pa.hashCode(code))!;
    expect(row.status).toBe("failed");
    expect(row.results[0].error).toHaveLength(300);
    expect(handleFinishedPhoneAction).toHaveBeenCalledTimes(1);
  });

  it("an explicit done finishes the run", async () => {
    const u = user();
    const code = fetched(u.id);
    expect(await pa.reportPhoneStep(code, { done: true }, T0 + 1)).toBe("ok");
    expect(getPhoneActionByCodeHash(pa.hashCode(code))!.status).toBe("done");
  });
});

describe("sweepStalledPhoneActions", () => {
  it("fails a run that went quiet at the next unreported step", async () => {
    const u = user();
    const { code } = make(u.id);
    pa.fetchPhoneAction(code, 1, T0);
    await pa.reportPhoneStep(code, { index: 0, ok: true }, T0 + 1);
    await pa.sweepStalledPhoneActions(T0 + pa.STALL_MS - 1);
    expect(getPhoneActionByCodeHash(pa.hashCode(code))!.status).toBe("fetched");
    await pa.sweepStalledPhoneActions(T0 + pa.STALL_MS + 1);
    const row = getPhoneActionByCodeHash(pa.hashCode(code))!;
    expect(row.status).toBe("failed");
    expect(row.results.at(-1)).toMatchObject({ index: 1, ok: false, error: expect.stringMatching(/stopped/) });
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd server && npx vitest run src/services/phoneActions.test.ts`
Expected: FAIL, cannot resolve `./phoneActions.js`.

- [ ] **Step 4: Implement `phoneActions.ts`**

Create `server/src/services/phoneActions.ts`:

```ts
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
  if (!usable(row, now)) {
    const used = row !== null && row.status !== "offered";
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
```

- [ ] **Step 5: Run tests**

Run: `cd server && npx vitest run src/services/phoneActions.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/phoneActions.ts server/src/services/phoneActionFollowups.ts server/src/services/phoneActions.test.ts
git commit -m "feat: phone action codes — create, fetch once, per-step reports, stall sweep"
```

---

### Task 4: Public routes, landing page, scheduler sweep

**Files:**
- Create: `server/src/services/phoneActionPage.ts`
- Create: `server/src/routes/phoneActionRoutes.ts`
- Modify: `server/src/index.ts:87` (mount next to `checkinRoutes`)
- Modify: `server/src/services/scheduler.ts` (inside `tick()`, after the per-owner loop)
- Test: `server/src/routes/phoneActionRoutes.test.ts`

**Interfaces:**
- Consumes: Task 3 `viewPhoneAction`, `fetchPhoneAction`, `reportPhoneStep`, `sweepStalledPhoneActions`, `createPhoneAction`, `CHAT_TTL_MS`.
- Produces: `renderActionPage(view: PhoneActionView): string`; `phoneActionRoutes: Router`.

- [ ] **Step 1: Write the failing test**

Create `server/src/routes/phoneActionRoutes.test.ts`:

```ts
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
    expect(res.text).toContain("send Marlowe your battery level");
    expect(res.text).toContain("shortcuts://run-shortcut?name=Marlowe");
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
    const first = await request(app).get(`/api/phone-actions/${code}`).set("X-Marlowe-Shortcut", "1");
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ steps: [{ type: "get_battery" }], reportUrl: expect.stringMatching(new RegExp(`/api/phone-actions/${code}/report$`)) });
    const second = await request(app).get(`/api/phone-actions/${code}`).set("X-Marlowe-Shortcut", "1");
    expect(second.status).toBe(410);
    expect(second.body.message).toMatch(/already used/);
  });

  it("returns an update for an old version", async () => {
    const res = await request(app).get(`/api/phone-actions/${newCode()}`).set("X-Marlowe-Shortcut", "0");
    expect(res.status).toBe(200);
    expect(res.body.update).toMatchObject({ installUrl: "https://www.icloud.com/shortcuts/test" });
  });
});

describe("POST /api/phone-actions/:code/report", () => {
  it("accepts a step report after fetch, 400 on a bad body, 410 when unknown", async () => {
    const code = newCode([{ type: "get_battery" }, { type: "get_location" }]);
    await request(app).get(`/api/phone-actions/${code}`).set("X-Marlowe-Shortcut", "1");
    expect((await request(app).post(`/api/phone-actions/${code}/report`).send({ index: 0, ok: true, value: 80 })).status).toBe(200);
    expect((await request(app).post(`/api/phone-actions/${code}/report`).send({ index: "x" })).status).toBe(400);
    expect((await request(app).post(`/api/phone-actions/nope/report`).send({ index: 0, ok: true })).status).toBe(410);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && npx vitest run src/routes/phoneActionRoutes.test.ts`
Expected: FAIL, cannot resolve `./phoneActionRoutes.js`.

- [ ] **Step 3: Implement the page**

Create `server/src/services/phoneActionPage.ts`:

```ts
// The /a/:code landing page. WhatsApp only makes https links tappable, so Marlowe's links land
// here: it lists the steps in plain words, then hands off to the Shortcut. Pure HTML, no session.
import type { PhoneActionView } from "./phoneActions.js";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const STYLE = `body{font:17px/1.45 -apple-system,system-ui,sans-serif;margin:0;padding:24px 16px;background:#faf9f7;color:#1c1b19}
main{max-width:420px;margin:0 auto}h1{font-size:22px;margin:0 0 12px}ul{padding-left:20px}
a.run{display:block;text-align:center;background:#1c1b19;color:#fff;padding:14px;border-radius:12px;text-decoration:none;font-weight:600;margin:20px 0}
.small{font-size:14px;color:#6b6760}@media (prefers-color-scheme:dark){body{background:#151413;color:#ece9e4}a.run{background:#ece9e4;color:#151413}.small{color:#a29d95}}`;

function page(title: string, body: string, script = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main>${script}</body></html>`;
}

export function renderActionPage(view: PhoneActionView): string {
  const install = view.installUrl
    ? `<p class="small">Don't have the Marlowe Shortcut yet? <a href="${esc(view.installUrl)}">Add it</a> (one time), then come back and tap Run.</p>`
    : "";
  if (view.state === "gone") {
    return page("Link expired", `<h1>This link has expired or was already used</h1><p>Ask Marlowe again for a fresh one.</p>${install}`);
  }
  const steps = view.summary.map((s) => `<li>${esc(s)}</li>`).join("");
  // Opening the Shortcut straight away saves a tap; the button is there if iOS blocks the jump.
  const script = `<script>setTimeout(function(){location.href=${JSON.stringify(view.runUrl).replace(/</g, "\\u003c")}},300)</script>`;
  return page(
    view.label,
    `<h1>${esc(view.label)}</h1><p>Marlowe will:</p><ul>${steps}</ul><a class="run" href="${esc(view.runUrl)}">Run in Shortcuts</a>${install}`,
    script
  );
}
```

- [ ] **Step 4: Implement the routes**

Create `server/src/routes/phoneActionRoutes.ts`:

```ts
import { Router } from "express";
import { viewPhoneAction, fetchPhoneAction, reportPhoneStep } from "../services/phoneActions.js";
import { renderActionPage } from "../services/phoneActionPage.js";

// Public, mounted before the blanket /api requireAuth (like checkinRoutes): the "Marlowe" Shortcut
// has no session. The one-time code in the path is the only credential, and it only unlocks the
// steps Marlowe stored for it. See docs/superpowers/specs/2026-10-12-marlowe-shortcut-design.md.
export const phoneActionRoutes = Router();

phoneActionRoutes.get("/a/:code", (req, res) => {
  res
    .set("Cache-Control", "no-store")
    .set("Referrer-Policy", "no-referrer")
    .type("html")
    .send(renderActionPage(viewPhoneAction(req.params.code)));
});

phoneActionRoutes.get("/api/phone-actions/:code", (req, res) => {
  const header = Number(req.get("X-Marlowe-Shortcut"));
  const version = Number.isInteger(header) && header >= 0 ? header : 1;
  const outcome = fetchPhoneAction(req.params.code, version);
  res.set("Cache-Control", "no-store");
  if (outcome.kind === "gone") {
    res.status(410).json({ message: outcome.message });
  } else if (outcome.kind === "update") {
    res.json({ update: { installUrl: outcome.installUrl, message: outcome.message } });
  } else {
    res.json({ steps: outcome.steps, reportUrl: outcome.reportUrl });
  }
});

phoneActionRoutes.post("/api/phone-actions/:code/report", async (req, res) => {
  const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
  const outcome = await reportPhoneStep(req.params.code, body);
  if (outcome === "ok") res.json({ ok: true });
  else if (outcome === "gone") res.status(410).json({ message: "This run is no longer open." });
  else res.status(400).json({ message: "Bad report." });
});
```

- [ ] **Step 5: Mount and sweep**

In `server/src/index.ts`, add the import beside `checkinRoutes`:

```ts
import { phoneActionRoutes } from "./routes/phoneActionRoutes.js";
```

and directly after `app.use(checkinRoutes);` (line 87):

```ts
// Public: the "Marlowe" Shortcut calls these with a one-time code and no session.
app.use(phoneActionRoutes);
```

In `server/src/services/scheduler.ts`, import `sweepStalledPhoneActions` from `./phoneActions.js`. In `tick()`, after the `for (const ownerId of ownerIds)` loop closes, add:

```ts
  await sweepStalledPhoneActions().catch((err) => console.error("scheduler: phone action sweep failed", err));
```

The tick runs every 5 minutes, so a stalled run is reported 5–10 minutes after the tap.

- [ ] **Step 6: Run tests**

Run: `cd server && npx vitest run src/routes/phoneActionRoutes.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add server/src/services/phoneActionPage.ts server/src/routes/phoneActionRoutes.ts server/src/routes/phoneActionRoutes.test.ts server/src/index.ts server/src/services/scheduler.ts
git commit -m "feat: public phone action routes, landing page and stall sweep"
```

---

### Task 5: Follow-ups — failure message, known problems, report-back turn, system-prompt section

**Files:**
- Modify: `server/src/services/phoneActionFollowups.ts` (replace stub)
- Modify: `server/src/services/phoneActions.ts` (add `phonePromptSection`)
- Test: `server/src/services/phoneActionFollowups.test.ts`

**Interfaces:**
- Consumes: store (`getShortcutStatus`, `setShortcutKnownProblems`, `listPhoneNumbersForUser`, `appendWhatsAppMessage`, `saveCheckin`, `listRecentFinishedPhoneActions`), `sendWhatsAppMessage` and `isWhatsAppConfigured` from `../providers/whatsapp.js`, `queueForAssistant` from `./messageBatching.js`, `setUserTimezoneFromLocation` from `./userTimezone.js`, `describeStep` and `REPORT_STEP_TYPES` from `./phoneSteps.js`.
- Produces:
  - `handleFinishedPhoneAction(row, now)` (real).
  - `formatReportedValue(step: PhoneStep, value: unknown): string | null` (exported for tests).
  - `PROBLEM_TTL_MS` (30 days).
  - In `phoneActions.ts`: `phonePromptSection(ownerId: number, now?: number): string` (`""` when not configured).

- [ ] **Step 1: Write the failing tests**

Create `server/src/services/phoneActionFollowups.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../providers/whatsapp.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isWhatsAppConfigured: () => true,
  sendWhatsAppMessage: vi.fn(async () => "wamid.x"),
}));
vi.mock("./messageBatching.js", () => ({ queueForAssistant: vi.fn() }));

process.env.MARLOWE_SHORTCUT_ICLOUD_URL = "https://www.icloud.com/shortcuts/test";
const { sendWhatsAppMessage } = await import("../providers/whatsapp.js");
const { queueForAssistant } = await import("./messageBatching.js");
const { handleFinishedPhoneAction, formatReportedValue, PROBLEM_TTL_MS } = await import("./phoneActionFollowups.js");
const { phonePromptSection } = await import("./phoneActions.js");
const store = await import("../db/store.js");

let n = 0;
const T0 = 1_700_000_000_000;
function owner() {
  const u = store.findOrCreateUserByEmail(`phone-follow-${Date.now()}-${++n}@example.com`);
  store.recordShortcutSeen(u.id, 1, T0);
  return u.id;
}
function row(ownerId: number, steps: store.PhoneStepJson[], results: store.PhoneStepResult[], status: "done" | "failed", phone: string | null = "+447700900001"): store.PhoneActionRow {
  return {
    id: 1, ownerId, codeHash: "h", source: "chat", phone, label: "Test", steps, status, results,
    version: 1, createdAt: T0, expiresAt: T0 + 1, fetchedAt: T0, finishedAt: T0 + 10,
  };
}

beforeEach(() => {
  vi.mocked(sendWhatsAppMessage).mockClear();
  vi.mocked(queueForAssistant).mockClear();
});

describe("handleFinishedPhoneAction", () => {
  it("all do-steps ok: no message", async () => {
    const id = owner();
    await handleFinishedPhoneAction(row(id, [{ type: "alarm", time: "05:15" }], [{ index: 0, ok: true, at: T0 }], "done"), T0);
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(queueForAssistant).not.toHaveBeenCalled();
  });

  it("failure: one message naming the step, and a known problem", async () => {
    const id = owner();
    await handleFinishedPhoneAction(
      row(id, [{ type: "focus", name: "Work", on: true }], [{ index: 0, ok: false, error: "Focus not found", at: T0 }], "failed"),
      T0
    );
    expect(sendWhatsAppMessage).toHaveBeenCalledWith("+447700900001", expect.stringMatching(/Couldn't turn Work Focus on: Focus not found/));
    expect(store.getShortcutStatus(id)!.knownProblems).toEqual([
      { type: "focus", detail: "turn Work Focus on", error: "Focus not found", at: T0 },
    ]);
  });

  it("known problems replace the same step, drop old ones and cap at 10", async () => {
    const id = owner();
    store.setShortcutKnownProblems(id, [
      { type: "wifi", detail: "turn Wi-Fi off", error: "old", at: T0 - PROBLEM_TTL_MS - 1 },
      { type: "focus", detail: "turn Work Focus on", error: "first", at: T0 - 1 },
    ]);
    await handleFinishedPhoneAction(
      row(id, [{ type: "focus", name: "Work", on: true }], [{ index: 0, ok: false, error: "second", at: T0 }], "failed"),
      T0
    );
    expect(store.getShortcutStatus(id)!.knownProblems.map((p) => p.error)).toEqual(["second"]);
  });

  it("report-back values become a [From your phone] turn and location is saved as a check-in", async () => {
    const id = owner();
    await handleFinishedPhoneAction(
      row(
        id,
        [{ type: "get_location" }, { type: "get_battery" }],
        [
          { index: 0, ok: true, value: { latitude: 51.5, longitude: -0.12 }, at: T0 },
          { index: 1, ok: true, value: 54, at: T0 },
        ],
        "done"
      ),
      T0
    );
    expect(queueForAssistant).toHaveBeenCalledWith(id, "+447700900001", "", expect.any(Number), null, true);
    expect(store.listCheckins(id, 1)[0]).toMatchObject({ latitude: 51.5, longitude: -0.12 });
  });

  it("no phone on the row falls back to the user's first number; none at all sends nothing", async () => {
    const id = owner();
    await handleFinishedPhoneAction(row(id, [{ type: "get_battery" }], [{ index: 0, ok: true, value: 54, at: T0 }], "done", null), T0);
    expect(queueForAssistant).not.toHaveBeenCalled();
  });
});

describe("formatReportedValue", () => {
  it("words each report type and rejects junk", () => {
    expect(formatReportedValue({ type: "get_location" }, { latitude: 51.5, longitude: -0.12 })).toBe("location 51.5, -0.12");
    expect(formatReportedValue({ type: "get_location" }, "here")).toBeNull();
    expect(formatReportedValue({ type: "get_battery" }, 54)).toBe("battery 54%");
    expect(formatReportedValue({ type: "get_health", metric: "steps_today" }, 8042)).toBe("steps today: 8042");
    expect(formatReportedValue({ type: "ask", prompt: "Which hotel?" }, "The Hoxton")).toBe('answer to "Which hotel?": The Hoxton');
    expect(formatReportedValue({ type: "alarm", time: "05:00" }, 1)).toBeNull();
  });
});

describe("phonePromptSection", () => {
  it("lists version, fresh known problems and recent results", () => {
    const id = owner();
    store.setShortcutKnownProblems(id, [{ type: "focus", detail: "turn Work Focus on", error: "Focus not found", at: Date.now() }]);
    const text = phonePromptSection(id);
    expect(text).toMatch(/make_phone_action/);
    expect(text).toMatch(/version 1/);
    expect(text).toMatch(/turn Work Focus on.*Focus not found/);
  });

  it("tells the model about the install link when the Shortcut never ran", () => {
    const u = store.findOrCreateUserByEmail(`phone-follow-new-${Date.now()}@example.com`);
    expect(phonePromptSection(u.id)).toMatch(/hasn't run the Marlowe Shortcut yet/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && npx vitest run src/services/phoneActionFollowups.test.ts`
Expected: FAIL, `formatReportedValue` / `phonePromptSection` not exported.

- [ ] **Step 3: Implement follow-ups**

Replace `server/src/services/phoneActionFollowups.ts` with:

```ts
// What Marlowe does once a phone action finishes. These are replies to a tap the user just made,
// so they skip the attention gate. Success is silent (the phone already showed the alarm, the
// Focus change…); a failed step gets one message and is remembered so Marlowe doesn't repeat it;
// report-back values (location, battery, health, a typed answer) go back into the conversation.
import {
  getShortcutStatus,
  setShortcutKnownProblems,
  listPhoneNumbersForUser,
  appendWhatsAppMessage,
  saveCheckin,
  type PhoneActionRow,
  type ShortcutKnownProblem,
} from "../db/store.js";
import { isWhatsAppConfigured, sendWhatsAppMessage } from "../providers/whatsapp.js";
import { queueForAssistant } from "./messageBatching.js";
import { setUserTimezoneFromLocation } from "./userTimezone.js";
import { describeStep, REPORT_STEP_TYPES, type PhoneStep } from "./phoneSteps.js";

export const PROBLEM_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PROBLEMS = 10;

function followupPhone(row: PhoneActionRow): string | null {
  if (!isWhatsAppConfigured()) return null;
  return row.phone ?? listPhoneNumbersForUser(row.ownerId)[0]?.phone ?? null;
}

function locationOf(value: unknown): { latitude: number; longitude: number } | null {
  if (!value || typeof value !== "object") return null;
  const { latitude, longitude } = value as Record<string, unknown>;
  if (typeof latitude !== "number" || typeof longitude !== "number") return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { latitude, longitude };
}

export function formatReportedValue(step: PhoneStep, value: unknown): string | null {
  switch (step.type) {
    case "get_location": {
      const loc = locationOf(value);
      return loc ? `location ${loc.latitude}, ${loc.longitude}` : null;
    }
    case "get_battery":
      return typeof value === "number" ? `battery ${Math.round(value)}%` : null;
    case "get_health": {
      if (typeof value !== "number" && typeof value !== "string") return null;
      return `${step.metric === "sleep_last_night" ? "sleep last night" : "steps today"}: ${String(value).slice(0, 200)}`;
    }
    case "ask":
      return typeof value === "string" ? `answer to "${step.prompt}": ${value.slice(0, 1000)}` : null;
    default:
      return null;
  }
}

function rememberProblem(ownerId: number, problem: ShortcutKnownProblem, now: number): void {
  const status = getShortcutStatus(ownerId);
  if (!status) return;
  const kept = status.knownProblems.filter(
    (p) => now - p.at <= PROBLEM_TTL_MS && !(p.type === problem.type && p.detail === problem.detail)
  );
  setShortcutKnownProblems(ownerId, [...kept, problem].slice(-MAX_PROBLEMS));
}

export async function handleFinishedPhoneAction(row: PhoneActionRow, now: number): Promise<void> {
  const steps = row.steps as unknown as PhoneStep[];
  const phone = followupPhone(row);

  const failed = row.results.find((r) => !r.ok);
  if (failed && steps[failed.index]) {
    const step = steps[failed.index];
    const error = failed.error ?? "it didn't work";
    rememberProblem(row.ownerId, { type: step.type, detail: describeStep(step), error, at: now }, now);
    if (phone) {
      const hint = step.type === "focus" ? " Is there a Focus with exactly that name on your phone?" : "";
      const text = `Couldn't ${describeStep(step)}: ${error}.${hint}`;
      await sendWhatsAppMessage(phone, text);
      appendWhatsAppMessage(row.ownerId, phone, "assistant", text);
    }
  }

  const lines: string[] = [];
  for (const r of row.results) {
    const step = steps[r.index];
    if (!r.ok || !step || !REPORT_STEP_TYPES.includes(step.type)) continue;
    const line = formatReportedValue(step, r.value);
    if (!line) continue;
    lines.push(line);
    const loc = step.type === "get_location" ? locationOf(r.value) : null;
    if (loc) {
      saveCheckin(row.ownerId, { ...loc, country: null, city: null, checkedInAt: now, source: "phone" });
      setUserTimezoneFromLocation(row.ownerId, loc.latitude, loc.longitude);
    }
  }
  if (lines.length && phone) {
    const at = new Date(now).toISOString().slice(11, 16);
    const rowId = appendWhatsAppMessage(row.ownerId, phone, "user", `[From your phone at ${at} UTC, after tapping "${row.label}": ${lines.join("; ")}]`);
    // No inbound wamid to react to or quote — this turn came from the Shortcut, not a WhatsApp message.
    queueForAssistant(row.ownerId, phone, "", rowId, null, true);
  }
}
```

Check before running: `appendWhatsAppMessage` returns the row id (it does in `chatDispatch.handleLocation`). Also check that `setUserTimezoneFromLocation`'s signature is `(ownerId, latitude, longitude)` (same call in `chatDispatch.ts:86`). If `sendAssistantReply` uses the empty `inboundMessageId` for a reaction, guard it there: `if (reply.reaction && inboundMessageId)`. Otherwise fall through to a text reply.

- [ ] **Step 4: Implement `phonePromptSection` in `phoneActions.ts`**

Add the imports `getShortcutStatus` and `listRecentFinishedPhoneActions` from the store, `PROBLEM_TTL_MS` and `formatReportedValue` from `./phoneActionFollowups.js`, and `STEP_TYPES` from `./phoneSteps.js`. Then append:

```ts
const RECENT_RESULTS_MS = 2 * HOUR;

// Per-user context for the chat system prompt. Empty when the feature is off, so nothing about
// phone actions reaches the model on servers without the Shortcut configured.
export function phonePromptSection(ownerId: number, now = Date.now()): string {
  if (!isPhoneActionsConfigured()) return "";
  const lines = [
    "Phone actions: with make_phone_action you can send a one-tap link that runs steps on the user's iPhone through the Marlowe Shortcut " +
      `(${STEP_TYPES.join(", ")}). Offer one whenever it saves them effort, not only when asked — e.g. an alarm before an early flight, ` +
      "a Focus during a long meeting, a text to say they're running late. Combine related steps into one link. Never say it's done — say \"tap to …\". " +
      "Put the link on its own line. iPhone only.",
  ];
  const status = getShortcutStatus(ownerId);
  if (!status) {
    lines.push("The user hasn't run the Marlowe Shortcut yet: make_phone_action returns an install_url — send it first (\"first time: add the Marlowe Shortcut\"), then the action link.");
  } else {
    lines.push(`Their Marlowe Shortcut is version ${status.version}.`);
    const problems = status.knownProblems.filter((p) => now - p.at <= PROBLEM_TTL_MS);
    if (problems.length) {
      lines.push(`Known problems on their phone — don't repeat these unless they say it's fixed: ${problems.map((p) => `${p.detail} (${p.error})`).join("; ")}.`);
    }
  }
  const recent = listRecentFinishedPhoneActions(ownerId, now - RECENT_RESULTS_MS)
    .map((a) => {
      const steps = a.steps as unknown as PhoneStep[];
      const values = a.results
        .map((r) => (r.ok ? formatReportedValue(steps[r.index], r.value) : `failed to ${describeStep(steps[r.index])}: ${r.error ?? "unknown"}`))
        .filter(Boolean);
      return `${new Date(a.finishedAt!).toISOString().slice(11, 16)} UTC "${a.label}" ${a.status}${values.length ? ` — ${values.join("; ")}` : ""}`;
    });
  if (recent.length) lines.push(`Recent phone actions: ${recent.join(" | ")}.`);
  return lines.join("\n");
}
```

`phoneActionFollowups.ts` must not import `phoneActions.ts`, or the import becomes circular. Only `phoneActions.ts` imports the follow-ups file.

- [ ] **Step 5: Run tests**

Run: `cd server && npx vitest run src/services/phoneActionFollowups.test.ts src/services/phoneActions.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/phoneActionFollowups.ts server/src/services/phoneActionFollowups.test.ts server/src/services/phoneActions.ts server/src/services/whatsappReply.ts
git commit -m "feat: phone action follow-ups — failure messages, known problems, report-back turns"
```

---

### Task 6: Chat tool `make_phone_action`

**Files:**
- Modify: `server/src/services/phoneActions.ts` (add `makePhoneActionForChat`)
- Modify: `server/src/ai/assistant.ts` (tool list near `MAPS_TOOLS` line 1149; `buildToolsForOwner` line 1205; `runTool` switch near the `make_app_link` case line 1571; `buildSystemPrompt` return array line 2136)
- Test: `server/src/ai/assistant.phoneActions.test.ts`

**Interfaces:**
- Consumes: Task 3/5 exports, `validateSteps`, `cleanText`.
- Produces: `makePhoneActionForChat(ownerId: number, input: Record<string, unknown>, phone: string | null, now?: number): { url: string; summary: string[]; install_url?: string } | { error: string }`.

- [ ] **Step 1: Write the failing test**

Create `server/src/ai/assistant.phoneActions.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";

vi.mock("../providers/whatsapp.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sendWhatsAppMessage: vi.fn(),
}));

process.env.MARLOWE_SHORTCUT_ICLOUD_URL = "https://www.icloud.com/shortcuts/test";
const { runTool, buildToolsForOwner, buildSystemPrompt } = await import("./assistant.js");
const { findOrCreateUserByEmail, recordShortcutSeen } = await import("../db/store.js");

let n = 0;
const user = () => findOrCreateUserByEmail(`phone-tool-${Date.now()}-${++n}@example.com`);

describe("make_phone_action", () => {
  it("is offered when configured", () => {
    expect(buildToolsForOwner(user().id).map((t) => t.name)).toContain("make_phone_action");
  });

  it("returns a link, summary and install_url on first use", async () => {
    const u = user();
    const result = (await runTool(u.id, "make_phone_action", { label: "Early flight", steps: [{ type: "alarm", time: "05:15" }] })) as Record<string, unknown>;
    expect(result.url).toMatch(/\/a\/[A-Za-z0-9_-]{22}$/);
    expect(result.summary).toEqual(["set an alarm for 05:15"]);
    expect(result.install_url).toBe("https://www.icloud.com/shortcuts/test");
  });

  it("leaves out install_url once the Shortcut has run", async () => {
    const u = user();
    recordShortcutSeen(u.id, 1, Date.now());
    const result = (await runTool(u.id, "make_phone_action", { label: "x", steps: [{ type: "get_battery" }] })) as Record<string, unknown>;
    expect(result.install_url).toBeUndefined();
  });

  it("returns the validator's error", async () => {
    const result = await runTool(user().id, "make_phone_action", { label: "x", steps: [{ type: "alarm", time: "late" }] });
    expect(result).toEqual({ error: "step 1: time must be HH:MM, 24-hour." });
  });

  it("adds the phone section to the system prompt", () => {
    expect(buildSystemPrompt(user().id)).toMatch(/make_phone_action/);
  });
});
```

Check `runTool`'s real parameter order in `assistant.ts:1281` before running. The `connectEmail` test calls it as `runTool(ownerId, name, input, phone?)`. If the order differs, adjust the calls above.

- [ ] **Step 2: Run to verify failure**

Run: `cd server && npx vitest run src/ai/assistant.phoneActions.test.ts`
Expected: FAIL, tool not in list.

- [ ] **Step 3: Add `makePhoneActionForChat`**

In `server/src/services/phoneActions.ts`, add imports `getShortcutStatus` (already there from Task 5), `validateSteps` from `./phoneSteps.js`, and `cleanText, InputError` from `./appLinks.js`. Then:

```ts
export function makePhoneActionForChat(
  ownerId: number,
  input: Record<string, unknown>,
  phone: string | null,
  now = Date.now()
): { url: string; summary: string[]; install_url?: string } | { error: string } {
  const status = getShortcutStatus(ownerId);
  const validated = validateSteps(input.steps, status?.version ?? currentShortcutVersion());
  if ("error" in validated) {
    return status && validated.error.includes("can't do")
      ? { error: `${validated.error} Ask them to add the updated Marlowe Shortcut: ${shortcutInstallUrl()}` }
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
```

- [ ] **Step 4: Register the tool**

In `server/src/ai/assistant.ts`, import `isPhoneActionsConfigured, makePhoneActionForChat, phonePromptSection` from `../services/phoneActions.js` and `STEP_TYPES` from `../services/phoneSteps.js`. Below `MAPS_TOOLS`, add:

```ts
// Only sent when MARLOWE_SHORTCUT_ICLOUD_URL is set (see services/phoneActions.ts) — one tool for
// every on-phone step, so the step list grows without adding tools.
const PHONE_ACTION_TOOLS: Anthropic.Tool[] = [
  {
    name: "make_phone_action",
    description:
      "Make a one-tap link that runs steps on the user's iPhone through the Marlowe Shortcut. Nothing happens until they tap it — never say it's done. " +
      "Step fields: alarm {time HH:MM, label?} · timer {minutes} · reminder {title, due? YYYY-MM-DDTHH:MM, list?} · calendar_event {title, start, end (YYYY-MM-DDTHH:MM local), location?} · " +
      "focus {name e.g. Work/Sleep/Do Not Disturb, on, until? HH:MM} · low_power/wifi/bluetooth {on} · volume/brightness {percent} · " +
      "text {to (contact name or number), body} · call/facetime {to} · open_url {url https} · directions {destination, mode? drive|walk|transit} · note {title, body} · clipboard {text} · " +
      "run_shortcut {name} (must be last) · get_location · get_battery · get_health {metric sleep_last_night|steps_today} · ask {prompt}. " +
      "The get_*/ask steps send the answer back to you; it arrives as a [From your phone …] message. Max 8 steps. Call get_current_time first for relative days. " +
      "If the result has install_url, send that first (one-time setup), then the link. Put each link on its own line.",
    input_schema: {
      type: "object",
      properties: {
        label: { type: "string", description: "A few words for what this does, e.g. 'Early flight setup'." },
        steps: {
          type: "array",
          description: "Steps in the order to run them.",
          items: {
            type: "object",
            properties: { type: { type: "string", enum: [...STEP_TYPES] } },
            required: ["type"],
          },
        },
      },
      required: ["label", "steps"],
    },
  },
];
```

In `buildToolsForOwner`, after `if (isMapsConfigured()) result.push(...MAPS_TOOLS);`:

```ts
  if (isPhoneActionsConfigured()) result.push(...PHONE_ACTION_TOOLS);
```

In `runTool`, after the `make_app_link` case:

```ts
    case "make_phone_action":
      if (!isPhoneActionsConfigured()) return { error: "Phone actions aren't set up on this server." };
      return makePhoneActionForChat(ownerId, input, phone ?? null);
```

In `buildSystemPrompt`, add `phonePromptSection(ownerId),` as the last element of the array returned at line 2136. If that array isn't already filtered, change its `.join("\n\n")` to `.filter(Boolean).join("\n\n")`.

- [ ] **Step 5: Run tests**

Run: `cd server && npx vitest run src/ai/ && npx tsc -p tsconfig.json --noEmit`
Expected: PASS (including existing assistant tests).

- [ ] **Step 6: Commit**

```bash
git add server/src/services/phoneActions.ts server/src/ai/assistant.ts server/src/ai/assistant.phoneActions.test.ts
git commit -m "feat: make_phone_action tool and per-user phone context in the system prompt"
```

---

### Task 7: Briefing and evening digest suggestions

**Files:**
- Modify: `server/src/services/phoneActions.ts` (add `phoneSuggestionsEnabled`, `PHONE_SUGGESTION_PROMPT`, `expandPhoneMarkers`)
- Modify: `server/src/services/briefing.ts` (`renderBriefing` line ~315, `buildBriefingText` line ~342)
- Modify: `server/src/services/emailDigest.ts` (`DigestDay`, `digestFactBlock`, `renderDigest`, `digestText`)
- Test: `server/src/services/phoneMarkers.test.ts`

**Interfaces:**
- Consumes: `validateSteps`, `createPhoneAction`, `getShortcutStatus`, `PROACTIVE_TTL_MS`.
- Produces:
  - `phoneSuggestionsEnabled(ownerId: number): boolean`: configured AND status row exists.
  - `PHONE_SUGGESTION_PROMPT: string`.
  - `expandPhoneMarkers(ownerId: number, text: string, source: "briefing" | "digest", now?: number): string`.
  - `renderBriefing(ownerId, voice, day, purpose, extraSystem?: string)`.
  - `renderDigest(ownerId, voice, day, purpose, extraSystem?: string)`.
  - `DigestDay.tomorrowEvents?: string[]`.

- [ ] **Step 1: Write the failing test**

Create `server/src/services/phoneMarkers.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";

vi.mock("./phoneActionFollowups.js", () => ({ handleFinishedPhoneAction: vi.fn(async () => {}) }));
process.env.MARLOWE_SHORTCUT_ICLOUD_URL = "https://www.icloud.com/shortcuts/test";
const { expandPhoneMarkers, phoneSuggestionsEnabled, hashCode } = await import("./phoneActions.js");
const store = await import("../db/store.js");

let n = 0;
function owner(seen = true) {
  const u = store.findOrCreateUserByEmail(`phone-markers-${Date.now()}-${++n}@example.com`);
  if (seen) store.recordShortcutSeen(u.id, 1, Date.now());
  return u.id;
}
const LINK = /https?:\/\/[^\s]+\/a\/([A-Za-z0-9_-]{22})/g;

describe("expandPhoneMarkers", () => {
  it("turns a valid marker into 'label: url' and stores a briefing action", () => {
    const id = owner();
    const out = expandPhoneMarkers(id, 'Early flight tomorrow.\n[[phone|Tap for a 05:15 alarm|[{"type":"alarm","time":"05:15"}]]]', "briefing");
    expect(out).toMatch(/^Early flight tomorrow\.\nTap for a 05:15 alarm: https?:\/\/\S+\/a\/[A-Za-z0-9_-]{22}$/);
    const code = [...out.matchAll(LINK)][0][1];
    expect(store.getPhoneActionByCodeHash(hashCode(code))).toMatchObject({ source: "briefing", label: "Tap for a 05:15 alarm" });
  });

  it("drops invalid JSON, unknown steps and markers past the third", () => {
    const id = owner();
    const ok = '[[phone|A|[{"type":"get_battery"}]]]';
    const text = `x [[phone|Bad|[{"type":}]]] y [[phone|Nope|[{"type":"launch"}]]] ${ok} ${ok} ${ok} ${ok}`;
    const out = expandPhoneMarkers(id, text, "briefing");
    expect(out).not.toContain("[[phone");
    expect([...out.matchAll(LINK)]).toHaveLength(3);
    expect(out.startsWith("x y A:")).toBe(true);
  });

  it("strips markers without making links when the Shortcut never ran", () => {
    const id = owner(false);
    expect(phoneSuggestionsEnabled(id)).toBe(false);
    expect(expandPhoneMarkers(id, 'Hi [[phone|A|[{"type":"get_battery"}]]]', "digest")).toBe("Hi");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && npx vitest run src/services/phoneMarkers.test.ts`
Expected: FAIL, `expandPhoneMarkers` not exported.

- [ ] **Step 3: Implement markers in `phoneActions.ts`**

```ts
const MAX_SUGGESTIONS = 3;
// [[phone|<label>|<steps JSON array>]] — the array is captured up to the "]" that's followed by the
// closing "]]", so a "]" inside the JSON can't end it early. Step values never contain "]]]".
const MARKER = /\[\[phone\|([^|\n\]]{1,80})\|(\[[\s\S]*?\])\]\]/g;

export function phoneSuggestionsEnabled(ownerId: number): boolean {
  return isPhoneActionsConfigured() && getShortcutStatus(ownerId) !== null;
}

export const PHONE_SUGGESTION_PROMPT = [
  "The user has the Marlowe Shortcut on their iPhone, so you can offer up to 3 one-tap actions — but only when the calendar or bookings give a concrete reason:",
  "an early start or flight (an alarm, a Sleep Focus the night before), a long meeting (a Focus for its length), travel to an address (directions). No reason, no suggestion.",
  'Write each one on its own line exactly as [[phone|<what tapping does, a few words starting "Tap to">|<JSON array of steps>]], e.g.',
  '[[phone|Tap to set a 05:15 alarm and Sleep Focus at 22:30|[{"type":"alarm","time":"05:15","label":"Flight BA117"},{"type":"focus","name":"Sleep","on":true}]]]',
  "Step types: alarm {time HH:MM, label?}, timer {minutes}, reminder {title, due? YYYY-MM-DDTHH:MM}, focus {name, on, until? HH:MM}, directions {destination}, low_power {on}.",
  "Never say the action is done. The lines don't count toward your word limit.",
].join("\n");

export function expandPhoneMarkers(ownerId: number, text: string, source: "briefing" | "digest", now = Date.now()): string {
  const enabled = phoneSuggestionsEnabled(ownerId);
  const version = getShortcutStatus(ownerId)?.version ?? currentShortcutVersion();
  let made = 0;
  const out = text.replace(MARKER, (_whole, rawLabel: string, json: string) => {
    if (!enabled || made >= MAX_SUGGESTIONS) return "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return "";
    }
    const validated = validateSteps(parsed, version);
    if ("error" in validated) return "";
    const label = cleanText(rawLabel, "label", 80);
    if (!label) return "";
    made++;
    const { url } = createPhoneAction(ownerId, validated.steps, { source, label, ttlMs: PROACTIVE_TTL_MS, now });
    return `${label}: ${url}`;
  });
  // Dropped markers leave doubled spaces / blank lines behind.
  return out.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
```

- [ ] **Step 4: Wire into the briefing**

In `server/src/services/briefing.ts`:
- Import `phoneSuggestionsEnabled, PHONE_SUGGESTION_PROMPT, expandPhoneMarkers` from `./phoneActions.js`.
- Give `renderBriefing` a fifth parameter `extraSystem?: string` and change its `system:` line to `system: extraSystem ? \`${briefingSystemPrompt(voice)}\n\n${extraSystem}\` : briefingSystemPrompt(voice),`.
- In `buildBriefingText`, change the final `return renderBriefing(…, "daily_briefing");` to:

```ts
  const suggest = phoneSuggestionsEnabled(ownerId);
  const text = await renderBriefing(
    ownerId,
    /* …the same voice object as before… */,
    /* …the same day object as before… */,
    "daily_briefing",
    suggest ? PHONE_SUGGESTION_PROMPT : undefined
  );
  return expandPhoneMarkers(ownerId, text, "briefing");
```

Keep the existing voice/day object literals unchanged; only the call's tail and the return change. Briefing Lab (`briefingPreview.ts`) calls `renderBriefing` with four args, so it never gets the prompt and never creates actions.

- [ ] **Step 5: Wire into the evening digest**

In `server/src/services/emailDigest.ts`:
- Import `phoneSuggestionsEnabled, PHONE_SUGGESTION_PROMPT, expandPhoneMarkers` from `./phoneActions.js`, `hubListEvents` from `./hub.js`, `describeEventTime` from `./briefing.js` (already imports `getBriefingSettings` from there), `getUserTimezone` from `./userTimezone.js`, and `eventLocalDateKey` from `./eventTime.js`.
- Add to `DigestDay`: `/** Tomorrow's events, only fetched when phone suggestions are on. */ tomorrowEvents?: string[];`
- In `digestFactBlock`, add before the attention lines:

```ts
    day.tomorrowEvents?.length ? `Tomorrow's calendar: ${day.tomorrowEvents.join("; ")}` : "",
```

- Give `renderDigest` a fifth parameter `extraSystem?: string`, used the same way as in `renderBriefing`.
- In `digestText`, before building `day`:

```ts
  const suggest = phoneSuggestionsEnabled(ownerId);
  let tomorrowEvents: string[] | undefined;
  if (suggest) {
    const zone = getUserTimezone(ownerId);
    const tomorrow = DateTime.fromISO(userLocalClock(ownerId).dateKey).plus({ days: 1 }).toISODate();
    tomorrowEvents = (await hubListEvents(ownerId, 2).catch(() => []))
      .filter((e) => eventLocalDateKey(e.start, zone) === tomorrow)
      .map((e) => describeEventTime(e, zone));
  }
```

Add `tomorrowEvents` to the `day` literal. Change the `try` body to:

```ts
    const text = await renderDigest(ownerId, voice, day, "email_digest", suggest ? PHONE_SUGGESTION_PROMPT : undefined);
    return expandPhoneMarkers(ownerId, text, "digest");
```

If `emailDigest.ts` importing `briefing.ts` creates a new cycle, check whether `briefing.ts` imports `emailDigest.ts`. If it does, move `describeEventTime` into `eventTime.ts` and re-export it from `briefing.ts`.

- [ ] **Step 6: Run tests**

Run: `cd server && npx vitest run src/services/phoneMarkers.test.ts src/services/briefing.test.ts src/services/emailDigest.test.ts src/services/briefingPreview.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/services/phoneActions.ts server/src/services/phoneMarkers.test.ts server/src/services/briefing.ts server/src/services/emailDigest.ts
git commit -m "feat: briefing and evening digest can offer up to 3 one-tap phone actions"
```

---

### Task 8: Attention-gate reminders carry a fitting action

**Files:**
- Modify: `server/src/services/attentionRules.ts` (add `phoneStepsFor`)
- Modify: `server/src/services/attention.ts` (`prepareItem`, line ~115)
- Test: `server/src/services/attentionRules.phone.test.ts`

**Interfaces:**
- Consumes: `parseEventStart(value, zone)` from `attentionRules.ts:44` (returns `{ ms, hasTime? }` or null; check its exact return shape before writing and adjust the field names below), `PhoneStep`, `createPhoneAction`, `phoneSuggestionsEnabled`, `PROACTIVE_TTL_MS`.
- Produces: `phoneStepsFor(details: AttentionDetails, zone: string | null, now: number): { label: string; steps: PhoneStep[]; notAfter: number } | null`.

- [ ] **Step 1: Read `parseEventStart`**

Run: `cd server && sed -n 40,75p src/services/attentionRules.ts`
Note whether it reports a date-only value differently from a date-time one. The rule below needs to know whether a time is known. If `parseEventStart` doesn't say so, test the raw string with `/T\d{2}:\d{2}/`.

- [ ] **Step 2: Write the failing test**

Create `server/src/services/attentionRules.phone.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { phoneStepsFor } from "./attentionRules.js";

const zone = "Europe/London";
const now = Date.parse("2026-10-12T18:00:00+01:00");

describe("phoneStepsFor", () => {
  it("flight with a time: alarm 3h before, labelled with the flight number", () => {
    const s = phoneStepsFor({ summary: "Flight", kind: "flight", eventStart: "2026-10-13T08:15:00+01:00", flightNumber: "BA117" }, zone, now);
    expect(s).toMatchObject({ steps: [{ type: "alarm", time: "05:15", label: "Flight BA117" }], label: "Tap to set a 05:15 alarm" });
    expect(s!.notAfter).toBe(Date.parse("2026-10-13T05:15:00+01:00"));
  });

  it("flight with only a date: nothing", () => {
    expect(phoneStepsFor({ summary: "Flight", kind: "flight", eventStart: "2026-10-13" }, zone, now)).toBeNull();
  });

  it("alarm time already past: nothing", () => {
    expect(phoneStepsFor({ summary: "Flight", kind: "flight", eventStart: "2026-10-12T20:00:00+01:00" }, zone, now)).toBeNull();
  });

  it("alarm more than 24h away: nothing (an iOS alarm only takes a clock time)", () => {
    expect(phoneStepsFor({ summary: "Flight", kind: "flight", eventStart: "2026-10-14T23:00:00+01:00" }, zone, now)).toBeNull();
  });

  it("hotel or restaurant with a name: directions", () => {
    expect(phoneStepsFor({ summary: "Stay", kind: "hotel", merchant: "Hotel Eva, Faro", eventStart: "2026-10-13" }, zone, now)).toMatchObject({
      label: "Tap for directions to Hotel Eva, Faro",
      steps: [{ type: "directions", destination: "Hotel Eva, Faro" }],
    });
  });

  it("anything else: nothing", () => {
    expect(phoneStepsFor({ summary: "Invoice", kind: "other" }, zone, now)).toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd server && npx vitest run src/services/attentionRules.phone.test.ts`
Expected: FAIL, `phoneStepsFor` not exported.

- [ ] **Step 4: Implement `phoneStepsFor`**

Append to `server/src/services/attentionRules.ts` (import `DateTime` from luxon if it isn't already imported, and `type PhoneStep` from `./phoneSteps.js`):

```ts
const ALARM_LEAD_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// A one-tap phone action that fits a reminder, if any. An iOS alarm only takes a clock time and
// rings at its next occurrence, so it's only offered when that is within the next 24 hours.
export function phoneStepsFor(
  details: AttentionDetails,
  zone: string | null,
  now: number
): { label: string; steps: PhoneStep[]; notAfter: number } | null {
  if (details.kind === "flight" && details.eventStart && /T\d{2}:\d{2}/.test(details.eventStart)) {
    const start = DateTime.fromISO(details.eventStart, { setZone: true });
    if (!start.isValid) return null;
    const alarmMs = start.toMillis() - ALARM_LEAD_MS;
    if (alarmMs <= now || alarmMs - now > DAY_MS) return null;
    const time = DateTime.fromMillis(alarmMs, { zone: zone ?? "utc" }).toFormat("HH:mm");
    const label = details.flightNumber ? `Flight ${details.flightNumber}` : "Flight";
    return { label: `Tap to set a ${time} alarm`, steps: [{ type: "alarm", time, label }], notAfter: alarmMs };
  }
  if ((details.kind === "hotel" || details.kind === "restaurant") && details.merchant) {
    const destination = details.merchant.slice(0, 200);
    return { label: `Tap for directions to ${destination}`, steps: [{ type: "directions", destination }], notAfter: now + DAY_MS };
  }
  return null;
}
```

- [ ] **Step 5: Attach the link at send time**

In `server/src/services/attention.ts`, import `phoneStepsFor` from `./attentionRules.js` and `createPhoneAction, phoneSuggestionsEnabled, PROACTIVE_TTL_MS` from `./phoneActions.js`. In `prepareItem`, right after `if (offer) text += …;` and before `return { item, text, offer };`:

```ts
  // Created now, when the reminder actually goes out, so its expiry runs from when they see it.
  // Only scheduled reminders: an interrupt is about something that changed, not something to set up.
  if (item.tier !== "interrupt" && phoneSuggestionsEnabled(ownerId)) {
    const suggestion = phoneStepsFor(item.details, zone, now);
    if (suggestion) {
      const { url } = createPhoneAction(ownerId, suggestion.steps, {
        source: "reminder",
        label: suggestion.label,
        ttlMs: PROACTIVE_TTL_MS,
        notAfter: suggestion.notAfter,
        now,
      });
      text += `\n\n${suggestion.label}: ${url}`;
    }
  }
```

- [ ] **Step 6: Run tests**

Run: `cd server && npx vitest run src/services/attentionRules.phone.test.ts src/services/attention.test.ts src/services/attentionRules.test.ts`
Expected: PASS. Existing attention tests don't set `MARLOWE_SHORTCUT_ICLOUD_URL`, so their texts are unchanged.

- [ ] **Step 7: Commit**

```bash
git add server/src/services/attentionRules.ts server/src/services/attention.ts server/src/services/attentionRules.phone.test.ts
git commit -m "feat: flight and booking reminders carry a one-tap alarm or directions"
```

---

### Task 9: Portal "Phone actions" tab

**Files:**
- Modify: `server/src/routes/portalRoutes.ts` (new route under the Unmet requests section)
- Modify: `client/src/api/client.ts` (near `fetchUnmetRequests`, line 818)
- Modify: `client/src/pages/PortalPage.tsx` (`SECTIONS` line 39; render switch line 167; new `PhoneActionsTab`)
- Test: `server/src/routes/portalRoutes.test.ts` (add a case)

**Interfaces:**
- Consumes: `listPhoneActionsForPortal`.
- Produces: `GET /api/portal/phone-actions` → `PortalPhoneAction[]` where `{ id, email, source, label, status, steps: string[], failure: string | null, createdAt, finishedAt }`. The client exports `fetchPhoneActions()`.

- [ ] **Step 1: Write the failing test**

Open `server/src/routes/portalRoutes.test.ts` and follow how it builds its app with an admin user. Add:

```ts
describe("GET /phone-actions", () => {
  it("lists offered actions with plain-English steps and the failure", async () => {
    const owner = findOrCreateUserByEmail(`portal-phone-${Date.now()}@example.com`);
    const id = insertPhoneAction({
      ownerId: owner.id, codeHash: `portal-${Date.now()}`, source: "chat", phone: null, label: "Work mode",
      steps: [{ type: "focus", name: "Work", on: true }], createdAt: Date.now(), expiresAt: Date.now() + 1000,
    });
    updatePhoneAction(id, { status: "failed", results: [{ index: 0, ok: false, error: "Focus not found", at: Date.now() }], finishedAt: Date.now() });
    const res = await request(app).get("/phone-actions");
    expect(res.status).toBe(200);
    expect(res.body.find((r: { id: number }) => r.id === id)).toMatchObject({
      email: owner.email, source: "chat", label: "Work mode", status: "failed",
      steps: ["turn Work Focus on"], failure: "turn Work Focus on: Focus not found",
    });
  });
});
```

Import `insertPhoneAction`, `updatePhoneAction` and `findOrCreateUserByEmail` from `../db/store.js` at the top, and use that file's existing `app`/request helper.

- [ ] **Step 2: Run to verify failure**

Run: `cd server && npx vitest run src/routes/portalRoutes.test.ts`
Expected: FAIL with a 404.

- [ ] **Step 3: Add the route**

In `server/src/routes/portalRoutes.ts`, import `listPhoneActionsForPortal` from the store and `describeStep, type PhoneStep` from `../services/phoneSteps.js`. Add:

```ts
// --- Phone actions ------------------------------------------------------------------------------
// What testers were offered through the Marlowe Shortcut, and what ran or broke.

portalRoutes.get("/phone-actions", (_req, res) => {
  res.json(
    listPhoneActionsForPortal().map((a) => {
      const steps = a.steps as unknown as PhoneStep[];
      const failed = a.results.find((r) => !r.ok);
      return {
        id: a.id,
        email: a.email,
        source: a.source,
        label: a.label,
        status: a.status,
        steps: steps.map(describeStep),
        failure: failed ? `${describeStep(steps[failed.index])}: ${failed.error ?? "unknown"}` : null,
        createdAt: a.createdAt,
        finishedAt: a.finishedAt,
      };
    })
  );
});
```

- [ ] **Step 4: Client API + tab**

In `client/src/api/client.ts`, after the unmet-request helpers:

```ts
export interface PortalPhoneAction {
  id: number;
  email: string | null;
  source: "chat" | "briefing" | "digest" | "reminder";
  label: string;
  status: "offered" | "fetched" | "done" | "failed";
  steps: string[];
  failure: string | null;
  createdAt: number;
  finishedAt: number | null;
}
export const fetchPhoneActions = () => getJson<PortalPhoneAction[]>("/api/portal/phone-actions");
```

In `client/src/pages/PortalPage.tsx`:
- Add `fetchPhoneActions` and `type PortalPhoneAction` to the `../api/client` import.
- Add `{ key: "phone", label: "Phone Actions" },` to `SECTIONS` after `requests`.
- Add `{section === "phone" && <PhoneActionsTab />}` after the `requests` line (167).
- Add the component after `RequestsTab`:

```tsx
const PHONE_STATUS_LABEL: Record<PortalPhoneAction["status"], string> = {
  offered: "Not tapped",
  fetched: "Running",
  done: "Done",
  failed: "Failed",
};

function PhoneActionsTab() {
  const [rows, setRows] = useState<PortalPhoneAction[]>([]);
  const [loaded, setLoaded] = useState(false);

  function load() {
    setLoaded(false);
    fetchPhoneActions()
      .then(setRows)
      .finally(() => setLoaded(true));
  }

  useEffect(load, []);

  return (
    <>
      <h2>Phone actions</h2>
      <p className="settings-section-intro">
        One-tap actions Marlowe offered through the Marlowe Shortcut: what people tapped, and what broke on their phone.
      </p>
      <div className="row" style={{ marginBottom: 14, justifyContent: "flex-end" }}>
        <button className="btn-secondary" onClick={load}>
          <IconRefresh /> Refresh
        </button>
      </div>
      {!loaded ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted">None offered yet.</p>
      ) : (
        rows.map((r) => (
          <div key={r.id} className="card" style={{ marginBottom: 10 }}>
            <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
              <strong>{r.label}</strong>
              <span className="muted">{PHONE_STATUS_LABEL[r.status]}</span>
            </div>
            <div className="muted" style={{ fontSize: 13 }}>
              {r.email ?? "deleted user"} · {r.source} · {timeAgo(r.createdAt)}
            </div>
            <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
              {r.steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
            {r.failure && <p style={{ color: "var(--danger, #b42318)", margin: "8px 0 0" }}>{r.failure}</p>}
          </div>
        ))
      )}
    </>
  );
}
```

Match the class names (`card`, `row`, `muted`) to what `RequestRow` uses in the same file. If `RequestRow` uses a different wrapper class, use that one.

- [ ] **Step 5: Run tests and build**

Run: `cd server && npx vitest run src/routes/portalRoutes.test.ts && cd ../client && npx tsc --noEmit && npm run build`
Expected: PASS; client builds.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/portalRoutes.ts server/src/routes/portalRoutes.test.ts client/src/api/client.ts client/src/pages/PortalPage.tsx
git commit -m "feat: Portal tab for phone actions offered, tapped and failed"
```

---

### Task 10: Shortcut build guide, device check, docs

**Files:**
- Create: `docs/marlowe-shortcut-build-guide.md`
- Create: `docs/marlowe-shortcut-device-check.md`
- Create: `changelog/2026-10-12-marlowe-shortcut.md`
- Create: `feature-to-do/done-marlowe-shortcut.md` and update `feature-to-do/README.md`
- Modify: `README.md` ("What Marlowe does" list, after "App hand-off links"; env var notes)
- Modify: `server/.env.example`

- [ ] **Step 1: Write the build guide**

Create `docs/marlowe-shortcut-build-guide.md`. It must contain, in order:

1. **What it is:** one Shortcut named exactly `Marlowe` (the run link uses `name=Marlowe`), version 1.
2. **Allowed hosts:** the production and staging `SERVER_URL` hosts, read from Railway for each environment and written into the guide as literal text when it's built.
3. **Build steps** in the Shortcuts app, one numbered action per line:
   1. Receive **Text** input from **Share Sheet / Run URL**; if there's no input, **Stop and respond** "Open a link from Marlowe to use this."
   2. **Match Text** against `^https://(<prod host>|<staging host>)/api/phone-actions/[A-Za-z0-9_-]{22}$`; if there's no match, **Show Alert** "This link isn't from Marlowe." and **Stop**.
   3. **Get Contents of URL**: GET, header `X-Marlowe-Shortcut: 1`.
   4. If the response has key `message` → **Show Alert** with it → **Stop**.
   5. If it has key `update` → **Show Alert** `update.message` → **Open URLs** `update.installUrl` → **Stop**.
   6. Set variable `reportUrl`. **Repeat with Each** item in `steps`, with `Repeat Index` - 1 as `index`:
      - **If** `type` is `alarm` → **Create Alarm** (time from `time`, label from `label`). For each of the other 21 types, list the matching action and which dictionary keys it reads, using the table in the spec. `text`/`call`/`facetime` have **Show When Run ON**. `run_shortcut`: **report ok first**, then **Open URLs** `shortcuts://run-shortcut?name=<URL-encoded name>`. `get_location` → **Get Current Location** → dictionary `{latitude, longitude}` as the value. `get_battery` → **Get Battery Level**. `get_health` → **Find Health Samples** (Sleep Analysis last night / Steps today, Sum). `ask` → **Ask for Input** with `prompt`.
      - After each step: **Get Contents of URL** POST `reportUrl`, JSON `{index, ok: true, value?}`, header `X-Marlowe-Shortcut: 1`.
   7. After the loop: POST `reportUrl` `{done: true}`.
4. **Publishing:** Share → Copy iCloud Link. Set `MARLOWE_SHORTCUT_ICLOUD_URL` to it and `MARLOWE_SHORTCUT_VERSION=1` on Railway staging first, then production.
5. **Updating:** when a step type is added, bump the header value and `MARLOWE_SHORTCUT_VERSION`, add a key to `STEPS_BY_VERSION` in `phoneSteps.ts`, and re-share the iCloud link (it changes).
6. **Users:** after adding it, leave Show When Run on for Messages/Phone, and allow the Health and Location prompts on first use.

- [ ] **Step 2: Write the device checklist**

Create `docs/marlowe-shortcut-device-check.md`, following the format of `docs/app-handoff-links-device-check.md`. Add one row per step type (22) with columns *Tapped from WhatsApp*, *Tapped from web*, *Ran*, *Report arrived*, *Notes*. Add these extra rows:
- "WhatsApp → page → Shortcut: number of taps / Safari prompt?"
- "Link preview didn't use up the code"
- "Second tap says already used"
- "Old version header gets update prompt"
- "Airplane mode: Couldn't reach Marlowe, link still works after"
- "Run killed mid-way → failure message within 10 min"

- [ ] **Step 3: Changelog, README, backlog, env example**

`changelog/2026-10-12-marlowe-shortcut.md`:

```markdown
Marlowe can now do things on your iPhone with one tap: alarms, reminders, Focus, texts and calls, your own Shortcuts, and sending your location or sleep back to Marlowe.

## What changed

Each user adds one Apple Shortcut, "Marlowe", once. After that Marlowe sends links like "Tap to set a
05:15 alarm and turn on Sleep Focus". Tapping one opens a small page, which hands off to the Shortcut.
The Shortcut fetches the steps from Marlowe, runs them, and reports each step back.

Marlowe offers these in chat (`make_phone_action`), in the morning briefing and evening digest (up to
3, only when the calendar gives a reason), and on flight/hotel/restaurant reminders. Success is
silent. A failed step gets one message and is remembered. Location, battery, health and typed
answers go back into the conversation. The Portal has a Phone Actions tab.

## Why

Sam asked whether Marlowe could trigger Apple Shortcuts for him. A server can't start a Shortcut on
a phone; iOS needs a tap. One general Shortcut means one install, then one tap per action. New
abilities ship as Shortcut updates, not new installs.

## Notes

- Off until `MARLOWE_SHORTCUT_ICLOUD_URL` is set. Build the Shortcut from `docs/marlowe-shortcut-build-guide.md`.
- **Device check not done yet:** `docs/marlowe-shortcut-device-check.md`.
- iPhone only. Android (Tasker) could use the same API later.

Design: `docs/superpowers/specs/2026-10-12-marlowe-shortcut-design.md`.
```

In `README.md`, under "What Marlowe does", after the App hand-off links bullet:

```markdown
- **Phone actions (optional):** With the one-time "Marlowe" Apple Shortcut installed, Marlowe sends one-tap links that set alarms, timers and reminders, change Focus and phone settings, text or call from your number, run your own Shortcuts, and send your location, battery, sleep or a typed answer back (`server/src/services/phoneActions.ts`). It offers them in chat, the briefing, the evening digest and on booking reminders. Off until `MARLOWE_SHORTCUT_ICLOUD_URL` is set; see `docs/marlowe-shortcut-build-guide.md`.
```

Under "Safety and privacy boundaries", add:

```markdown
- Phone actions never run without a tap on the user's iPhone. Texts and calls show iOS's own send/call screen. Links work once and expire within 36 hours.
```

In `server/.env.example`, add:

```bash
# Marlowe Shortcut (phone actions). Leave blank to turn the feature off.
# iCloud link of the published "Marlowe" Shortcut — see docs/marlowe-shortcut-build-guide.md.
MARLOWE_SHORTCUT_ICLOUD_URL=
# The version the published Shortcut sends in X-Marlowe-Shortcut.
MARLOWE_SHORTCUT_VERSION=1
```

Create `feature-to-do/done-marlowe-shortcut.md` with a two-line summary pointing at the spec and changelog. Add it to the done list in `feature-to-do/README.md`, following that file's existing format.

- [ ] **Step 4: Full verification**

Run: `cd server && npm test && npx tsc -p tsconfig.json --noEmit && cd ../client && npm run build`
Expected: all pass. Compare any failure with `git stash`-free reasoning: if it also fails on `master`, note it in the report rather than fixing unrelated code.

- [ ] **Step 5: Commit**

```bash
git add docs/marlowe-shortcut-build-guide.md docs/marlowe-shortcut-device-check.md changelog/2026-10-12-marlowe-shortcut.md feature-to-do/ README.md server/.env.example
git commit -m "docs: Marlowe Shortcut build guide, device check, changelog and README"
```
