import { describe, it, expect } from "vitest";
import { buildEnrichmentPrompt, parseEnrichment } from "./importantEmailEnrichment.js";

describe("buildEnrichmentPrompt", () => {
  it("includes the category, the user's timezone and a trimmed body", () => {
    const prompt = buildEnrichmentPrompt({
      category: "reservation_confirmed",
      subject: "Your booking",
      from: "Hilton <no-reply@hilton.com>",
      body: "x".repeat(10_000),
      receivedAt: "2026-10-01T10:00:00Z",
      zone: "Europe/London",
    });
    expect(prompt).toContain("reservation_confirmed");
    expect(prompt).toContain("Europe/London");
    expect(prompt.length).toBeLessThan(8_000);
  });
});

describe("parseEnrichment", () => {
  it("keeps valid fields and drops malformed ones", () => {
    expect(
      parseEnrichment({
        summary: "Your *Hilton Lisbon* stay, *12–15 Oct*.",
        kind: "hotel",
        event_start: "2026-10-12",
        due_date: "not a date",
        reference: "HLT12345",
        flight_number: "",
        merchant: "Hilton",
        amount: "£420",
        needs_action: false,
      })
    ).toEqual({
      summary: "Your *Hilton Lisbon* stay, *12–15 Oct*.",
      kind: "hotel",
      eventStart: "2026-10-12",
      reference: "HLT12345",
      merchant: "Hilton",
      amount: "£420",
      needsAction: false,
    });
  });

  it("accepts a full ISO date-time with offset", () => {
    expect(parseEnrichment({ summary: "s *x*", event_start: "2026-10-03T08:40:00+01:00" })?.eventStart).toBe(
      "2026-10-03T08:40:00+01:00"
    );
  });

  it("returns null without a summary", () => {
    expect(parseEnrichment({ kind: "hotel" })).toBeNull();
    expect(parseEnrichment(null)).toBeNull();
  });

  it("drops an unknown kind", () => {
    expect(parseEnrichment({ summary: "s", kind: "boat" })?.kind).toBeUndefined();
  });
});
