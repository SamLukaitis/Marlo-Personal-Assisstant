import { describe, it, expect } from "vitest";
import { AREA_CODES_BY_ZONE, guessTimezoneFromPhone } from "./phoneTimezoneGuess.js";
import { isValidIanaTimezone } from "./userTimezone.js";

describe("guessTimezoneFromPhone", () => {
  it("places a US number by its area code", () => {
    expect(guessTimezoneFromPhone("12125550123")).toBe("America/New_York"); // New York City
    expect(guessTimezoneFromPhone("13125550123")).toBe("America/Chicago"); // Chicago
    expect(guessTimezoneFromPhone("13035550123")).toBe("America/Denver"); // Denver
    expect(guessTimezoneFromPhone("16025550123")).toBe("America/Phoenix"); // Arizona, no daylight saving
    expect(guessTimezoneFromPhone("14155550123")).toBe("America/Los_Angeles"); // San Francisco
    expect(guessTimezoneFromPhone("18085550123")).toBe("Pacific/Honolulu");
    expect(guessTimezoneFromPhone("19075550123")).toBe("America/Anchorage");
  });

  it("places a Canadian number by its area code", () => {
    expect(guessTimezoneFromPhone("14165550123")).toBe("America/Toronto");
    expect(guessTimezoneFromPhone("16045550123")).toBe("America/Vancouver");
    expect(guessTimezoneFromPhone("14035550123")).toBe("America/Edmonton");
    expect(guessTimezoneFromPhone("19025550123")).toBe("America/Halifax");
  });

  it("puts an Australian mobile, which names no state, on Melbourne's clock", () => {
    expect(guessTimezoneFromPhone("61412345678")).toBe("Australia/Melbourne");
  });

  it("uses the landline area code where Australia's gives one that keeps different time", () => {
    expect(guessTimezoneFromPhone("61731234567")).toBe("Australia/Brisbane"); // Queensland, no daylight saving
    expect(guessTimezoneFromPhone("61291234567")).toBe("Australia/Melbourne"); // Sydney keeps Melbourne's clock
  });

  it("uses where most people live for other countries that span several zones", () => {
    expect(guessTimezoneFromPhone("5511987654321")).toBe("America/Sao_Paulo");
    expect(guessTimezoneFromPhone("34612345678")).toBe("Europe/Madrid");
    expect(guessTimezoneFromPhone("64211234567")).toBe("Pacific/Auckland");
    expect(guessTimezoneFromPhone("79161234567")).toBe("Europe/Moscow");
    expect(guessTimezoneFromPhone("77012345678")).toBe("Asia/Almaty");
  });

  it("uses the one zone of a single-zone country", () => {
    expect(guessTimezoneFromPhone("447912345678")).toBe("Europe/London");
    expect(guessTimezoneFromPhone("353851234567")).toBe("Europe/Dublin");
    expect(guessTimezoneFromPhone("919812345678")).toBe("Asia/Kolkata");
    expect(guessTimezoneFromPhone("4915123456789")).toBe("Europe/Berlin");
  });

  it("gives nothing for a number with no recognisable country", () => {
    expect(guessTimezoneFromPhone("9990123456789")).toBeNull();
    expect(guessTimezoneFromPhone("")).toBeNull();
  });
});

describe("the area code table", () => {
  const entries = Object.entries(AREA_CODES_BY_ZONE);

  it("names only real IANA zones", () => {
    for (const [zone] of entries) expect(isValidIanaTimezone(zone), zone).toBe(true);
  });

  it("holds only three-digit codes, each listed once across all zones", () => {
    const all = entries.flatMap(([, codes]) => codes);
    for (const code of all) expect(code, code).toMatch(/^\d{3}$/);
    const duplicates = all.filter((code, i) => all.indexOf(code) !== i);
    expect(duplicates).toEqual([]);
  });
});
