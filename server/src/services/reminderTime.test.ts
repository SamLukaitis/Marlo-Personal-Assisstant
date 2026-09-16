import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import { resolveReminderTime, ReminderTimeError } from "./reminderTime.js";

const ZONE = "Europe/London";

function londonMs(iso: string): number {
  return DateTime.fromISO(iso, { zone: ZONE }).toMillis();
}

describe("resolveReminderTime", () => {
  describe("once", () => {
    it("adds relativeMinutes to now with pure arithmetic, no timezone involved", () => {
      const now = londonMs("2026-01-15T09:00:00");
      const result = resolveReminderTime({ mode: "once", relativeMinutes: 20 }, ZONE, now);
      expect(result.nextFireAt).toBe(now + 20 * 60_000);
    });

    it("rejects a non-positive relativeMinutes", () => {
      const now = londonMs("2026-01-15T09:00:00");
      expect(() => resolveReminderTime({ mode: "once", relativeMinutes: 0 }, ZONE, now)).toThrow(ReminderTimeError);
      expect(() => resolveReminderTime({ mode: "once", relativeMinutes: -5 }, ZONE, now)).toThrow(ReminderTimeError);
    });

    it("resolves a local time later today with no rollover", () => {
      const now = londonMs("2026-01-15T09:00:00");
      const result = resolveReminderTime({ mode: "once", localTime: "09:30" }, ZONE, now);
      expect(result.nextFireAt).toBe(londonMs("2026-01-15T09:30:00"));
    });

    it("rolls a local time that has already passed today over to tomorrow", () => {
      const now = londonMs("2026-01-15T09:00:00");
      const result = resolveReminderTime({ mode: "once", localTime: "08:00" }, ZONE, now);
      expect(result.nextFireAt).toBe(londonMs("2026-01-16T08:00:00"));
    });

    it("uses an explicit localDate as-is with no rollover", () => {
      const now = londonMs("2026-01-15T09:00:00");
      const result = resolveReminderTime(
        { mode: "once", localTime: "08:00", localDate: "2026-01-15" },
        ZONE,
        now
      );
      expect(result.nextFireAt).toBe(londonMs("2026-01-15T08:00:00"));
    });

    it("rejects a malformed clock time", () => {
      const now = londonMs("2026-01-15T09:00:00");
      expect(() => resolveReminderTime({ mode: "once", localTime: "25:00" }, ZONE, now)).toThrow(ReminderTimeError);
      expect(() => resolveReminderTime({ mode: "once", localTime: "9:5" }, ZONE, now)).toThrow(ReminderTimeError);
    });

    it("rejects when neither relativeMinutes nor localTime is given", () => {
      const now = londonMs("2026-01-15T09:00:00");
      expect(() => resolveReminderTime({ mode: "once" }, ZONE, now)).toThrow(ReminderTimeError);
    });
  });

  describe("interval", () => {
    it("resolves a normal future window", () => {
      const now = londonMs("2026-01-15T09:00:00");
      const result = resolveReminderTime(
        { mode: "interval", localTime: "10:00", windowEndLocalTime: "10:30", intervalMinutes: 5 },
        ZONE,
        now
      );
      expect(result.nextFireAt).toBe(londonMs("2026-01-15T10:00:00"));
      expect(result.windowEndAt).toBe(londonMs("2026-01-15T10:30:00"));
      expect(result.intervalMs).toBe(5 * 60_000);
    });

    // Regression case: if the window start and end were each independently rolled to "tomorrow"
    // based on whether THAT time alone had passed, a "now" that falls inside the window (start
    // already passed, end hasn't) would roll the start to tomorrow while leaving the end today —
    // producing an end before the start. The end must anchor to whatever day the start resolved
    // to, not be re-derived from `now`.
    it("keeps the window end on the same day the start rolled to, when now falls inside the window", () => {
      const now = londonMs("2026-01-15T10:15:00");
      const result = resolveReminderTime(
        { mode: "interval", localTime: "10:00", windowEndLocalTime: "10:30", intervalMinutes: 5 },
        ZONE,
        now
      );
      expect(result.nextFireAt).toBe(londonMs("2026-01-16T10:00:00"));
      expect(result.windowEndAt).toBe(londonMs("2026-01-16T10:30:00"));
      expect(result.windowEndAt!).toBeGreaterThan(result.nextFireAt);
    });

    it("rejects a window end at or before the start", () => {
      const now = londonMs("2026-01-15T09:00:00");
      expect(() =>
        resolveReminderTime(
          { mode: "interval", localTime: "10:30", windowEndLocalTime: "10:00", intervalMinutes: 5 },
          ZONE,
          now
        )
      ).toThrow(ReminderTimeError);
    });

    it("rejects a non-positive intervalMinutes", () => {
      const now = londonMs("2026-01-15T09:00:00");
      expect(() =>
        resolveReminderTime(
          { mode: "interval", localTime: "10:00", windowEndLocalTime: "10:30", intervalMinutes: 0 },
          ZONE,
          now
        )
      ).toThrow(ReminderTimeError);
    });
  });

  describe("until_reply", () => {
    it("starts immediately and carries the interval, no clock time involved", () => {
      const now = londonMs("2026-01-15T09:00:00");
      const result = resolveReminderTime({ mode: "until_reply", intervalMinutes: 1 }, ZONE, now);
      expect(result.nextFireAt).toBe(now);
      expect(result.intervalMs).toBe(60_000);
    });

    it("rejects a non-positive intervalMinutes", () => {
      const now = londonMs("2026-01-15T09:00:00");
      expect(() => resolveReminderTime({ mode: "until_reply", intervalMinutes: -1 }, ZONE, now)).toThrow(
        ReminderTimeError
      );
    });
  });
});
