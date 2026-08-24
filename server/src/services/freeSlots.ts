import type { CalendarEvent } from "../providers/types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

export interface FreeSlot {
  start: string; // ISO
  end: string; // ISO
}

export interface FindFreeSlotsOptions {
  days?: number; // how many days ahead to search, default 7
  durationMinutes?: number; // minimum gap length to report, default 30
  earliestHour?: number; // start of the working-hours window, default 9 (24h, local machine time)
  latestHour?: number; // end of the working-hours window, default 18
  now?: number; // epoch ms "today" anchor - injectable for tests, defaults to Date.now()
}

interface Interval {
  start: number;
  end: number;
}

function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: Interval[] = [sorted[0]];
  for (const current of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (current.start <= last.end) {
      last.end = Math.max(last.end, current.end);
    } else {
      merged.push({ ...current });
    }
  }
  return merged;
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Deterministically finds gaps of at least `durationMinutes` in the user's calendar over the
 * next `days` days, restricted to a working-hours window each day. All arithmetic is plain date
 * math - no model involved, since a candidate meeting slot needs to be exactly right, the same
 * "hardcode the math" principle travelDays.ts applies to day counting.
 */
export function findFreeSlots(events: CalendarEvent[], opts: FindFreeSlotsOptions = {}): FreeSlot[] {
  const days = opts.days ?? 7;
  const durationMs = (opts.durationMinutes ?? 30) * MINUTE_MS;
  const earliestHour = opts.earliestHour ?? 9;
  const latestHour = opts.latestHour ?? 18;
  const now = opts.now ?? Date.now();

  const busy = mergeIntervals(
    events
      .map((e) => ({ start: new Date(e.start).getTime(), end: new Date(e.end).getTime() }))
      .filter((i) => Number.isFinite(i.start) && Number.isFinite(i.end) && i.end > i.start)
  );

  const slots: FreeSlot[] = [];
  const todayStart = startOfDay(now);

  for (let d = 0; d < days; d++) {
    const dayStart = todayStart + d * DAY_MS;
    const windowStart = Math.max(dayStart + earliestHour * HOUR_MS, now);
    const windowEnd = dayStart + latestHour * HOUR_MS;
    if (windowEnd <= windowStart) continue;

    let cursor = windowStart;
    for (const b of busy) {
      if (b.end <= cursor || b.start >= windowEnd) continue;
      if (b.start > cursor && b.start - cursor >= durationMs) {
        slots.push({ start: new Date(cursor).toISOString(), end: new Date(b.start).toISOString() });
      }
      cursor = Math.max(cursor, b.end);
    }
    if (windowEnd - cursor >= durationMs) {
      slots.push({ start: new Date(cursor).toISOString(), end: new Date(windowEnd).toISOString() });
    }
  }

  return slots;
}
