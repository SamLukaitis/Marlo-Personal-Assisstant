import crypto from "node:crypto";
import { DateTime } from "luxon";
import type { FamilyData } from "./familyDb.js";
import { getFamilyZone } from "./familyTime.js";
import { listAllEvents, type EventRow } from "./store.js";

// The family calendar as an iCalendar (.ics) feed, so members can subscribe to it from Google
// Calendar or their phone's calendar and see it alongside their own. Read-only: changes are made
// by telling Joyce. Served by joyce/routes.ts at /joyce/calendar/<secret>.ics.
//
// The secret in the link is the only thing that opens the feed, so anyone holding the link can
// see the calendar. Joyce says so when she hands it over, and a member can ask for a new link,
// which stops the old one working (registry.ts's issueCalendarToken).
//
// Subscribed calendars refresh on the calendar app's own schedule, not ours: Apple's is set per
// subscription (as often as every 5 minutes), Google's is every several hours and can't be
// changed. The refresh hints below are a request, not a guarantee.

export function calendarFeedUrl(token: string): string {
  const base = (process.env.SERVER_URL ?? "http://localhost:4000").replace(/\/+$/, "");
  return `${base}/joyce/calendar/${token}.ics`;
}

/** Escapes text for an iCalendar property value (RFC 5545 §3.3.11). */
function escapeText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Folds a content line at 75 octets, continuing with a leading space (RFC 5545 §3.1). */
function fold(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // Never split a multi-byte character: back up to the start of one.
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    parts.push(bytes.subarray(start, end).toString("utf8"));
    start = end;
    limit = 74; // continuation lines start with a space
  }
  return parts.join("\r\n ");
}

const utcStamp = (ms: number) => DateTime.fromMillis(ms, { zone: "utc" }).toFormat("yyyyLLdd'T'HHmmss'Z'");
const dateStamp = (date: string) => date.replace(/-/g, "");

function eventLines(event: EventRow, uidPrefix: string, now: number): string[] {
  const summary = event.aboutName ? `${event.aboutName}: ${event.title}` : event.title;
  const description = [event.notes, event.createdByName ? `Added by ${event.createdByName}` : null]
    .filter(Boolean)
    .join("\n");
  const lines = ["BEGIN:VEVENT", `UID:${uidPrefix}-${event.id}@joyce`, `DTSTAMP:${utcStamp(now)}`];
  if (event.allDay && event.startDate) {
    // DTEND for a date is exclusive, so the day after the last day.
    const lastDay = event.endDate ?? event.startDate;
    const after = DateTime.fromISO(lastDay).plus({ days: 1 }).toISODate()!;
    lines.push(`DTSTART;VALUE=DATE:${dateStamp(event.startDate)}`, `DTEND;VALUE=DATE:${dateStamp(after)}`);
  } else {
    lines.push(`DTSTART:${utcStamp(event.startsAt)}`, `DTEND:${utcStamp(event.endsAt)}`);
  }
  lines.push(`SUMMARY:${escapeText(summary)}`);
  if (description) lines.push(`DESCRIPTION:${escapeText(description)}`);
  lines.push("END:VEVENT");
  return lines;
}

export function buildCalendarFeed(family: FamilyData, now = Date.now()): string {
  const { zone } = getFamilyZone(family);
  // Stable per family so calendar apps match up events across refreshes, without putting the
  // family's internal id in a file that gets shared around.
  const uidPrefix = crypto.createHash("sha256").update(`ics:${family.familyId}`).digest("hex").slice(0, 16);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Joyce//Family calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Family calendar (Joyce)",
    `X-WR-TIMEZONE:${zone}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
    ...listAllEvents(family).flatMap((e) => eventLines(e, uidPrefix, now)),
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}
