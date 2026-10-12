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
    const [step] = ok([{ type: "text", to: "Jake", body: `on‮ my way ${"x".repeat(600)}` }]);
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

  it("rejects over-length values in fields that name a target, instead of cutting them", () => {
    expect(err([{ type: "open_url", url: `https://e.co/${"a".repeat(2001)}` }])).toMatch(/url is too long \(max 2000\)/);
    expect(err([{ type: "text", to: "x".repeat(101), body: "hi" }])).toMatch(/to is too long \(max 100\)/);
  });

  it("rejects a time or datetime with extra characters, instead of cutting them", () => {
    expect(err([{ type: "alarm", time: "05:15xyz" }])).toMatch(/step 1: time must be HH:MM/);
    expect(err([{ type: "calendar_event", title: "Gym", start: "2026-10-13T07:00:00Z", end: "2026-10-13T08:00" }])).toMatch(/start must be YYYY-MM-DDTHH:MM/);
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
