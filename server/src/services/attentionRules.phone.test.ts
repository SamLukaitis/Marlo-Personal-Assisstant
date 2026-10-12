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
