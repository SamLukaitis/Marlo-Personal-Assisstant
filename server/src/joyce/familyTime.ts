import { DateTime, IANAZone } from "luxon";
import { decryptFor, encryptFor } from "./familyKey.js";
import type { FamilyData } from "./familyDb.js";
import { guessTimezoneFromPhone } from "./phoneTimezoneGuess.js";

// Each family has one timezone, used for reminders, the calendar and "what's on today". Every
// time Joyce takes from or gives to a family is a local wall-clock time in this zone; storage is
// UTC. Members in different countries share the family's zone — fine for most families, and the
// simplest thing that's right for them.
//
// Where it comes from:
//   1. A member telling Joyce (set_family_timezone). Only a city zone like "Europe/London" is
//      accepted, never "UTC"/"GMT"/"Etc/…": Marlo once let the model turn "the UK" into "UTC",
//      which is a valid zone, so nothing caught it and reminders fired an hour late in summer.
//   2. Otherwise a guess from the phone number of whoever Joyce is talking to (phoneTimezoneGuess.ts),
//      stored as a guess so Joyce says which zone she assumed.
//   3. Otherwise UTC, also as a guess.

const ZONE_KEY = "timezone_enc";
const ZONE_GUESSED_KEY = "timezone_guessed";

export interface FamilyZone {
  zone: string;
  /** True when no member has confirmed it — Joyce should mention which zone she assumed. */
  guessed: boolean;
}

function readMeta(family: FamilyData, key: string): string | null {
  const row = family.db.prepare(`SELECT value FROM family_meta WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function writeMeta(family: FamilyData, key: string, value: string): void {
  family.db
    .prepare(
      `INSERT INTO family_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(key, value);
}

function store(family: FamilyData, zone: string, guessed: boolean): void {
  writeMeta(family, ZONE_KEY, encryptFor(family.key, zone));
  writeMeta(family, ZONE_GUESSED_KEY, guessed ? "1" : "0");
}

/**
 * The family's timezone. With `guessFromPhone`, a family that has none yet gets one guessed from
 * that number and stored, so the guess is made once rather than differently per member.
 */
export function getFamilyZone(family: FamilyData, guessFromPhone?: string): FamilyZone {
  const stored = readMeta(family, ZONE_KEY);
  if (stored) {
    return { zone: decryptFor(family.key, stored), guessed: readMeta(family, ZONE_GUESSED_KEY) !== "0" };
  }
  const guess = guessFromPhone ? guessTimezoneFromPhone(guessFromPhone) : null;
  if (guess) {
    store(family, guess, true);
    return { zone: guess, guessed: true };
  }
  return { zone: "UTC", guessed: true };
}

/** True for a real "Region/City" zone; false for UTC, GMT, Etc/… and anything luxon doesn't know. */
export function isCityZone(zone: string): boolean {
  return /^[A-Z][A-Za-z_]+\/[A-Za-z_\-/]+$/.test(zone) && !zone.startsWith("Etc/") && IANAZone.isValidZone(zone);
}

/** Returns false (and stores nothing) unless it's a city zone — see the note at the top. */
export function setFamilyZone(family: FamilyData, zone: string): boolean {
  const trimmed = zone.trim();
  if (!isCityZone(trimmed)) return false;
  store(family, trimmed, false);
  return true;
}

export type LocalWhen =
  | { allDay: false; utcMs: number }
  | { allDay: true; date: string; utcMs: number };

/**
 * Reads a local time the model wrote in the family's zone: "2026-10-21T16:00" for a time, or
 * "2026-10-21" for a whole day (utcMs is that day's local midnight). Null if it isn't one of
 * those or isn't a real date. A trailing Z or offset is refused: these are always local times.
 */
export function parseLocal(input: string, zone: string): LocalWhen | null {
  const text = input.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const dt = DateTime.fromISO(text, { zone });
    return dt.isValid ? { allDay: true, date: text, utcMs: dt.toMillis() } : null;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(text)) {
    const dt = DateTime.fromISO(text, { zone });
    return dt.isValid ? { allDay: false, utcMs: dt.toMillis() } : null;
  }
  return null;
}

/** "Tue 21 Oct, 16:00" in the family's zone. */
export function formatLocal(utcMs: number, zone: string): string {
  return DateTime.fromMillis(utcMs, { zone }).toFormat("ccc d LLL, HH:mm");
}

/** "Tue 21 Oct" for an all-day date string. */
export function formatLocalDate(date: string, zone: string): string {
  return DateTime.fromISO(date, { zone }).toFormat("ccc d LLL");
}

/** Midnight at the start of the local day after `date`, in UTC ms — the end of an all-day span. */
export function endOfLocalDate(date: string, zone: string): number {
  return DateTime.fromISO(date, { zone }).plus({ days: 1 }).toMillis();
}

/** What the model is told the time is: weekday, date and time in the family's zone. */
export function describeNow(zone: string, now = Date.now()): string {
  return DateTime.fromMillis(now, { zone }).toFormat("cccc d LLLL yyyy, HH:mm");
}
