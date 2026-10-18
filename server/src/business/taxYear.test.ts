import { describe, it, expect } from "vitest";
import { taxYearFor } from "./taxYear.js";

describe("taxYearFor", () => {
  it("5 April belongs to the year that started the previous April", () => {
    expect(taxYearFor("2027-04-05")).toEqual({ label: "2026-27", start: "2026-04-06", end: "2027-04-05" });
  });
  it("6 April starts a new tax year", () => {
    expect(taxYearFor("2027-04-06")).toEqual({ label: "2027-28", start: "2027-04-06", end: "2028-04-05" });
  });
  it("January belongs to the year that started the previous April", () => {
    expect(taxYearFor("2027-01-15").label).toBe("2026-27");
  });
  it("rejects malformed dates", () => {
    expect(() => taxYearFor("15/01/2027")).toThrow();
  });
});
