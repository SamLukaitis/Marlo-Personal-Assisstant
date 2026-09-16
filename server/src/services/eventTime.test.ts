import { describe, it, expect } from "vitest";
import { eventTimeMs, eventLocalDateKey } from "./eventTime.js";

function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

describe("eventTimeMs", () => {
  // new Date("2026-09-15") is UTC midnight, which is the previous evening anywhere west of UTC —
  // an all-day event would show (and sort, and block free slots) on the wrong day.
  it("reads an all-day date as local midnight, not UTC midnight", () => {
    expect(eventTimeMs("2026-09-15")).toBe(new Date(2026, 8, 15).getTime());
  });

  it("reads a datetime with a zone at its real instant", () => {
    expect(eventTimeMs("2026-09-15T09:00:00Z")).toBe(Date.UTC(2026, 8, 15, 9));
    expect(eventTimeMs("2026-09-15T09:00:00+02:00")).toBe(Date.UTC(2026, 8, 15, 7));
  });

  it("returns NaN for an empty or unparseable value", () => {
    expect(eventTimeMs("")).toBeNaN();
    expect(eventTimeMs("not a date")).toBeNaN();
  });
});

describe("eventLocalDateKey", () => {
  it("keeps an all-day date as-is", () => {
    expect(eventLocalDateKey("2026-09-15")).toBe("2026-09-15");
  });

  it("uses the server-local calendar day of a timed event, not the UTC string's date prefix", () => {
    const iso = "2026-09-15T23:30:00Z";
    expect(eventLocalDateKey(iso)).toBe(localDateKey(new Date(iso)));
  });
});
