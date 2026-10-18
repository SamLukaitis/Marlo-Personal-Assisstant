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

  it("cleans a merchant with bidi and newline characters before it reaches the phone", () => {
    const s = phoneStepsFor({ summary: "Stay", kind: "hotel", merchant: "Hotel‮ Eva\nFaro", eventStart: "2026-10-13" }, zone, now);
    expect(s).not.toBeNull();
    expect(s!.label).not.toMatch(/[‪-‮\n\r]/);
    expect(JSON.stringify(s!.steps)).not.toMatch(/\\u202E|\\n/);
    expect(s!.steps[0]).toMatchObject({ type: "directions" });
    expect((s!.steps[0] as { destination: string }).destination).not.toMatch(/[‪-‮\n\r]/);
  });

  it("a long merchant gives a short visible label that ends in an ellipsis", () => {
    const s = phoneStepsFor({ summary: "Stay", kind: "hotel", merchant: "x".repeat(120), eventStart: "2026-10-13" }, zone, now);
    expect(s).not.toBeNull();
    expect(Array.from(s!.label).length).toBeLessThanOrEqual(80);
    expect(s!.label.endsWith("…")).toBe(true);
  });

  it("an over-long flight number still gives a valid alarm whose label is at most 80 characters", () => {
    const s = phoneStepsFor(
      { summary: "Flight", kind: "flight", eventStart: "2026-10-13T08:15:00+01:00", flightNumber: "F".repeat(200) },
      zone,
      now
    );
    expect(s).not.toBeNull();
    expect(s!.steps[0]).toMatchObject({ type: "alarm", time: "05:15" });
    expect(Array.from((s!.steps[0] as { label: string }).label).length).toBeLessThanOrEqual(80);
  });
});

describe("phoneStepsFor — Shortcut version", () => {
  it("offers no directions to a version-1 Shortcut, which can't run them", () => {
    expect(phoneStepsFor({ summary: "Stay", kind: "hotel", merchant: "Hotel Eva, Faro", eventStart: "2026-10-13" }, zone, now, 1)).toBeNull();
  });

  it("still offers a flight alarm to a version-1 Shortcut", () => {
    const s = phoneStepsFor({ summary: "Flight", kind: "flight", eventStart: "2026-10-13T08:15:00+01:00" }, zone, now, 1);
    expect(s?.steps).toEqual([{ type: "alarm", time: "05:15", label: "Flight" }]);
  });
});
