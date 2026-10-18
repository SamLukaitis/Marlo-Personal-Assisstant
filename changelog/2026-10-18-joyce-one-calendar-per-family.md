Each Joyce family now has exactly one calendar: Google Calendar once anyone in the family connects it, otherwise Joyce's own, and the Joyce portal has a switch to turn Joyce's own calendar off for testing.

## Why

Two pieces of work landed at the same time. One gave Joyce a calendar of her own, which families
can subscribe to from their phones. The other let members connect their real Google Calendar.
Merged as they were, Joyce would have had two calendars and two near-identical sets of tools, so
she could easily add an event to one and look for it in the other. Families could also have seen
two "family calendars" on their phones.

The bigger point: most people already keep their plans in Google or Apple. A calendar Joyce keeps
on her own can't see any of that, so people would have to tell her every plan. Google Calendar
should be the real calendar wherever possible.

## What changed

- **One calendar per family, decided by a simple rule** (`server/src/joyce/calendarMode.ts`):
  - If anyone in the family has connected Google, the family's calendar is Google. Joyce reads
    and writes Google only.
  - If nobody has, Joyce keeps the calendar herself, as before.
  - If nobody has and the new Portal switch is off, the family has no calendar, and Joyce offers
    to connect Google instead.
- **Joyce is only ever given one calendar's tools.** The model never sees both sets, and if it
  tries to use the calendar that isn't in use, it's refused.
- **The subscribe link follows the same rule.** Once a family is on Google (or the switch is
  off), the link to Joyce's own calendar shows no events, so phones don't show stale events next
  to Google's. Nothing is deleted. Turning the switch back on, or everyone disconnecting Google,
  brings the events back.
- **Moving to Google is flagged.** When the first person in a family connects Google, the
  connect message says how many upcoming events Joyce has been keeping, and that they won't move
  across by themselves.
- **Clash checks on Google.** Joyce's own calendar already warned about clashes. Adding or moving
  a timed event on Google now does too, checking the family calendar and every connected member's
  own calendars.
- **New Portal switch:** Joyce portal, then Settings, then "Joyce's own calendar for families
  without Google". It's on by default, so nothing changes for families until someone turns it off.
  It applies to every family at once.

## Not done yet

See `feature-to-do/joyce-calendar-followups.md`: copying a family's existing events into Google
when they switch, removing a Google event when someone deletes the message it came from, and
Apple (iCloud) calendars.
