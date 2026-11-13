// Turns the start/end the assistant passes to create_calendar_event / update_calendar_event into
// something a calendar provider will accept, without the model doing any timezone maths.
//
// Before this, the tool told the model to convert the user's local time to UTC itself. It often
// didn't: it passed the plain clock time the user said ("2026-11-14T15:00:00"), which Google
// rejects outright ("Missing time zone definition") and Outlook silently reads as UTC, or it
// converted with the wrong offset. Same lesson as reminders (userTimezone.ts): the model passes
// through what the user said, code does the arithmetic.
//
// - A plain date ("2026-11-14") is an all-day event. The model gives the last day inclusive; the
//   providers want the end exclusive, so a day is added here.
// - A clock time with no Z/offset is local time in `start_timezone`/`end_timezone` when given (an
//   event somewhere else: a flight), otherwise in the user's own timezone.
// - A time that already carries Z or an offset is an exact instant and is left alone.
import { DateTime, IANAZone } from "luxon";
import type { EventInput } from "../providers/types.js";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ZONED_SUFFIX = /(Z|[+-]\d{2}:?\d{2})$/i;
const DEFAULT_DURATION_MINUTES = 60;

export interface RawEventTimes {
  start?: string;
  end?: string;
  startTimeZone?: string;
  endTimeZone?: string;
}

// On a create, start and end are always present; on an update, only what was passed.
export type NormalizedEventTimes = Partial<Pick<EventInput, "start" | "end" | "startTimeZone" | "endTimeZone" | "allDay">>;

type Point =
  | { kind: "date"; date: DateTime }
  | { kind: "instant"; value: string; at: DateTime }
  | { kind: "local"; value: string; zone: string; at: DateTime };

function clean(value: string | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : undefined;
}

function parsePoint(label: "start" | "end", raw: string, zoneArg: string | undefined, homeZone: string | null): Point | { error: string } {
  if (DATE_ONLY.test(raw)) {
    const date = DateTime.fromISO(raw, { zone: "utc" });
    return date.isValid ? { kind: "date", date } : { error: `${label} "${raw}" is not a real date.` };
  }
  if (ZONED_SUFFIX.test(raw)) {
    const at = DateTime.fromISO(raw, { setZone: true });
    return at.isValid ? { kind: "instant", value: raw, at } : { error: `${label} "${raw}" is not a valid ISO 8601 datetime.` };
  }
  if (zoneArg && !IANAZone.isValidZone(zoneArg)) {
    return { error: `${label}_timezone "${zoneArg}" is not an IANA timezone name (use one like "Europe/London").` };
  }
  const zone = zoneArg ?? homeZone;
  if (!zone) {
    return {
      error:
        `I don't know the user's timezone, so I can't place ${label} "${raw}". Ask them which city or timezone ` +
        `they're in, then call again with ${label}_timezone set to its IANA name.`,
    };
  }
  const at = DateTime.fromISO(raw, { zone });
  if (!at.isValid) return { error: `${label} "${raw}" is not a valid ISO 8601 datetime (expected e.g. 2026-11-14T15:00:00).` };
  return { kind: "local", value: at.toFormat("yyyy-MM-dd'T'HH:mm:ss"), zone, at };
}

// `homeZone` is the user's own timezone (resolveUserTimezone), or null when it isn't known.
// With `requireStart` (creating an event) a missing end defaults to an hour after the start.
export function normalizeEventTimes(
  raw: RawEventTimes,
  homeZone: string | null,
  opts: { requireStart: boolean }
): NormalizedEventTimes | { error: string } {
  const startRaw = clean(raw.start);
  const endRaw = clean(raw.end);
  const startZone = clean(raw.startTimeZone);
  const endZone = clean(raw.endTimeZone) ?? startZone;

  if (!startRaw && opts.requireStart) return { error: "start is required: the date, or the date and time, of the event." };
  if (!startRaw && !endRaw) return {};

  const start = startRaw ? parsePoint("start", startRaw, startZone, homeZone) : null;
  if (start && "error" in start) return start;
  const end = endRaw ? parsePoint("end", endRaw, endZone, homeZone) : null;
  if (end && "error" in end) return end;

  // All-day: both ends are dates (or only the start was given).
  if (start?.kind === "date" || end?.kind === "date") {
    if ((start && start.kind !== "date") || (end && end.kind !== "date")) {
      return { error: "start and end must both be dates (an all-day event) or both be date-times, not one of each." };
    }
    const startDate = start?.kind === "date" ? start.date : null;
    const lastDay = end?.kind === "date" ? end.date : startDate;
    if (startDate && lastDay && lastDay < startDate) return { error: "end is before start." };
    return {
      allDay: true,
      ...(startDate ? { start: startDate.toFormat("yyyy-MM-dd") } : {}),
      // Inclusive last day in, exclusive end out.
      ...(lastDay && (end || opts.requireStart) ? { end: lastDay.plus({ days: 1 }).toFormat("yyyy-MM-dd") } : {}),
    } as NormalizedEventTimes;
  }

  const timed = (p: Point | null) => (p && p.kind !== "date" ? p : null);
  const s = timed(start);
  let e = timed(end);
  if (s && !e && opts.requireStart) {
    const at = s.at.plus({ minutes: DEFAULT_DURATION_MINUTES });
    e =
      s.kind === "local"
        ? { kind: "local", value: at.toFormat("yyyy-MM-dd'T'HH:mm:ss"), zone: s.zone, at }
        : { kind: "instant", value: at.toISO({ suppressMilliseconds: true }) ?? "", at };
  }
  if (s && e && e.at <= s.at) {
    return { error: `end (${e.value}) is not after start (${s.value}). Check the date and the am/pm, then call again.` };
  }
  return {
    ...(s ? { start: s.value, ...(s.kind === "local" ? { startTimeZone: s.zone } : {}) } : {}),
    ...(e ? { end: e.value, ...(e.kind === "local" ? { endTimeZone: e.zone } : {}) } : {}),
  } as NormalizedEventTimes;
}

// How a saved event reads on the user's own clock, handed back to the model so the time it
// confirms to the user is the time that was actually saved, not its own arithmetic.
export function describeEventTimeForUser(start: string, end: string, allDay: boolean | undefined, homeZone: string | null): string {
  if (allDay || DATE_ONLY.test(start)) {
    const first = DateTime.fromISO(start, { zone: "utc" });
    const last = DateTime.fromISO(end, { zone: "utc" }).minus({ days: 1 });
    if (!first.isValid) return "";
    return last.isValid && last > first
      ? `all day, ${first.toFormat("ccc d LLL yyyy")} to ${last.toFormat("ccc d LLL yyyy")}`
      : `all day, ${first.toFormat("ccc d LLL yyyy")}`;
  }
  const zone = homeZone ?? "utc";
  const s = DateTime.fromISO(start, { setZone: true }).setZone(zone);
  const e = DateTime.fromISO(end, { setZone: true }).setZone(zone);
  if (!s.isValid) return "";
  const endPart = e.isValid ? (e.hasSame(s, "day") ? `–${e.toFormat("HH:mm")}` : ` to ${e.toFormat("ccc d LLL yyyy, HH:mm")}`) : "";
  return `${s.toFormat("ccc d LLL yyyy, HH:mm")}${endPart} (${homeZone ?? "UTC"} time)`;
}
