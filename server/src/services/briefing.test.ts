import { describe, it, expect } from "vitest";
import { hasBriefingSettings, saveBriefingSettings, type BriefingSettings } from "./briefing.js";
import { findOrCreateUserByEmail } from "../db/store.js";

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
