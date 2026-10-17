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

function baseUrl(): string {
  return (process.env.SERVER_URL ?? "http://localhost:4000").replace(/\/+$/, "");
}

/** The feed itself. What calendar apps fetch. */
export function calendarFeedUrl(token: string): string {
  return `${baseUrl()}/joyce/calendar/${token}.ics`;
}

/**
 * The same feed as a webcal:// link: tapped on an iPhone or Mac, it opens the Calendar app and
 * asks "Subscribe?", with nothing to copy. Calendar apps fetch it over https.
 */
export function calendarWebcalUrl(token: string): string {
  return calendarFeedUrl(token).replace(/^https?:\/\//, "webcal://");
}

/**
 * What Joyce sends: a page that opens the Calendar app's subscribe prompt on Apple devices and
 * offers Google Calendar elsewhere. An https link because WhatsApp only makes http(s) tappable.
 */
export function calendarSubscribeUrl(token: string): string {
  return `${baseUrl()}/joyce/subscribe/${token}`;
}

// Joyce's colour for the family calendar, suggested to calendar apps through the feed. Apple
// Calendar may use it; anyone can change it in their calendar's settings.
const CALENDAR_COLOUR = "#D9577F";

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
    "X-WR-CALNAME:Family (Joyce)",
    "NAME:Family (Joyce)",
    `X-APPLE-CALENDAR-COLOR:${CALENDAR_COLOUR}`,
    `COLOR:palevioletred`,
    `X-WR-TIMEZONE:${zone}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
    ...listAllEvents(family).flatMap((e) => eventLines(e, uidPrefix, now)),
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

const escapeHtml = (v: string) =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The page behind calendarSubscribeUrl. On an iPhone, iPad or Mac it goes straight to the
 * Calendar app's subscribe prompt; everywhere it shows the same choices as buttons, since an
 * in-app browser may not follow the automatic hand-off. Self-contained: no scripts or styles
 * from anywhere else.
 */
export function buildSubscribePage(token: string): string {
  const webcal = escapeHtml(calendarWebcalUrl(token));
  const google = escapeHtml(
    `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(calendarWebcalUrl(token))}`
  );
  const feed = escapeHtml(calendarFeedUrl(token));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Family calendar</title>
<style>
  :root { --pink: ${CALENDAR_COLOUR}; --ink: #2b1d22; --soft: #fdf0f4; }
  body { margin: 0; font-family: -apple-system, system-ui, "Segoe UI", sans-serif; background: var(--soft); color: var(--ink); }
  main { max-width: 420px; margin: 0 auto; padding: 48px 20px; text-align: center; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  p { font-size: 15px; line-height: 1.45; margin: 0 0 24px; color: #5b4850; }
  a.button { display: block; padding: 14px 16px; margin: 0 0 12px; border-radius: 12px; font-size: 16px; font-weight: 600; text-decoration: none; }
  a.primary { background: var(--pink); color: #fff; }
  a.secondary { background: #fff; color: var(--ink); border: 1px solid #f0cfdb; }
  .tip { background: #fff; border: 1px solid #f0cfdb; border-radius: 12px; padding: 12px 14px; font-size: 14px; color: var(--ink); }
  small { display: block; margin-top: 28px; font-size: 12px; color: #8a7480; word-break: break-all; }
</style>
</head>
<body>
<main>
  <h1>Family calendar</h1>
  <p>Add it to your calendar. It updates by itself whenever someone tells Joyce about a date.</p>
  <a class="button primary" href="${webcal}">Add to iPhone or Mac Calendar</a>
  <a class="button secondary" href="${google}">Add to Google Calendar</a>
  <p class="tip" id="mac-tip" hidden>On a Mac: in the window that appears, set <strong>Auto-refresh</strong> to <strong>Every hour</strong>. Otherwise your Mac only checks for changes once a week.</p>
  <small>Anyone with this link can see the family calendar, so keep it in the family.<br><br>Calendar address: ${feed}</small>
</main>
<script>
  // A Mac starts every new subscription at a weekly refresh, ignoring the hourly one the feed asks
  // for, so Mac users are told to change it. An iPad can report itself as a Mac; touch tells them apart.
  var mac = /Macintosh/.test(navigator.userAgent) && !(navigator.maxTouchPoints > 1);
  if (mac) document.getElementById("mac-tip").hidden = false;
  if (/iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent)) location.href = ${JSON.stringify(calendarWebcalUrl(token))};
</script>
</body>
</html>`;
}
