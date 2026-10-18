# Joyce calendar follow-ups

Left over from making each family use one calendar (`changelog/2026-10-18-joyce-one-calendar-per-family.md`).

## Copy existing events into Google when a family switches

When the first person in a family connects Google, any events Joyce was keeping herself stop
being used. The connect message warns about this, but nothing moves them. Joyce could offer to
copy upcoming events onto the family's Google calendar once one exists. This needs care so that a
second connection, or a reconnect, doesn't copy them twice.

## "Delete this" doesn't reach Google

Swipe-replying "delete this" removes the message and everything Joyce made from it
(`joyce/provenance.ts`). That covers events on her own calendar, but not events she added to
Google: there's no record linking a Google event to the message it came from. Fixing this means
recording the event ref against the message, then deleting it from Google as well.

## Apple (iCloud) calendars

Lots of families use Apple's calendar, and right now Joyce can't see it. Apple has no "Sign in
with Apple" access to calendars for other apps. The only way in is CalDAV with an app-specific
password that each person makes in their Apple ID settings and gives to Joyce. That works, but
it's fiddly, and it means holding a password for their whole iCloud account. Worth doing only if
testers ask for it. Until then:

- iPhone users whose calendar is really a Google account (common) can connect Google.
- Anyone else can subscribe to Joyce's own calendar (when the family isn't on Google).

## Families with some members on Google and some not

Once anyone connects Google, members who haven't connected have no calendar of their own that
Joyce can see. They can still see the shared Google family calendar if they have a Google account.
If testers without Google feel left out, one option is a subscribe link to the Google family
calendar itself (Google can publish a private iCal address for a calendar).
