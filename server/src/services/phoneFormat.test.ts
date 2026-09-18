import { describe, it, expect } from "vitest";
import { internationalPhoneError } from "./phoneFormat.js";

describe("internationalPhoneError", () => {
  it("accepts an E.164 number in the shape WhatsApp delivers", () => {
    expect(internationalPhoneError("447597959648")).toBeNull();
    expect(internationalPhoneError("573122394957")).toBeNull();
  });

  // The one that actually bit: a UK number typed the way people write it. Stored verbatim it can
  // never equal the 447597959648 WhatsApp sends, so the binding is dead and the owner's own
  // messages fall through to registration.
  it("rejects a national-format number and says what to type instead", () => {
    const error = internationalPhoneError("07597959648");
    expect(error).toMatch(/no leading 0/);
    expect(error).toMatch(/447911123456/);
  });

  it("rejects junk that survived normalizePhone's digit strip", () => {
    // normalizePhone("abc1") is "1".
    expect(internationalPhoneError("1")).toMatch(/valid phone number/);
    expect(internationalPhoneError("")).toMatch(/valid phone number/);
  });

  it("rejects a number longer than E.164 allows", () => {
    expect(internationalPhoneError("4475979596481234")).toMatch(/valid phone number/);
  });
});
