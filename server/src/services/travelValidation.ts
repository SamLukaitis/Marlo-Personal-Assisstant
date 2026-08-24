// Deterministic guardrail around the LLM's travel-fact extraction (documents.ts). The model is
// instructed never to invent an unreadable date, but that instruction isn't always followed
// correctly — and when a document doesn't print a year, the model infers one from the upload
// timestamp, which occasionally lands on the wrong year (a trip spanning New Year's Eve, or a
// document uploaded well after travel as a keepsake/receipt). A single bad date silently
// corrupts the day-by-day arrival/departure log the Schengen-style day count is built from
// (travelDays.ts), so this runs before a movement is trusted enough to store — no LLM call here,
// pure arithmetic, easily unit-tested in isolation.

export interface TravelMovement {
  departureCountry?: string;
  departureCity?: string;
  departureDateTime?: string;
  arrivalCountry: string;
  arrivalCity: string;
  arrivalDateTime: string;
}

export type ValidationSeverity = "ok" | "warn" | "reject";

export interface ValidationResult {
  severity: ValidationSeverity;
  confidence: number; // 0-1
  issues: string[]; // human-readable reasons; empty when there's nothing to flag
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

// Timezone-naive strings make small chronology inversions legitimate (a UTC+14 -> UTC-12 leg can
// render as ~26h of "negative" travel on paper). Beyond this there's no plausible timezone story
// left — almost certainly swapped fields or a misread digit.
const CHRONOLOGY_SLACK_MS = 48 * HOUR_MS;

// Graduated distance-from-upload buckets, in days. Boarding passes are near-day-of; booking
// confirmations/receipts can legitimately be much further out in either direction, so distance
// alone can never justify a hard reject — it only erodes confidence and gets recorded as an
// issue (never silently). The "year-off" band is sized around the actual failure mode this
// exists to catch: the model inferring the wrong year lands roughly 200-450 days off, since the
// true date and the wrongly-inferred one differ by close to a year either side of the upload.
const NEAR_UPLOAD_DAYS = 60;
const MODERATE_DISTANCE_DAYS = 200;
const YEAR_OFF_DAYS = 450;

const WEIGHTS = {
  chronologyInverted: 0.3,
  zeroDuration: 0.15,
  moderateDistance: 0.05,
  yearOffDistance: 0.45,
  farDistance: 0.55,
  ambiguousDayMonthSwap: 0.25,
} as const;

interface ParsedDateTime {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

// Deliberately stricter than `new Date(...)`: JS silently rolls an impossible date over (e.g.
// "2026-02-30" becomes March 2) instead of rejecting it, which would hide exactly the kind of
// OCR/vision digit transposition this guardrail exists to catch.
const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/;

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month === 2 && isLeapYear(year) ? 29 : lengths[month - 1];
}

function parseStrict(value: unknown): ParsedDateTime | null {
  if (typeof value !== "string") return null;
  const m = ISO_RE.exec(value.trim());
  if (!m) return null;
  const [, ys, mos, ds, hs, mins, ss] = m;
  const p: ParsedDateTime = {
    year: Number(ys),
    month: Number(mos),
    day: Number(ds),
    hour: Number(hs),
    minute: Number(mins),
    second: ss ? Number(ss) : 0,
  };
  if (p.month < 1 || p.month > 12) return null;
  if (p.day < 1 || p.day > daysInMonth(p.year, p.month)) return null;
  if (p.hour > 23 || p.minute > 59 || p.second > 59) return null;
  return p;
}

function toUtcMs(p: ParsedDateTime): number {
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

function format(p: ParsedDateTime): string {
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function validateTravelMovement(
  movement: TravelMovement,
  uploadedAt: Date
): ValidationResult {
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

  // ---- structural validity ----
  if (typeof movement.arrivalCountry !== "string" || movement.arrivalCountry.trim() === "") {
    fail("Missing or empty arrival country.");
  }
  if (typeof movement.arrivalCity !== "string" || movement.arrivalCity.trim() === "") {
    fail("Missing or empty arrival city.");
  }

  const arrival = parseStrict(movement.arrivalDateTime);
  if (!arrival) {
    fail(
      "arrivalDateTime is missing or not a valid calendar datetime " +
        `(got ${JSON.stringify(movement.arrivalDateTime)}).`
    );
  }

  let departure: ParsedDateTime | null = null;
  if (movement.departureDateTime !== undefined) {
    departure = parseStrict(movement.departureDateTime);
    if (!departure) {
      fail(
        "departureDateTime was provided but is not a valid calendar datetime " +
          `(got ${JSON.stringify(movement.departureDateTime)}).`
      );
    }
  }

  // ---- chronology ----
  if (arrival && departure) {
    const deltaMs = toUtcMs(arrival) - toUtcMs(departure);
    if (deltaMs === 0) {
      warn(
        "Departure and arrival timestamps are identical; likely a copy error.",
        WEIGHTS.zeroDuration
      );
    } else if (deltaMs < -CHRONOLOGY_SLACK_MS) {
      fail(
        `Arrival precedes departure by more than 48h (${format(departure)} -> ${format(arrival)}); ` +
          "fields are likely swapped or misread."
      );
    } else if (deltaMs < 0) {
      warn(
        `Arrival precedes departure by ${Math.round(-deltaMs / HOUR_MS)}h; plausible for extreme ` +
          "timezone spans but worth verifying.",
        WEIGHTS.chronologyInverted
      );
    }
  }

  // ---- graduated plausibility vs uploadedAt, plus day/month transposition ----
  if (arrival) {
    const arrivalMs = toUtcMs(arrival);
    const distDays = Math.abs(arrivalMs - uploadedAt.getTime()) / DAY_MS;

    if (distDays > NEAR_UPLOAD_DAYS && distDays <= MODERATE_DISTANCE_DAYS) {
      warn(
        `Arrival date ${format(arrival)} is ${Math.round(distDays)} days from the upload date; ` +
          "plausible for an advance booking or late upload.",
        WEIGHTS.moderateDistance
      );
    } else if (distDays > MODERATE_DISTANCE_DAYS && distDays <= YEAR_OFF_DAYS) {
      warn(
        `Arrival date ${format(arrival)} is roughly a year (${Math.round(distDays)} days) from ` +
          "the upload date; the inferred year may be wrong (e.g. document spans New Year's Eve, " +
          "or was uploaded long after travel).",
        WEIGHTS.yearOffDistance
      );
    } else if (distDays > YEAR_OFF_DAYS) {
      warn(
        `Arrival date ${format(arrival)} is far (${Math.round(distDays)} days) from the upload ` +
          "date; could be an old keepsake or far-future booking, but verify the year.",
        WEIGHTS.farDistance
      );
    }

    // A day/month transposition (OCR/vision misreads a two-digit day as the month or vice
    // versa) only matters if it changes whether the date reads as near the upload time — that's
    // the discriminating signal, not whether it crosses some arbitrary far-off boundary.
    if (arrival.day <= 12 && arrival.month <= 12 && arrival.day !== arrival.month) {
      const swapped: ParsedDateTime = { ...arrival, day: arrival.month, month: arrival.day };
      const origNear = Math.abs(arrivalMs - uploadedAt.getTime()) <= NEAR_UPLOAD_DAYS * DAY_MS;
      const swapNear =
        Math.abs(toUtcMs(swapped) - uploadedAt.getTime()) <= NEAR_UPLOAD_DAYS * DAY_MS;
      if (origNear !== swapNear) {
        warn(
          `Ambiguous date ${format(arrival)}: reading it as day/month swapped (${format(swapped)}) ` +
            "changes whether it falls near the upload date; possible OCR day/month transposition.",
          WEIGHTS.ambiguousDayMonthSwap
        );
      }
    }
  }

  confidence = Math.max(0, Math.min(1, confidence));
  const severity: ValidationSeverity = reject ? "reject" : issues.length > 0 ? "warn" : "ok";
  return { severity, confidence, issues };
}
