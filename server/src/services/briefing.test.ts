import { describe, it, expect } from "vitest";
import {
  hasBriefingSettings,
  saveBriefingSettings,
  selectUnreadSinceMidnight,
  describeLocationStreak,
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

  it("reports how many days the user has been there for an older checkin", () => {
    const c = checkin({ checkedInAt: new Date(2026, 8, 4, 6, 0, 0).getTime() }); // 6 days ago
    const result = describeLocationStreak(c, now);
    expect(result).toMatch(/Rio de Janeiro/);
    expect(result).toMatch(/6 days/);
  });
});
