import type { EntityRow } from "../db/store.js";
import type { ExpenseData, BookingData } from "./entityValidation.js";

export interface CurrencyTotal {
  currency: string;
  totalMinorUnits: number;
}

export interface VendorTotal {
  vendor: string;
  currency: string;
  totalMinorUnits: number;
}

export interface CurrencyDelta {
  currency: string;
  deltaMinorUnits: number; // this period's total minus the prior period's, same currency
  priorTotalMinorUnits: number;
}

export interface SpendingDigest {
  totalsByCurrency: CurrencyTotal[];
  topVendors: VendorTotal[];
  deltaByCurrency: CurrencyDelta[];
  upcomingBookingsCount: number;
  needsReviewCount: number;
}

export interface SpendingDigestOptions {
  sinceMs: number;
  untilMs: number;
  // Optional prior window for a period-over-period delta. Omitted entirely if not supplied -
  // callers that don't need the trend shouldn't have to think about it.
  priorSinceMs?: number;
  priorUntilMs?: number;
}

function inWindow(dateStr: string, sinceMs: number, untilMs: number): boolean {
  const ms = new Date(dateStr).getTime();
  return Number.isFinite(ms) && ms >= sinceMs && ms <= untilMs;
}

function sumByCurrency(expenses: EntityRow<ExpenseData>[]): CurrencyTotal[] {
  const totals = new Map<string, number>();
  for (const e of expenses) {
    totals.set(e.data.currency, (totals.get(e.data.currency) ?? 0) + e.data.amountPence);
  }
  return [...totals.entries()]
    .map(([currency, totalMinorUnits]) => ({ currency, totalMinorUnits }))
    .sort((a, b) => b.totalMinorUnits - a.totalMinorUnits);
}

function topVendorsByCurrency(expenses: EntityRow<ExpenseData>[], limit = 5): VendorTotal[] {
  const totals = new Map<string, VendorTotal>();
  for (const e of expenses) {
    const key = `${e.data.vendor}::${e.data.currency}`;
    const existing = totals.get(key);
    if (existing) {
      existing.totalMinorUnits += e.data.amountPence;
    } else {
      totals.set(key, { vendor: e.data.vendor, currency: e.data.currency, totalMinorUnits: e.data.amountPence });
    }
  }
  return [...totals.values()].sort((a, b) => b.totalMinorUnits - a.totalMinorUnits).slice(0, limit);
}

/**
 * Deterministic aggregation over expense/booking entities already extracted by the ingestion
 * layer - this reads that data, it never re-derives or re-validates it. Totals are grouped per
 * currency rather than summed across currencies (a EUR amount and a GBP amount are not
 * interchangeable), and needs_review items are counted separately rather than silently folded
 * into a total that would then be presented as trustworthy.
 */
export function buildSpendingDigest(
  expenses: EntityRow<ExpenseData>[],
  bookings: EntityRow<BookingData>[],
  opts: SpendingDigestOptions
): SpendingDigest {
  const { sinceMs, untilMs, priorSinceMs, priorUntilMs } = opts;

  const trusted = expenses.filter((e) => e.status !== "needs_review");
  const inPeriod = trusted.filter((e) => inWindow(e.data.date, sinceMs, untilMs));

  const needsReviewCount =
    expenses.filter((e) => e.status === "needs_review" && inWindow(e.data.date, sinceMs, untilMs)).length +
    bookings.filter((b) => b.status === "needs_review" && inWindow(b.data.startDate, sinceMs, untilMs)).length;

  const upcomingBookingsCount = bookings.filter(
    (b) => b.status !== "needs_review" && inWindow(b.data.startDate, sinceMs, untilMs)
  ).length;

  let deltaByCurrency: CurrencyDelta[] = [];
  if (priorSinceMs !== undefined && priorUntilMs !== undefined) {
    const priorInPeriod = trusted.filter((e) => inWindow(e.data.date, priorSinceMs, priorUntilMs));
    const currentTotals = sumByCurrency(inPeriod);
    const priorTotals = new Map(sumByCurrency(priorInPeriod).map((t) => [t.currency, t.totalMinorUnits]));
    const currencies = new Set([...currentTotals.map((t) => t.currency), ...priorTotals.keys()]);
    deltaByCurrency = [...currencies].map((currency) => {
      const current = currentTotals.find((t) => t.currency === currency)?.totalMinorUnits ?? 0;
      const prior = priorTotals.get(currency) ?? 0;
      return { currency, deltaMinorUnits: current - prior, priorTotalMinorUnits: prior };
    });
  }

  return {
    totalsByCurrency: sumByCurrency(inPeriod),
    topVendors: topVendorsByCurrency(inPeriod),
    deltaByCurrency,
    upcomingBookingsCount,
    needsReviewCount,
  };
}
