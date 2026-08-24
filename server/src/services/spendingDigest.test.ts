import { describe, it, expect } from "vitest";
import { buildSpendingDigest } from "./spendingDigest.js";
import type { EntityRow } from "../db/store.js";
import type { ExpenseData, BookingData } from "./entityValidation.js";

function expenseRow(overrides: Partial<ExpenseData> & { status?: EntityRow<ExpenseData>["status"] } = {}): EntityRow<ExpenseData> {
  const { status = "active", ...data } = overrides;
  return {
    id: Math.floor(Math.random() * 1e9),
    type: "expense",
    status,
    confidence: 1,
    createdAt: 0,
    updatedAt: 0,
    data: { vendor: "Some Vendor", amountPence: 1000, currency: "GBP", date: "2026-08-10", ...data },
  };
}

function bookingRow(overrides: Partial<BookingData> & { status?: EntityRow<BookingData>["status"] } = {}): EntityRow<BookingData> {
  const { status = "active", ...data } = overrides;
  return {
    id: Math.floor(Math.random() * 1e9),
    type: "booking",
    status,
    confidence: 1,
    createdAt: 0,
    updatedAt: 0,
    data: { kind: "flight", name: "Test Flight", reference: null, startDate: "2026-09-01", endDate: null, ...data },
  };
}

const SINCE = Date.UTC(2026, 7, 1); // 2026-08-01
const UNTIL = Date.UTC(2026, 7, 31); // 2026-08-31
const PRIOR_SINCE = Date.UTC(2026, 6, 2); // 2026-07-02
const PRIOR_UNTIL = Date.UTC(2026, 6, 31); // 2026-07-31

describe("buildSpendingDigest", () => {
  it("totals spend per currency within the period, excluding needs_review", () => {
    const expenses = [
      expenseRow({ vendor: "Uber", amountPence: 1200, currency: "GBP", date: "2026-08-05" }),
      expenseRow({ vendor: "Uber", amountPence: 800, currency: "GBP", date: "2026-08-06" }),
      expenseRow({ vendor: "Hotel Eva", amountPence: 5000, currency: "EUR", date: "2026-08-10" }),
      expenseRow({ vendor: "Bad Scan", amountPence: 999999, currency: "GBP", date: "2026-08-11", status: "needs_review" }),
      expenseRow({ vendor: "Old Taxi", amountPence: 500, currency: "GBP", date: "2026-06-01" }), // outside window
    ];

    const digest = buildSpendingDigest(expenses, [], { sinceMs: SINCE, untilMs: UNTIL });

    expect(digest.totalsByCurrency).toEqual([
      { currency: "EUR", totalMinorUnits: 5000 },
      { currency: "GBP", totalMinorUnits: 2000 },
    ]);
    expect(digest.topVendors).toContainEqual({ vendor: "Uber", currency: "GBP", totalMinorUnits: 2000 });
    expect(digest.needsReviewCount).toBe(1);
  });

  it("computes a period-over-period delta per currency", () => {
    const expenses = [
      expenseRow({ currency: "GBP", amountPence: 1000, date: "2026-08-15" }),
      expenseRow({ currency: "GBP", amountPence: 500, date: "2026-07-15" }),
    ];

    const digest = buildSpendingDigest(expenses, [], {
      sinceMs: SINCE,
      untilMs: UNTIL,
      priorSinceMs: PRIOR_SINCE,
      priorUntilMs: PRIOR_UNTIL,
    });

    expect(digest.deltaByCurrency).toEqual([{ currency: "GBP", deltaMinorUnits: 500, priorTotalMinorUnits: 500 }]);
  });

  it("counts upcoming bookings within the period, separate from expenses", () => {
    const bookings = [
      bookingRow({ startDate: "2026-08-20" }),
      bookingRow({ startDate: "2026-08-25", status: "needs_review" }),
      bookingRow({ startDate: "2026-09-05" }), // outside window
    ];

    const digest = buildSpendingDigest([], bookings, { sinceMs: SINCE, untilMs: UNTIL });

    expect(digest.upcomingBookingsCount).toBe(1);
    expect(digest.needsReviewCount).toBe(1);
  });

  it("returns empty totals when there's no data in the window", () => {
    const digest = buildSpendingDigest([], [], { sinceMs: SINCE, untilMs: UNTIL });
    expect(digest.totalsByCurrency).toEqual([]);
    expect(digest.topVendors).toEqual([]);
    expect(digest.upcomingBookingsCount).toBe(0);
    expect(digest.needsReviewCount).toBe(0);
  });
});
