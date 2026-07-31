import type { TravelCheckinRow } from "../db/store.js";

// Not exhaustive at the edges (e.g. Bulgaria/Romania's partial 2024 Schengen accession is
// simplified to "in"), but covers the countries that matter for the common 90/180-day question.
const SCHENGEN_COUNTRIES = new Set([
  "Austria", "Belgium", "Croatia", "Czechia", "Denmark", "Estonia", "Finland", "France",
  "Germany", "Greece", "Hungary", "Iceland", "Italy", "Latvia", "Liechtenstein", "Lithuania",
  "Luxembourg", "Malta", "Netherlands", "Norway", "Poland", "Portugal", "Slovakia", "Slovenia",
  "Spain", "Sweden", "Switzerland",
]);

const EU_COUNTRIES = new Set([
  "Austria", "Belgium", "Bulgaria", "Croatia", "Cyprus", "Czechia", "Denmark", "Estonia",
  "Finland", "France", "Germany", "Greece", "Hungary", "Ireland", "Italy", "Latvia",
  "Lithuania", "Luxembourg", "Malta", "Netherlands", "Poland", "Portugal", "Romania",
  "Slovakia", "Slovenia", "Spain", "Sweden",
]);

const DAY_MS = 24 * 60 * 60 * 1000;

function membershipTest(area: string): (country: string | null) => boolean {
  const normalized = area.trim().toLowerCase();
  if (normalized === "schengen") return (c) => !!c && SCHENGEN_COUNTRIES.has(c);
  if (normalized === "eu" || normalized === "european union") return (c) => !!c && EU_COUNTRIES.has(c);
  return (c) => !!c && c.toLowerCase() === normalized;
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export interface TravelDaysResult {
  area: string;
  sinceDate: string;
  untilDate: string;
  daysPresent: number;
  totalDaysInWindow: number;
  checkinsConsidered: number;
}

/**
 * Reconstructs a day-by-day "which country was the user in" timeline from check-in points
 * (each check-in marks a border crossing / landing, not a continuous feed), then counts how
 * many of those days fall in the requested area. Deterministic date arithmetic — no model
 * involved — since day counts need to be exact, not estimated.
 */
export function countTravelDays(
  checkinsAscending: TravelCheckinRow[],
  area: string,
  sinceMs: number,
  untilMs: number
): TravelDaysResult {
  const matches = membershipTest(area);
  const since = startOfDay(sinceMs);
  const until = startOfDay(untilMs);

  let idx = 0;
  let currentCountry: string | null = null;
  let daysPresent = 0;
  let totalDays = 0;

  for (let day = since; day <= until; day += DAY_MS) {
    const dayEnd = day + DAY_MS - 1;
    while (idx < checkinsAscending.length && checkinsAscending[idx].checkedInAt <= dayEnd) {
      currentCountry = checkinsAscending[idx].country;
      idx++;
    }
    totalDays++;
    if (matches(currentCountry)) daysPresent++;
  }

  return {
    area,
    sinceDate: new Date(since).toISOString().slice(0, 10),
    untilDate: new Date(until).toISOString().slice(0, 10),
    daysPresent,
    totalDaysInWindow: totalDays,
    checkinsConsidered: checkinsAscending.length,
  };
}
