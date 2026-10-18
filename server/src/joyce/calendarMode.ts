import type { FamilyData } from "./familyDb.js";
import { isBuiltInCalendarEnabled } from "./adminRecords.js";
import { hasGoogleAccounts } from "./store.js";

// Which calendar a family uses. Each family has exactly one at a time, so Joyce never has two to
// choose between and members never see two "family calendars" side by side:
//  - "google": someone in the family has connected Google Calendar. Joyce reads and writes Google
//    only (calendarTools.ts). Her own calendar isn't offered, even if it still has old events,
//    and its subscribe feed goes empty.
//  - "built_in": nobody has connected Google, and an admin hasn't turned the built-in calendar off
//    in the Joyce portal. Joyce keeps the calendar herself (store.ts's events, calendarFeed.ts).
//  - "none": nobody has connected Google and the built-in calendar is off. Joyce can only offer
//    to connect Google.
// Nothing is deleted on a change of mode: turning the built-in calendar back on, or everyone
// disconnecting Google, brings the built-in events back.

export type CalendarMode = "google" | "built_in" | "none";

export function calendarMode(family: FamilyData): CalendarMode {
  if (hasGoogleAccounts(family)) return "google";
  return isBuiltInCalendarEnabled() ? "built_in" : "none";
}
