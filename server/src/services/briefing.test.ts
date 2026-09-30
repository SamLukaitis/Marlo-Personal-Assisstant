import { describe, it, expect } from "vitest";
import {
  hasBriefingSettings,
  saveBriefingSettings,
  selectUnreadSinceMidnight,
  describeLocationStreak,
  describeEventTime,
  type BriefingSettings,
} from "./briefing.js";
import { findOrCreateUserByEmail } from "../db/store.js";
import type { UnifiedMessage } from "../providers/types.js";
import type { TravelCheckinRow } from "../db/store.js";

const SOME_SETTINGS: BriefingSettings = {
  enabled: true,
  includeNews: false,
  topics: [],
  includeMarkets: false,
  tickers: [],
  includeWeather: false,
  weatherLocation: "",
  proactive: false,
  sendTime: "07:30",
};

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

describe("hasBriefingSettings", () => {
  it("is false for a user who has never saved briefing settings", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("no-briefing"));
    expect(hasBriefingSettings(user.id)).toBe(false);
  });

  it("is true once briefing settings have been saved, even if identical to the defaults", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("saved-briefing"));
    saveBriefingSettings(user.id, SOME_SETTINGS);
    expect(hasBriefingSettings(user.id)).toBe(true);
  });
});

function msg(overrides: Partial<UnifiedMessage>): UnifiedMessage {
  return {
    id: "1",
    accountId: 1,
    accountEmail: "a@example.com",
    provider: "google",
    subject: "subject",
    from: "someone@example.com",
    snippet: "",
    receivedAt: new Date().toISOString(),
    unread: true,
    ...overrides,
  };
}

describe("selectUnreadSinceMidnight", () => {
  // "now" fixed well after local midnight so both branches of the day boundary are unambiguous.
  const now = new Date(2026, 8, 10, 9, 0, 0); // 2026-09-10 09:00 local

  it("keeps an unread message received today", () => {
    const today = msg({ receivedAt: new Date(2026, 8, 10, 7, 0, 0).toISOString() });
    expect(selectUnreadSinceMidnight([today], now)).toEqual([today]);
  });

  it("drops an unread message received yesterday", () => {
    const yesterday = msg({ receivedAt: new Date(2026, 8, 9, 23, 59, 0).toISOString() });
    expect(selectUnreadSinceMidnight([yesterday], now)).toEqual([]);
  });

  it("drops read messages received today", () => {
    const readToday = msg({ receivedAt: new Date(2026, 8, 10, 7, 0, 0).toISOString(), unread: false });
    expect(selectUnreadSinceMidnight([readToday], now)).toEqual([]);
  });

  // 08:00 UTC on the 10th is 18:00 in Sydney (midnight was 14:00 UTC on the 9th) and 04:00 in New
  // York (midnight was 04:00 UTC on the 10th).
  const utcNow = new Date("2026-09-10T08:00:00Z");

  it("counts midnight in the given timezone", () => {
    const lateLastNightUtc = msg({ receivedAt: "2026-09-09T20:00:00Z" });
    expect(selectUnreadSinceMidnight([lateLastNightUtc], utcNow, "Australia/Sydney")).toEqual([lateLastNightUtc]);
    expect(selectUnreadSinceMidnight([lateLastNightUtc], utcNow, "America/New_York")).toEqual([]);
  });
});

describe("describeLocationStreak", () => {
  const now = new Date(2026, 8, 10, 9, 0, 0);

  function checkin(overrides: Partial<TravelCheckinRow>): TravelCheckinRow {
    return {
      id: 1,
      latitude: null,
      longitude: null,
      country: "Brazil",
      city: "Rio de Janeiro",
      checkedInAt: now.getTime(),
      source: "document",
      documentId: null,
      ...overrides,
    };
  }

  it("returns empty when there is no checkin", () => {
    expect(describeLocationStreak(undefined, now)).toBe("");
  });

  it("says arrived today when the checkin is from today", () => {
    const c = checkin({ checkedInAt: new Date(2026, 8, 10, 6, 0, 0).getTime() });
    expect(describeLocationStreak(c, now)).toMatch(/arrived today/i);
  });

  it("counts days by the given timezone's calendar", () => {
    // Checked in 13:00 UTC on the 9th, "now" is 22:00 UTC on the 9th. In Sydney that is 23:00 on the
    // 9th -> 08:00 on the 10th (yesterday); in New York it is 09:00 -> 18:00 on the 9th (today).
    const at = new Date("2026-09-09T22:00:00Z");
    const c = checkin({ checkedInAt: new Date("2026-09-09T13:00:00Z").getTime() });
    expect(describeLocationStreak(c, at, "Australia/Sydney")).toMatch(/1 day ago/);
    expect(describeLocationStreak(c, at, "America/New_York")).toMatch(/arrived today/i);
  });

  it("reports how many days the user has been there for an older checkin", () => {
    const c = checkin({ checkedInAt: new Date(2026, 8, 4, 6, 0, 0).getTime() }); // 6 days ago
    const result = describeLocationStreak(c, now);
    expect(result).toMatch(/Rio de Janeiro/);
    expect(result).toMatch(/6 days/);
  });
});

describe("describeEventTime", () => {
  const base = { id: "e", accountId: 1, accountEmail: "me@example.com", provider: "google" as const, title: "Offsite" };

  it("describes an all-day event as all day rather than a midnight start", () => {
    expect(
      describeEventTime({ ...base, start: "2026-09-15", end: "2026-09-16", allDay: true }, "Europe/London")
    ).toBe("Offsite (all day, Tuesday 15 Sep)");
  });

  // The weekday and clock time are what let the briefing say "Thursday evening" instead of reading
  // an ISO string out loud — so they have to be computed, not left to the model.
  it("gives a timed event a weekday and a local clock time", () => {
    expect(
      describeEventTime(
        { ...base, start: "2026-09-15T09:00:00.000Z", end: "2026-09-15T10:00:00.000Z" },
        "Europe/London"
      )
    ).toBe("Offsite at 10:00 on Tuesday 15 Sep");
  });

  // Same instant, two zones: the time the user reads must be their own, not the server's.
  it("renders the time in the user's zone, not UTC", () => {
    const e = { ...base, start: "2026-09-15T23:30:00.000Z", end: "2026-09-16T00:30:00.000Z" };
    expect(describeEventTime(e, "Australia/Sydney")).toBe("Offsite at 09:30 on Wednesday 16 Sep");
    expect(describeEventTime(e, "America/New_York")).toBe("Offsite at 19:30 on Tuesday 15 Sep");
  });

  // A provider can hand back something unparseable; a stiff line beats a confidently wrong day.
  it("falls back to the raw start when it can't be parsed", () => {
    expect(describeEventTime({ ...base, start: "not-a-date" }, "Europe/London")).toBe("Offsite at not-a-date");
  });
});
