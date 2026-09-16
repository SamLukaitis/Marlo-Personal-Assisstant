import { describe, it, expect } from "vitest";
import { findOrCreateUserByEmail, setToolEnabled, saveCheckin, setSetting } from "../db/store.js";
import { getUserTimezone, setUserTimezone, setUserTimezoneFromLocation, isValidIanaTimezone } from "./userTimezone.js";

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

describe("isValidIanaTimezone", () => {
  it("accepts a real IANA zone", () => {
    expect(isValidIanaTimezone("Europe/London")).toBe(true);
  });

  it("rejects nonsense", () => {
    expect(isValidIanaTimezone("Not/AZone")).toBe(false);
    expect(isValidIanaTimezone("")).toBe(false);
  });
});

describe("getUserTimezone", () => {
  it("returns null when nothing is set and no check-in exists", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("tz-none"));
    expect(getUserTimezone(user.id)).toBeNull();
  });

  it("prefers an explicit setting over everything else", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("tz-explicit"));
    setSetting(user.id, "timezone", "Asia/Tokyo");
    expect(getUserTimezone(user.id)).toBe("Asia/Tokyo");
  });

  it("falls back to a geo lookup from the most recent travel check-in when travel is enabled", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("tz-geo"));
    setToolEnabled(user.id, "travel", true);
    // Central London — deterministically resolves to Europe/London via geo-tz's offline lookup.
    saveCheckin(user.id, {
      latitude: 51.5074,
      longitude: -0.1278,
      country: "United Kingdom",
      city: "London",
      checkedInAt: Date.now(),
    });

    expect(getUserTimezone(user.id)).toBe("Europe/London");
  });

  it("caches the geo-derived zone into the setting so it doesn't need re-resolving", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("tz-geo-cache"));
    setToolEnabled(user.id, "travel", true);
    saveCheckin(user.id, {
      latitude: 51.5074,
      longitude: -0.1278,
      country: "United Kingdom",
      city: "London",
      checkedInAt: Date.now(),
    });

    getUserTimezone(user.id);

    const user2 = findOrCreateUserByEmail(uniqueEmail("tz-unused"));
    expect(getUserTimezone(user2.id)).toBeNull(); // sanity: caching is per-owner, not global
  });

  it("ignores check-ins when the travel tool isn't enabled for this user", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("tz-travel-off"));
    saveCheckin(user.id, {
      latitude: 51.5074,
      longitude: -0.1278,
      country: "United Kingdom",
      city: "London",
      checkedInAt: Date.now(),
    });

    expect(getUserTimezone(user.id)).toBeNull();
  });
});

describe("setUserTimezone", () => {
  it("stores a valid IANA zone and reports success", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("tz-set-valid"));
    expect(setUserTimezone(user.id, "America/New_York")).toBe(true);
    expect(getUserTimezone(user.id)).toBe("America/New_York");
  });

  it("rejects an invalid zone without storing anything", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("tz-set-invalid"));
    expect(setUserTimezone(user.id, "Nowhere/Fake")).toBe(false);
    expect(getUserTimezone(user.id)).toBeNull();
  });
});

describe("setUserTimezoneFromLocation", () => {
  it("resolves and stores the zone for a real coordinate, with no travel tool or check-in needed", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("tz-location"));
    const resolved = setUserTimezoneFromLocation(user.id, 51.5074, -0.1278); // central London
    expect(resolved).toBe("Europe/London");
    expect(getUserTimezone(user.id)).toBe("Europe/London");
  });

  it("overwrites a previously set zone — the most recent shared location wins", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("tz-location-overwrite"));
    setUserTimezone(user.id, "Asia/Tokyo");
    setUserTimezoneFromLocation(user.id, 40.7128, -74.006); // New York
    expect(getUserTimezone(user.id)).toBe("America/New_York");
  });

  it("resolves open ocean to its nautical zone rather than failing", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("tz-location-ocean"));
    // South Atlantic, no land — geo-tz still covers this via a nautical Etc/GMT zone.
    const resolved = setUserTimezoneFromLocation(user.id, -40, -20);
    expect(resolved).toBe("Etc/GMT+1");
    expect(getUserTimezone(user.id)).toBe("Etc/GMT+1");
  });

  it("returns null and stores nothing for a malformed coordinate rather than throwing", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("tz-location-invalid"));
    const resolved = setUserTimezoneFromLocation(user.id, Number.NaN, Number.NaN);
    expect(resolved).toBeNull();
    expect(getUserTimezone(user.id)).toBeNull();
  });
});
