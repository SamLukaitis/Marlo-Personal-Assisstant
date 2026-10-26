// Turns a person's calendar and known trips into the one thing Joyce may be told about a run of
// dates: which days clash. Event titles, times and places are read to decide and then dropped.
import { DateTime } from "luxon";
import type { CalendarEvent } from "../providers/types.js";
import { eventLocalDateKey, eventTimeMs } from "./eventTime.js";

export type DayAvailability =
  | { status: "free" }
  | { status: "busy" }
  | { status: "free_except"; busyDates: string[] };

/** Every YYYY-MM-DD from..to inclusive. */
export function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  for (let d = DateTime.fromISO(from, { zone: "utc" }); d.toISODate()! <= to; d = d.plus({ days: 1 })) {
    days.push(d.toISODate()!);
  }
  return days;
}

/** The days (in `zone`) an event touches. An all-day event's end date is exclusive. */
function eventDays(event: CalendarEvent, zone: string): string[] {
  const first = eventLocalDateKey(event.start, zone);
  if (!first) return [];
  if (event.allDay || /^\d{4}-\d{2}-\d{2}$/.test(event.end)) {
    const last = DateTime.fromISO(event.end, { zone: "utc" }).minus({ days: 1 }).toISODate();
    return last && last >= first ? daysBetween(first, last) : [first];
  }
  const endMs = eventTimeMs(event.end);
  // An event ending exactly at midnight doesn't touch the next day.
  const last = Number.isFinite(endMs) ? eventLocalDateKey(new Date(endMs - 1).toISOString(), zone) : first;
  return last >= first ? daysBetween(first, last) : [first];
}

export function computeAvailability(
  events: CalendarEvent[],
  trips: { startDate: string; endDate: string }[],
  from: string,
  to: string,
  zone: string
): DayAvailability {
  const range = daysBetween(from, to);
  const inRange = new Set(range);
  const busy = new Set<string>();
  for (const event of events) {
    for (const day of eventDays(event, zone)) if (inRange.has(day)) busy.add(day);
  }
  for (const trip of trips) {
    for (const day of daysBetween(trip.startDate, trip.endDate)) if (inRange.has(day)) busy.add(day);
  }
  if (busy.size === 0) return { status: "free" };
  if (busy.size === range.length) return { status: "busy" };
  return { status: "free_except", busyDates: range.filter((d) => busy.has(d)) };
}

/** The instants that bound from..to (inclusive dates) in `zone`, for reading the calendar. */
export function rangeInstants(from: string, to: string, zone: string): { start: Date; end: Date } {
  return {
    start: DateTime.fromISO(from, { zone }).startOf("day").toJSDate(),
    end: DateTime.fromISO(to, { zone }).plus({ days: 1 }).startOf("day").toJSDate(),
  };
}
