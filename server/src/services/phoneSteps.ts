// The vocabulary the "Marlo" Apple Shortcut understands. Marlo (chat tool, briefing markers,
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
// ships; never edit an old one. Version 1 is the first build tested on a phone (the core steps);
// version 2 is the full list from the spec, once the Shortcut has a branch for every step.
const STEPS_BY_VERSION: Record<number, readonly StepType[]> = {
  1: ["alarm", "timer", "reminder", "calendar_event", "focus", "low_power", "text", "call", "open_url"],
  2: STEP_TYPES,
};

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

// Free text is cut to `max` characters; `strict` fields are rejected instead, because a cut URL or
// contact name would still look valid but point somewhere the user never asked for.
function read(raw: Raw, field: string, max: number, strict: boolean): string | undefined {
  const cleaned = cleanText(raw[field], field, strict ? Infinity : max);
  if (strict && cleaned !== undefined && Array.from(cleaned).length > max) {
    throw new InputError(`${field} is too long (max ${max}).`);
  }
  return cleaned;
}
function req(raw: Raw, field: string, max = 200, strict = false): string {
  const t = read(raw, field, max, strict);
  if (!t) throw new InputError(`${field} is required for this step.`);
  return t;
}
function opt(raw: Raw, field: string, max = 200, strict = false): string | undefined {
  return read(raw, field, max, strict);
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
  // No length cap here: the pattern rejects anything that isn't exactly HH:MM, including suffixes.
  const v = required ? req(raw, field, Infinity) : opt(raw, field, Infinity);
  if (v !== undefined && !HHMM.test(v)) throw new InputError(`${field} must be HH:MM, 24-hour.`);
  return v;
}
function localDateTime(raw: Raw, field: string, required: true): string;
function localDateTime(raw: Raw, field: string, required: false): string | undefined;
function localDateTime(raw: Raw, field: string, required: boolean): string | undefined {
  // No length cap here: the pattern rejects a trailing "Z" or seconds rather than cutting them off.
  const v = required ? req(raw, field, Infinity) : opt(raw, field, Infinity);
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
  const v = req(raw, field, 2000, true);
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
      return withOptional({ type, title: req(raw, "title") }, { due: localDateTime(raw, "due", false), list: opt(raw, "list", 80, true) });
    case "calendar_event": {
      const start = localDateTime(raw, "start", true);
      const end = localDateTime(raw, "end", true);
      if (end <= start) throw new InputError("end must be after start.");
      return withOptional({ type, title: req(raw, "title"), start, end }, { location: opt(raw, "location") });
    }
    case "focus":
      return withOptional({ type, name: req(raw, "name", 60, true), on: bool(raw, "on") }, { until: hhmm(raw, "until", false) });
    case "low_power":
    case "wifi":
    case "bluetooth":
      return { type, on: bool(raw, "on") };
    case "volume":
    case "brightness":
      return { type, percent: int(raw, "percent", 0, 100) };
    case "text":
      return { type, to: req(raw, "to", 100, true), body: req(raw, "body", 500) };
    case "call":
    case "facetime":
      return { type, to: req(raw, "to", 100, true) };
    case "open_url":
      return { type, url: httpsUrl(raw, "url") };
    case "directions":
      return withOptional({ type, destination: req(raw, "destination", 200, true) }, { mode: oneOf(raw, "mode", DIRECTION_MODES, false) });
    case "note":
      return { type, title: req(raw, "title"), body: req(raw, "body", 2000) };
    case "clipboard":
      return { type, text: req(raw, "text", 2000) };
    case "run_shortcut":
      return { type, name: req(raw, "name", 100, true) };
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
  // gets nothing, so Marlo asks for an update rather than guessing.
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
    return { error: "run_shortcut leaves the Marlo Shortcut, so it must be the last step." };
  }
  const missing = unsupportedSteps(steps, version);
  if (missing.length) {
    return { error: `the installed Marlo Shortcut (version ${version}) can't do ${missing.map((t) => `"${t}"`).join(", ")} yet.` };
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
    case "get_location": return "send Marlo your location";
    case "get_battery": return "send Marlo your battery level";
    case "get_health": return step.metric === "sleep_last_night" ? "send Marlo last night's sleep" : "send Marlo today's steps";
    case "ask": return `ask you: ${quoted(step.prompt)}`;
  }
}
