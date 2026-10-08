// Deterministic guardrails for the expense and booking entity types — the same role
// travelValidation.ts plays for travel movements, and deliberately the same ValidationResult
// shape. No model call anywhere in this file: everything is arithmetic, whitelists, and strict
// calendar math, so a wrong extraction gets caught (or confidence-docked) for free, offline,
// and identically every time. Unlike travel_checkin's validator, these validate the exact shape
// that gets stored in entities.data — validate-what-you-store is the contract for new types.

import type { ValidationResult } from "./travelValidation.js";

// The currencies a receipt sent to this app could plausibly show. A whitelist rather than a
// full ISO-4217 table on purpose: a hallucinated or misread code ("EU", "EURO", "GB") should
// fail loudly, and the tail of real-but-implausible codes (XDR, KPW…) is more likely a misread
// than a real receipt. Extend as real receipts demand.
export const CURRENCY_CODES = new Set([
  "GBP", "EUR", "USD", "CHF", "NOK", "SEK", "DKK", "PLN", "CZK", "HUF",
  "RON", "BGN", "ISK", "TRY", "AED", "AUD", "CAD", "NZD", "JPY", "CNY",
  "HKD", "SGD", "INR", "THB", "MXN", "BRL", "ZAR", "MAD", "EGP", "ILS",
]);

// Currencies whose minor unit isn't 1/100 — for these, "amount × 100" would be wrong.
// (JPY has no minor unit; a ¥1,500 receipt is 1500 units, not 150000.)
const ZERO_DECIMAL_CURRENCIES = new Set(["JPY", "ISK"]);

const DAY_MS = 24 * 3_600_000;

// Same graduated buckets as travelValidation, for the same reason: distance from the upload
// date can't hard-reject (people file old receipts), it only erodes confidence — but the
// year-off band is where a wrongly-inferred year lands, so it erodes it hardest.
const NEAR_UPLOAD_DAYS = 90;
const MODERATE_DISTANCE_DAYS = 200;
const YEAR_OFF_DAYS = 450;

const WEIGHTS = {
  moderateDistance: 0.05,
  yearOffDistance: 0.45,
  farDistance: 0.55,
  largeAmount: 0.15,
  futureDatedExpense: 0.2,
} as const;

// ---------------------------------------------------------------------------
// Shared strict date helpers — stricter than `new Date(...)`, which silently rolls
// "2026-02-30" over to March 2nd instead of rejecting it (the exact digit-transposition
// failure these validators exist to catch).
// ---------------------------------------------------------------------------

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month === 2 && isLeapYear(year) ? 29 : lengths[month - 1];
}

// Returns the date's UTC-midnight timestamp, or null if the string isn't a real calendar date.
export function parseStrictDate(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = DATE_RE.exec(value.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return Date.UTC(year, month - 1, day);
}

// ---------------------------------------------------------------------------
// Amount parsing — deterministic conversion of an amount string exactly as printed on the
// receipt ("18.50", "1.234,56", "£1,234.56") into integer minor units. Kept in code rather
// than asking the model to do the arithmetic: a parser never transposes digits.
// ---------------------------------------------------------------------------

export function parseAmountToMinorUnits(raw: unknown, currency: string): number | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  // Strip currency symbols, letters, and whitespace; keep digits, separators, and sign.
  let s = String(raw).replace(/[^\d.,-]/g, "");
  if (!s || s.includes("-")) return null; // negative amounts are refunds — out of scope

  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastDot !== -1 && lastComma !== -1) {
    // Both present: whichever comes last is the decimal separator ("1.234,56" vs "1,234.56").
    const decimalSep = lastDot > lastComma ? "." : ",";
    const thousandsSep = decimalSep === "." ? "," : ".";
    s = s.split(thousandsSep).join("");
    s = s.replace(decimalSep, ".");
  } else if (lastComma !== -1) {
    // Comma only: decimal if followed by exactly 2 digits ("18,50"), thousands otherwise ("1,234").
    const after = s.length - lastComma - 1;
    s = after === 2 ? s.replace(",", ".") : s.split(",").join("");
  } else if (lastDot !== -1) {
    const after = s.length - lastDot - 1;
    if (after === 3 && s.split(".").length === 2) {
      // "1.234" — ambiguous; European thousands is far more likely than a 3-decimal price.
      s = s.split(".").join("");
    }
  }

  const value = Number(s);
  if (!Number.isFinite(value) || value <= 0) return null;

  const scale = ZERO_DECIMAL_CURRENCIES.has(currency) ? 1 : 100;
  const minor = Math.round(value * scale);
  // Guard against a rounding artifact hiding a genuinely fractional minor unit ("18.505").
  if (Math.abs(value * scale - minor) > 0.001) return null;
  return minor;
}

// ---------------------------------------------------------------------------
// expense — the shape stored in entities.data for type='expense'
// ---------------------------------------------------------------------------

export interface ExpenseData {
  vendor: string;
  amountPence: number; // integer minor units of `currency` (pence, cents, yen…)
  currency: string; // ISO 4217, uppercase
  date: string; // YYYY-MM-DD
  sourceAccountEmail?: string; // which connected inbox this was extracted from, if any (documents.ts)
}

export function validateExpense(data: unknown, ctx: { uploadedAt: Date }): ValidationResult {
  const issues: string[] = [];
  let confidence = 1;
  let reject = false;
  const fail = (msg: string) => {
    issues.push(msg);
    reject = true;
  };
  const warn = (msg: string, weight: number) => {
    issues.push(msg);
    confidence -= weight;
  };

  const d = data as Partial<ExpenseData> | null | undefined;

  if (!d || typeof d.vendor !== "string" || d.vendor.trim() === "") {
    fail("Missing or empty vendor.");
  }
  if (typeof d?.currency !== "string" || !CURRENCY_CODES.has(d.currency)) {
    fail(`Currency ${JSON.stringify(d?.currency)} is not a recognized ISO code.`);
  }
  if (typeof d?.amountPence !== "number" || !Number.isInteger(d.amountPence) || d.amountPence <= 0) {
    fail(`Amount ${JSON.stringify(d?.amountPence)} is not a positive whole number of minor units.`);
  } else if (d.amountPence > 1_000_000) {
    // > £10,000 (or equivalent) on a receipt — possible, but far more often a misplaced decimal.
    warn("Amount is unusually large for a receipt; check the decimal point.", WEIGHTS.largeAmount);
  }

  const dateMs = parseStrictDate(d?.date);
  if (dateMs === null) {
    fail(`date ${JSON.stringify(d?.date)} is not a valid YYYY-MM-DD calendar date.`);
  } else {
    const uploadMs = ctx.uploadedAt.getTime();
    if (dateMs > uploadMs + DAY_MS) {
      // Receipts document the past; a future date means a misread (unlike bookings, below).
      warn("Expense is dated in the future relative to its upload.", WEIGHTS.futureDatedExpense);
    }
    const distDays = Math.abs(dateMs - uploadMs) / DAY_MS;
    if (distDays > NEAR_UPLOAD_DAYS && distDays <= MODERATE_DISTANCE_DAYS) {
      warn(`Expense date is ${Math.round(distDays)} days from upload; plausible late filing.`, WEIGHTS.moderateDistance);
    } else if (distDays > MODERATE_DISTANCE_DAYS && distDays <= YEAR_OFF_DAYS) {
      warn(
        `Expense date is roughly a year (${Math.round(distDays)} days) from upload; the inferred year may be wrong.`,
        WEIGHTS.yearOffDistance
      );
    } else if (distDays > YEAR_OFF_DAYS) {
      warn(`Expense date is far (${Math.round(distDays)} days) from upload; verify the year.`, WEIGHTS.farDistance);
    }
  }

  confidence = Math.max(0, Math.min(1, confidence));
  return { severity: reject ? "reject" : issues.length > 0 ? "warn" : "ok", confidence, issues };
}

// ---------------------------------------------------------------------------
// trip — the shape stored in entities.data for type='trip' (guide §6): the grouping
// entity that expenses/bookings/checkins attach to via a --belongs_to--> link. `label` is the
// spatiotemporal id from JAKES_TODO.md — a place + time window, e.g. "London, 12–15 Jun 2026".
// ---------------------------------------------------------------------------

export interface TripData {
  label: string;
  startDate: string; // YYYY-MM-DD
  endDate: string | null; // null while the trip is still open/ongoing
}

export function validateTrip(data: unknown, ctx: { uploadedAt: Date }): ValidationResult {
  const issues: string[] = [];
  let confidence = 1;
  let reject = false;
  const fail = (msg: string) => {
    issues.push(msg);
    reject = true;
  };
  const warn = (msg: string, weight: number) => {
    issues.push(msg);
    confidence -= weight;
  };

  const d = data as Partial<TripData> | null | undefined;

  if (!d || typeof d.label !== "string" || d.label.trim() === "") {
    fail("Missing or empty trip label.");
  }

  const startMs = parseStrictDate(d?.startDate);
  if (startMs === null) {
    fail(`startDate ${JSON.stringify(d?.startDate)} is not a valid YYYY-MM-DD calendar date.`);
  }
  let endMs: number | null = null;
  if (d?.endDate != null) {
    endMs = parseStrictDate(d.endDate);
    if (endMs === null) {
      fail(`endDate ${JSON.stringify(d.endDate)} is not a valid YYYY-MM-DD calendar date.`);
    }
  }

  if (startMs !== null && endMs !== null && endMs < startMs) {
    fail("endDate precedes startDate; fields are likely swapped or misread.");
  }

  if (startMs !== null) {
    // Trips, like bookings, legitimately span past or future — no future-date rejection, only
    // the same year-off distance erosion (catches a wrongly-inferred year, not a real trip).
    const distDays = Math.abs(startMs - ctx.uploadedAt.getTime()) / DAY_MS;
    if (distDays > NEAR_UPLOAD_DAYS && distDays <= MODERATE_DISTANCE_DAYS) {
      warn(`Trip start is ${Math.round(distDays)} days from upload; plausible advance planning or late filing.`, WEIGHTS.moderateDistance);
    } else if (distDays > MODERATE_DISTANCE_DAYS && distDays <= YEAR_OFF_DAYS) {
      warn(
        `Trip start is roughly a year (${Math.round(distDays)} days) from upload; the inferred year may be wrong.`,
        WEIGHTS.yearOffDistance
      );
    } else if (distDays > YEAR_OFF_DAYS) {
      warn(`Trip start is far (${Math.round(distDays)} days) from upload; verify the year.`, WEIGHTS.farDistance);
    }
  }

  confidence = Math.max(0, Math.min(1, confidence));
  return { severity: reject ? "reject" : issues.length > 0 ? "warn" : "ok", confidence, issues };
}

// ---------------------------------------------------------------------------
// booking — the shape stored in entities.data for type='booking'
// ---------------------------------------------------------------------------

export const BOOKING_KINDS = ["flight", "hotel"] as const;
export type BookingKind = (typeof BOOKING_KINDS)[number];

export interface BookingData {
  kind: BookingKind;
  name: string; // "FR1234 LIS→FAO", "Hotel Eva, Faro"
  reference: string | null; // confirmation/PNR code if legible
  startDate: string; // YYYY-MM-DD — flight date / hotel check-in
  endDate: string | null; // hotel check-out; usually null for flights
  sourceAccountEmail?: string; // which connected inbox this was extracted from, if any (documents.ts)
  tripPrepNotifiedAt?: number; // set by tripPrep.ts once the booking has been handed to the attention gate — one-shot per booking
}

export function validateBooking(data: unknown, ctx: { uploadedAt: Date }): ValidationResult {
  const issues: string[] = [];
  let confidence = 1;
  let reject = false;
  const fail = (msg: string) => {
    issues.push(msg);
    reject = true;
  };
  const warn = (msg: string, weight: number) => {
    issues.push(msg);
    confidence -= weight;
  };

  const d = data as Partial<BookingData> | null | undefined;

  if (!d || !BOOKING_KINDS.includes(d.kind as BookingKind)) {
    fail(`kind ${JSON.stringify(d?.kind)} is not one of: ${BOOKING_KINDS.join(", ")}.`);
  }
  if (typeof d?.name !== "string" || d.name.trim() === "") {
    fail("Missing or empty booking name.");
  }

  const startMs = parseStrictDate(d?.startDate);
  if (startMs === null) {
    fail(`startDate ${JSON.stringify(d?.startDate)} is not a valid YYYY-MM-DD calendar date.`);
  }
  let endMs: number | null = null;
  if (d?.endDate != null) {
    endMs = parseStrictDate(d.endDate);
    if (endMs === null) {
      fail(`endDate ${JSON.stringify(d.endDate)} is not a valid YYYY-MM-DD calendar date.`);
    }
  }

  if (startMs !== null && endMs !== null && endMs < startMs) {
    fail("endDate precedes startDate; fields are likely swapped or misread.");
  }

  if (startMs !== null) {
    // Bookings legitimately live in the future (that's what a booking is), so unlike expenses
    // there's no future-date warning — only the same year-off distance erosion.
    const distDays = Math.abs(startMs - ctx.uploadedAt.getTime()) / DAY_MS;
    if (distDays > NEAR_UPLOAD_DAYS && distDays <= MODERATE_DISTANCE_DAYS) {
      warn(`Booking date is ${Math.round(distDays)} days from upload; plausible advance booking.`, WEIGHTS.moderateDistance);
    } else if (distDays > MODERATE_DISTANCE_DAYS && distDays <= YEAR_OFF_DAYS) {
      warn(
        `Booking date is roughly a year (${Math.round(distDays)} days) from upload; the inferred year may be wrong.`,
        WEIGHTS.yearOffDistance
      );
    } else if (distDays > YEAR_OFF_DAYS) {
      warn(`Booking date is far (${Math.round(distDays)} days) from upload; verify the year.`, WEIGHTS.farDistance);
    }
  }

  confidence = Math.max(0, Math.min(1, confidence));
  return { severity: reject ? "reject" : issues.length > 0 ? "warn" : "ok", confidence, issues };
}
