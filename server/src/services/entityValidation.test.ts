import { describe, it, expect } from "vitest";
import {
  parseAmountToMinorUnits,
  parseStrictDate,
  validateExpense,
  validateBooking,
  validateTrip,
  type ExpenseData,
  type BookingData,
  type TripData,
} from "./entityValidation.js";

const UPLOAD = new Date("2026-06-12T10:00:00Z");

function expense(overrides: Partial<ExpenseData> = {}): ExpenseData {
  return { vendor: "Hotel Eva", amountPence: 1850, currency: "EUR", date: "2026-06-12", ...overrides };
}

function booking(overrides: Partial<BookingData> = {}): BookingData {
  return {
    kind: "hotel",
    name: "Hotel Eva, Faro",
    reference: "ABC123",
    startDate: "2026-06-12",
    endDate: "2026-06-15",
    ...overrides,
  };
}

function trip(overrides: Partial<TripData> = {}): TripData {
  return { label: "Faro, 12–15 Jun 2026", startDate: "2026-06-12", endDate: "2026-06-15", ...overrides };
}

describe("parseAmountToMinorUnits", () => {
  it("parses plain decimal amounts", () => {
    expect(parseAmountToMinorUnits("18.50", "EUR")).toBe(1850);
    expect(parseAmountToMinorUnits("18", "EUR")).toBe(1800);
    expect(parseAmountToMinorUnits("18.5", "EUR")).toBe(1850);
  });

  it("parses European comma-decimal amounts", () => {
    expect(parseAmountToMinorUnits("18,50", "EUR")).toBe(1850);
    expect(parseAmountToMinorUnits("1.234,56", "EUR")).toBe(123456);
  });

  it("parses UK/US thousands-separated amounts", () => {
    expect(parseAmountToMinorUnits("1,234.56", "GBP")).toBe(123456);
    expect(parseAmountToMinorUnits("1,234", "GBP")).toBe(123400);
  });

  it("strips currency symbols and whitespace", () => {
    expect(parseAmountToMinorUnits("£1,234.56", "GBP")).toBe(123456);
    expect(parseAmountToMinorUnits("€ 18,50", "EUR")).toBe(1850);
  });

  it("treats a lone dot with three digits after it as European thousands", () => {
    expect(parseAmountToMinorUnits("1.234", "EUR")).toBe(123400);
  });

  it("does not multiply zero-decimal currencies by 100", () => {
    expect(parseAmountToMinorUnits("1,500", "JPY")).toBe(1500);
  });

  it("rejects garbage, negatives, and zero", () => {
    expect(parseAmountToMinorUnits("free", "EUR")).toBeNull();
    expect(parseAmountToMinorUnits("-5.00", "EUR")).toBeNull();
    expect(parseAmountToMinorUnits("0", "EUR")).toBeNull();
    expect(parseAmountToMinorUnits("", "EUR")).toBeNull();
  });
});

describe("parseStrictDate", () => {
  it("accepts a real calendar date", () => {
    expect(parseStrictDate("2026-06-12")).toBe(Date.UTC(2026, 5, 12));
  });

  it("rejects impossible dates instead of rolling them over", () => {
    expect(parseStrictDate("2026-02-30")).toBeNull();
    expect(parseStrictDate("2025-02-29")).toBeNull(); // not a leap year
    expect(parseStrictDate("2026-13-01")).toBeNull();
  });

  it("accepts Feb 29 in a leap year", () => {
    expect(parseStrictDate("2028-02-29")).toBe(Date.UTC(2028, 1, 29));
  });

  it("rejects non-date strings and other types", () => {
    expect(parseStrictDate("12/06/2026")).toBeNull();
    expect(parseStrictDate(undefined)).toBeNull();
  });
});

describe("validateExpense", () => {
  it("passes a clean expense", () => {
    const result = validateExpense(expense(), { uploadedAt: UPLOAD });
    expect(result.severity).toBe("ok");
    expect(result.confidence).toBe(1);
  });

  it("rejects an unknown currency code", () => {
    expect(validateExpense(expense({ currency: "EURO" }), { uploadedAt: UPLOAD }).severity).toBe("reject");
  });

  it("rejects a non-positive or fractional amount", () => {
    expect(validateExpense(expense({ amountPence: -1 }), { uploadedAt: UPLOAD }).severity).toBe("reject");
    expect(validateExpense(expense({ amountPence: 18.5 }), { uploadedAt: UPLOAD }).severity).toBe("reject");
  });

  it("rejects an impossible date", () => {
    expect(validateExpense(expense({ date: "2026-02-30" }), { uploadedAt: UPLOAD }).severity).toBe("reject");
  });

  it("warns (not rejects) on a future-dated expense", () => {
    const result = validateExpense(expense({ date: "2026-06-20" }), { uploadedAt: UPLOAD });
    expect(result.severity).toBe("warn");
    expect(result.confidence).toBeLessThan(1);
  });

  it("warns with a big confidence hit on a roughly-year-off date", () => {
    const result = validateExpense(expense({ date: "2025-06-12" }), { uploadedAt: UPLOAD });
    expect(result.severity).toBe("warn");
    expect(result.confidence).toBeLessThanOrEqual(0.6);
  });

  it("warns on an implausibly large amount", () => {
    const result = validateExpense(expense({ amountPence: 5_000_000 }), { uploadedAt: UPLOAD });
    expect(result.severity).toBe("warn");
  });
});

describe("validateBooking", () => {
  it("passes a clean hotel booking", () => {
    const result = validateBooking(booking(), { uploadedAt: UPLOAD });
    expect(result.severity).toBe("ok");
  });

  it("passes a flight with no endDate", () => {
    const result = validateBooking(booking({ kind: "flight", name: "FR1234 LIS→FAO", endDate: null }), {
      uploadedAt: UPLOAD,
    });
    expect(result.severity).toBe("ok");
  });

  it("rejects an unknown kind", () => {
    expect(validateBooking(booking({ kind: "car" as BookingData["kind"] }), { uploadedAt: UPLOAD }).severity).toBe(
      "reject"
    );
  });

  it("rejects check-out before check-in", () => {
    expect(
      validateBooking(booking({ startDate: "2026-06-15", endDate: "2026-06-12" }), { uploadedAt: UPLOAD }).severity
    ).toBe("reject");
  });

  it("does not penalize a legitimately future booking within the near window", () => {
    const result = validateBooking(booking({ startDate: "2026-08-01", endDate: "2026-08-05" }), {
      uploadedAt: UPLOAD,
    });
    expect(result.severity).toBe("ok");
  });

  it("warns on a roughly-year-off start date", () => {
    const result = validateBooking(booking({ startDate: "2025-06-12", endDate: null }), { uploadedAt: UPLOAD });
    expect(result.severity).toBe("warn");
    expect(result.confidence).toBeLessThanOrEqual(0.6);
  });
});

describe("validateTrip", () => {
  it("passes a clean trip with a date range", () => {
    const result = validateTrip(trip(), { uploadedAt: UPLOAD });
    expect(result.severity).toBe("ok");
  });

  it("passes an open (still-ongoing) trip with no endDate", () => {
    const result = validateTrip(trip({ endDate: null }), { uploadedAt: UPLOAD });
    expect(result.severity).toBe("ok");
  });

  it("rejects a missing or empty label", () => {
    expect(validateTrip(trip({ label: "" }), { uploadedAt: UPLOAD }).severity).toBe("reject");
  });

  it("rejects an end date before the start date", () => {
    expect(
      validateTrip(trip({ startDate: "2026-06-15", endDate: "2026-06-12" }), { uploadedAt: UPLOAD }).severity
    ).toBe("reject");
  });

  it("does not penalize a legitimately future trip within the near window", () => {
    const result = validateTrip(trip({ startDate: "2026-08-01", endDate: "2026-08-05" }), { uploadedAt: UPLOAD });
    expect(result.severity).toBe("ok");
  });

  it("warns on a roughly-year-off start date", () => {
    const result = validateTrip(trip({ startDate: "2025-06-12", endDate: null }), { uploadedAt: UPLOAD });
    expect(result.severity).toBe("warn");
    expect(result.confidence).toBeLessThanOrEqual(0.6);
  });
});
