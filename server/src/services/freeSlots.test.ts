import { describe, it, expect } from "vitest";
import { findFreeSlots } from "./freeSlots.js";
import type { CalendarEvent } from "../providers/types.js";

// Working-hours windows are computed in the server's local time (same convention as
// travelDays.ts's day boundaries), so fixtures are built from local Date components rather
// than hardcoded UTC strings - that keeps the test correct regardless of which timezone it runs in.
function localIso(year: number, month: number, day: number, hour = 0, minute = 0): string {
  return new Date(year, month, day, hour, minute, 0, 0).toISOString();
}

function event(start: string, end: string): CalendarEvent {
  return {
    id: `${start}-${end}`,
    accountId: 1,
    accountEmail: "me@example.com",
    provider: "google",
    title: "busy",
    start,
    end,
  };
}

const NOW = new Date(2026, 7, 24, 0, 0, 0, 0).getTime(); // 2026-08-24, local midnight

describe("findFreeSlots", () => {
  it("finds the single gap between two meetings on the same day", () => {
    const events = [
      event(localIso(2026, 7, 24, 9, 0), localIso(2026, 7, 24, 10, 0)),
      event(localIso(2026, 7, 24, 11, 0), localIso(2026, 7, 24, 18, 0)),
    ];

    const slots = findFreeSlots(events, {
      days: 1,
      durationMinutes: 30,
      earliestHour: 9,
      latestHour: 18,
      now: NOW,
    });

    expect(slots).toHaveLength(1);
    expect(slots[0].start).toBe(localIso(2026, 7, 24, 10, 0));
    expect(slots[0].end).toBe(localIso(2026, 7, 24, 11, 0));
  });

  it("returns the whole working-hours window when there are no events", () => {
    const slots = findFreeSlots([], { days: 1, durationMinutes: 60, earliestHour: 9, latestHour: 18, now: NOW });
    expect(slots).toHaveLength(1);
    expect(slots[0].start).toBe(localIso(2026, 7, 24, 9, 0));
    expect(slots[0].end).toBe(localIso(2026, 7, 24, 18, 0));
  });

  it("excludes gaps shorter than the requested duration", () => {
    const events = [
      event(localIso(2026, 7, 24, 9, 0), localIso(2026, 7, 24, 9, 45)),
      event(localIso(2026, 7, 24, 10, 0), localIso(2026, 7, 24, 18, 0)),
    ];

    const slots = findFreeSlots(events, {
      days: 1,
      durationMinutes: 30,
      earliestHour: 9,
      latestHour: 18,
      now: NOW,
    });

    // The 09:45-10:00 gap is only 15 minutes, shorter than the requested 30 - excluded.
    expect(slots).toHaveLength(0);
  });

  it("merges overlapping/adjacent busy events before computing gaps", () => {
    const events = [
      event(localIso(2026, 7, 24, 9, 0), localIso(2026, 7, 24, 10, 30)),
      event(localIso(2026, 7, 24, 10, 0), localIso(2026, 7, 24, 11, 0)),
      event(localIso(2026, 7, 24, 11, 0), localIso(2026, 7, 24, 12, 0)),
    ];

    const slots = findFreeSlots(events, {
      days: 1,
      durationMinutes: 30,
      earliestHour: 9,
      latestHour: 18,
      now: NOW,
    });

    expect(slots).toHaveLength(1);
    expect(slots[0].start).toBe(localIso(2026, 7, 24, 12, 0));
    expect(slots[0].end).toBe(localIso(2026, 7, 24, 18, 0));
  });

  it("spans multiple days when the window doesn't fit in one", () => {
    const slots = findFreeSlots([], { days: 2, durationMinutes: 60, earliestHour: 9, latestHour: 18, now: NOW });
    expect(slots).toHaveLength(2);
    expect(slots[1].start).toBe(localIso(2026, 7, 25, 9, 0));
  });
});
