import { describe, it, expect } from "vitest";
import {
  findOrCreateUserByEmail,
  setToolEnabled,
  saveCheckin,
  setSetting,
  getSetting,
  addPhoneNumberForUser,
} from "../db/store.js";
import {
  getUserTimezone,
  resolveUserTimezone,
  setUserTimezone,
  setUserTimezoneFromLocation,
  isValidIanaTimezone,
} from "./userTimezone.js";

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

  // Cached into the "explicit" setting, a check-in in a new country could never change it.
  it("doesn't store a travel-derived zone, so a later check-in can move it", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("tz-geo-refresh"));
    setToolEnabled(user.id, "travel", true);
    const london = { latitude: 51.5074, longitude: -0.1278, country: "United Kingdom", city: "London" };
    const newYork = { latitude: 40.7128, longitude: -74.006, country: "United States", city: "New York" };
    saveCheckin(user.id, { ...london, checkedInAt: Date.now() - 86_400_000 });
    expect(getUserTimezone(user.id)).toBe("Europe/London");
    expect(getSetting(user.id, "timezone")).toBeNull();

    saveCheckin(user.id, { ...newYork, checkedInAt: Date.now() });
    expect(getUserTimezone(user.id)).toBe("America/New_York");
  });

  it("a shared location and a check-in: whichever is more recent wins", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("tz-location-vs-checkin"));
    setToolEnabled(user.id, "travel", true);
    setUserTimezoneFromLocation(user.id, 35.6762, 139.6503); // Tokyo
    setSetting(user.id, "timezone_set_at", String(Date.now() - 2 * 3_600_000)); // shared two hours ago
    const london = { latitude: 51.5074, longitude: -0.1278, country: "United Kingdom", city: "London" };

    saveCheckin(user.id, { ...london, checkedInAt: Date.now() - 3 * 3_600_000 });
    expect(getUserTimezone(user.id)).toBe("Asia/Tokyo");

    saveCheckin(user.id, { ...london, checkedInAt: Date.now() - 3_600_000 });
    expect(getUserTimezone(user.id)).toBe("Europe/London");
  });

  it("ignores a check-in with no coordinates (read off a document) rather than letting it hide a real one", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("tz-doc-checkin"));
    setToolEnabled(user.id, "travel", true);
    saveCheckin(user.id, {
      latitude: 51.5074,
      longitude: -0.1278,
      country: "United Kingdom",
      city: "London",
      checkedInAt: Date.now() - 86_400_000,
    });
    saveCheckin(user.id, { country: "Japan", city: "Tokyo", checkedInAt: Date.now(), source: "document" });
    expect(getUserTimezone(user.id)).toBe("Europe/London");
  });

  it("ignores a check-in dated in the future", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("tz-future-checkin"));
    setToolEnabled(user.id, "travel", true);
    saveCheckin(user.id, {
      latitude: 51.5074,
      longitude: -0.1278,
      country: "United Kingdom",
      city: "London",
      checkedInAt: Date.now() - 86_400_000,
    });
    saveCheckin(user.id, {
      latitude: 35.6762,
      longitude: 139.6503,
      country: "Japan",
      city: "Tokyo",
      checkedInAt: Date.now() + 7 * 86_400_000,
    });
    expect(getUserTimezone(user.id)).toBe("Europe/London");
  });

  it("a zone picked in Settings is never overridden by a check-in", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("tz-picker-sticky"));
    setToolEnabled(user.id, "travel", true);
    setUserTimezone(user.id, "Asia/Tokyo");
    saveCheckin(user.id, {
      latitude: 51.5074,
      longitude: -0.1278,
      country: "United Kingdom",
      city: "London",
      checkedInAt: Date.now() + 3_600_000,
    });
    expect(getUserTimezone(user.id)).toBe("Asia/Tokyo");
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

describe("getUserTimezone from the phone number's country", () => {
  // A realistic national prefix plus random digits — the test database keeps phone numbers between
  // runs, and a number can belong to only one account.
  function phoneWith(prefix: string, totalDigits: number): string {
    let digits = prefix;
    while (digits.length < totalDigits) digits += Math.floor(Math.random() * 10);
    return digits;
  }

  function userWithPhone(prefix: string, phone: string) {
    const user = findOrCreateUserByEmail(uniqueEmail(prefix));
    addPhoneNumberForUser(user.id, phone);
    return user;
  }

  it("uses the country's zone when the country has just one", () => {
    expect(getUserTimezone(userWithPhone("tz-phone-gb", phoneWith("447912", 12)).id)).toBe("Europe/London");
    expect(getUserTimezone(userWithPhone("tz-phone-ie", phoneWith("35385", 12)).id)).toBe("Europe/Dublin");
    expect(getUserTimezone(userWithPhone("tz-phone-fr", phoneWith("336", 11)).id)).toBe("Europe/Paris");
    expect(getUserTimezone(userWithPhone("tz-phone-in", phoneWith("919", 12)).id)).toBe("Asia/Kolkata");
  });

  it("treats zones that keep identical time all year as one", () => {
    // The tz database lists Zurich under Germany too; both are on Central European time.
    expect(getUserTimezone(userWithPhone("tz-phone-de", phoneWith("49151", 13)).id)).toBe("Europe/Berlin");
  });

  it("makes an educated guess for a country that spans several timezones", () => {
    // Detail is in phoneTimezoneGuess.test.ts: the US and Canada go by area code (202 is DC).
    expect(getUserTimezone(userWithPhone("tz-phone-us", phoneWith("1202555", 11)).id)).toBe("America/New_York");
    expect(getUserTimezone(userWithPhone("tz-phone-us-west", phoneWith("1415555", 11)).id)).toBe(
      "America/Los_Angeles"
    );
    expect(getUserTimezone(userWithPhone("tz-phone-au", phoneWith("61412", 11)).id)).toBe("Australia/Melbourne");
    expect(getUserTimezone(userWithPhone("tz-phone-br", phoneWith("55119", 13)).id)).toBe("America/Sao_Paulo");
  });

  it("stays unknown for a number that doesn't parse to a country", () => {
    expect(getUserTimezone(userWithPhone("tz-phone-junk", phoneWith("9990", 12)).id)).toBeNull();
  });

  it("is only a fallback: a check-in, a shared location or a picked zone all beat it", () => {
    const withCheckin = userWithPhone("tz-phone-vs-checkin", phoneWith("447912", 12));
    setToolEnabled(withCheckin.id, "travel", true);
    saveCheckin(withCheckin.id, {
      latitude: 40.7128,
      longitude: -74.006,
      country: "United States",
      city: "New York",
      checkedInAt: Date.now(),
    });
    expect(getUserTimezone(withCheckin.id)).toBe("America/New_York");

    const withLocation = userWithPhone("tz-phone-vs-location", phoneWith("447912", 12));
    setUserTimezoneFromLocation(withLocation.id, 40.7128, -74.006);
    expect(getUserTimezone(withLocation.id)).toBe("America/New_York");

    const withPicker = userWithPhone("tz-phone-vs-picker", phoneWith("447912", 12));
    setUserTimezone(withPicker.id, "Asia/Tokyo");
    expect(getUserTimezone(withPicker.id)).toBe("Asia/Tokyo");
  });

  it("isn't stored, so it doesn't show in Settings as a chosen zone or block a later signal", () => {
    const user = userWithPhone("tz-phone-not-stored", phoneWith("447912", 12));
    expect(getUserTimezone(user.id)).toBe("Europe/London");
    expect(resolveUserTimezone(user.id).guessed).toBe(true);
    expect(getSetting(user.id, "timezone")).toBeNull();
  });

  it("uses any of the user's numbers", () => {
    const user = userWithPhone("tz-phone-second", phoneWith("9990", 12)); // no recognisable country
    addPhoneNumberForUser(user.id, phoneWith("35385", 12));
    expect(getUserTimezone(user.id)).toBe("Europe/Dublin");
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
