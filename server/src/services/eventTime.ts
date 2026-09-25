// Calendar event start/end strings come in two shapes (see providers/types.ts's CalendarEvent):
// a zoned datetime ("2026-09-15T09:00:00Z", "2026-09-15T09:00:00+02:00") or, for an all-day
// event, a plain date ("2026-09-15"). JavaScript parses a plain date as UTC midnight, which is the
// previous evening anywhere west of UTC — so anything comparing, sorting, or bucketing events by
// day goes through these instead of new Date() or string comparison.
import { DateTime } from "luxon";

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

// Epoch ms; a plain date is local midnight (server-local, same convention as dateKey.ts).
export function eventTimeMs(value: string): number {
  const dateOnly = DATE_ONLY.exec(value);
  if (dateOnly) return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])).getTime();
  return value ? Date.parse(value) : NaN;
}

// The "YYYY-MM-DD" the event falls on — in `zone` (an IANA name, the user's own timezone) when
// given, else server-local, comparable with dateKey.ts's todayKey().
export function eventLocalDateKey(value: string, zone?: string | null): string {
  if (DATE_ONLY.test(value)) return value;
  const ms = eventTimeMs(value);
  if (!Number.isFinite(ms)) return "";
  if (zone) {
    const zoned = DateTime.fromMillis(ms, { zone });
    if (zoned.isValid) return zoned.toFormat("yyyy-MM-dd");
  }
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
