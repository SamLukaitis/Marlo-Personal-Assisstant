import { describe, it, expect } from "vitest";
import { validateTravelMovement, type TravelMovement } from "./travelValidation.js";

const UPLOAD = new Date("2026-06-01T12:00:00Z");

const base: TravelMovement = {
  arrivalCountry: "France",
  arrivalCity: "Paris",
  arrivalDateTime: "2026-06-05T18:30:00",
};

describe("validateTravelMovement", () => {
  it("accepts a valid same-day trip", () => {
    const r = validateTravelMovement(
      { ...base, departureDateTime: "2026-06-05T08:00:00", arrivalDateTime: "2026-06-05T20:00:00" },
      UPLOAD
    );
    expect(r.severity).toBe("ok");
    expect(r.confidence).toBe(1);
    expect(r.issues).toEqual([]);
  });

  it("accepts a valid multi-day trip", () => {
    const r = validateTravelMovement(
      { ...base, departureDateTime: "2026-05-28T09:00:00", arrivalDateTime: "2026-06-05T18:30:00" },
      UPLOAD
    );
    expect(r.severity).toBe("ok");
  });

  it("accepts arrival-only movements (departure omitted, allowed by the interface)", () => {
    const r = validateTravelMovement({ ...base }, UPLOAD);
    expect(r.severity).toBe("ok");
    expect(r.issues).toEqual([]);
  });

  it("warns when arrival slightly precedes departure (timezone-naive strings)", () => {
    const r = validateTravelMovement(
      { ...base, departureDateTime: "2026-06-05T22:00:00", arrivalDateTime: "2026-06-05T20:00:00" },
      UPLOAD
    );
    expect(r.severity).toBe("warn");
    expect(r.issues.join(" ")).toMatch(/precedes departure by 2h/);
  });

  it("rejects when arrival precedes departure by more than 48h", () => {
    const r = validateTravelMovement(
      { ...base, departureDateTime: "2026-06-10T09:00:00", arrivalDateTime: "2026-06-05T18:30:00" },
      UPLOAD
    );
    expect(r.severity).toBe("reject");
    expect(r.issues.join(" ")).toMatch(/swapped or misread/);
  });

  it("warns on identical departure and arrival timestamps", () => {
    const r = validateTravelMovement({ ...base, departureDateTime: base.arrivalDateTime }, UPLOAD);
    expect(r.severity).toBe("warn");
    expect(r.issues.join(" ")).toMatch(/identical/);
  });

  it("rejects a calendar-impossible date (Feb 30)", () => {
    const r = validateTravelMovement({ ...base, arrivalDateTime: "2026-02-30T10:00:00" }, UPLOAD);
    expect(r.severity).toBe("reject");
    expect(r.issues.join(" ")).toMatch(/not a valid calendar datetime/);
  });

  it("rejects Feb 29 in a non-leap year", () => {
    const r = validateTravelMovement({ ...base, arrivalDateTime: "2027-02-29T10:00:00" }, UPLOAD);
    expect(r.severity).toBe("reject");
  });

  it("rejects a missing arrival datetime", () => {
    const r = validateTravelMovement(
      { ...base, arrivalDateTime: undefined as unknown as string },
      UPLOAD
    );
    expect(r.severity).toBe("reject");
  });

  it("rejects a non-string garbage arrival datetime", () => {
    const r = validateTravelMovement({ ...base, arrivalDateTime: "not-a-date" }, UPLOAD);
    expect(r.severity).toBe("reject");
  });

  it("rejects empty required location fields", () => {
    const r = validateTravelMovement({ ...base, arrivalCity: "  " }, UPLOAD);
    expect(r.severity).toBe("reject");
  });

  // ---- Distance-from-upload buckets: near (<=60d, silent) / moderate (<=200d) /
  // year-off (<=450d) / far (>450d). Values below are hand-verified against the actual bucket
  // thresholds, not just asserted from a design writeup.

  it("stays clean for a date well within the near-upload window", () => {
    // 4 days from upload.
    const r = validateTravelMovement({ ...base, arrivalDateTime: "2026-06-05T18:30:00" }, UPLOAD);
    expect(r.severity).toBe("ok");
    expect(r.confidence).toBe(1);
  });

  it("warns with a recorded issue on a moderately distant date (advance booking)", () => {
    // 2026-06-01 -> 2027-03-15 is 287 days: > 200 and <= 450, so this lands in the *year-off*
    // bucket (confidence 0.55), not "moderate" (0.05) — 287 days is itself close to a year,
    // which is exactly the ambiguity this bucket exists to flag.
    const r = validateTravelMovement({ ...base, arrivalDateTime: "2027-03-15T18:30:00" }, UPLOAD);
    expect(r.severity).toBe("warn");
    expect(r.issues.join(" ")).toMatch(/roughly a year/);
    expect(r.confidence).toBeCloseTo(0.55, 5);
  });

  it("warns with a smaller confidence hit on a genuinely moderate distance", () => {
    // 2026-06-01 -> 2026-10-15 is 136 days: > 60 and <= 200 -> moderate bucket.
    const r = validateTravelMovement({ ...base, arrivalDateTime: "2026-10-15T18:30:00" }, UPLOAD);
    expect(r.severity).toBe("warn");
    expect(r.issues.join(" ")).toMatch(/days from the upload date/);
    expect(r.confidence).toBeCloseTo(0.95, 5);
  });

  it("flags the year-inferred-wrong case (missing-year boarding pass) as warn, not ok", () => {
    // 2024-06-05 -> 2026-06-01 is ~725.7 days: > 450 -> far bucket. This is the primary target
    // scenario (model inferred 2024 instead of 2026) and must never come back as a clean "ok".
    const r = validateTravelMovement({ ...base, arrivalDateTime: "2024-06-05T18:30:00" }, UPLOAD);
    expect(r.severity).toBe("warn");
    expect(r.issues.join(" ")).toMatch(/far \(\d+ days\)/);
    expect(r.confidence).toBeCloseTo(0.45, 5);
  });

  it("warns (never rejects) on a far-past keepsake upload", () => {
    // ~2477 days out -> far bucket, but still just a warn: an old keepsake is legitimate.
    const r = validateTravelMovement({ ...base, arrivalDateTime: "2019-08-20T18:30:00" }, UPLOAD);
    expect(r.severity).toBe("warn");
    expect(r.issues.join(" ")).toMatch(/far \(\d+ days\)/);
    expect(r.confidence).toBeCloseTo(0.45, 5);
  });

  it("warns (never rejects) on a far-future legitimate booking", () => {
    // ~640 days out -> far bucket, but a booking made ~21 months ahead is legitimate.
    const r = validateTravelMovement({ ...base, arrivalDateTime: "2028-03-01T18:30:00" }, UPLOAD);
    expect(r.severity).toBe("warn");
    expect(r.confidence).toBeCloseTo(0.45, 5);
  });

  // ---- Day/month transposition (R5): fires only when swapping day<->month changes whether the
  // date reads as "near" the upload date (within NEAR_UPLOAD_DAYS = 60d) — that's the
  // discriminating signal for an OCR/vision digit transposition, not any arbitrary boundary.

  it("flags a day/month transposition that flips near-upload plausibility", () => {
    // Original 2026-01-06 is 146 days from upload (not near). Swapped reading 2026-06-01 is
    // exactly the upload date (0 days, near). Verdicts differ -> fires.
    const r = validateTravelMovement({ ...base, arrivalDateTime: "2026-01-06T18:30:00" }, UPLOAD);
    expect(r.severity).toBe("warn");
    expect(r.issues.join(" ")).toMatch(/day\/month/);
  });

  it("does not flag day/month ambiguity when both readings are near the upload date", () => {
    // Original 2026-05-04 is 28 days from upload (near). Swapped reading 2026-04-05 is 57 days
    // (also near, since NEAR_UPLOAD_DAYS = 60). Same verdict both ways -> no ambiguity flag.
    const r = validateTravelMovement({ ...base, arrivalDateTime: "2026-05-04T18:30:00" }, UPLOAD);
    expect(r.severity).toBe("ok");
    expect(r.issues).toEqual([]);
  });

  it("does not flag day/month ambiguity when neither reading is near the upload date", () => {
    // Original 2026-01-10 (day=10, month=01) is 142 days out (not near). Swapped reading
    // 2026-10-01 is 122 days out (also not near). Same verdict both ways -> no ambiguity flag,
    // though the distance bucket itself still applies to the original reading.
    const r = validateTravelMovement({ ...base, arrivalDateTime: "2026-01-10T18:30:00" }, UPLOAD);
    expect(r.issues.some((i) => i.includes("day/month"))).toBe(false);
  });
});
