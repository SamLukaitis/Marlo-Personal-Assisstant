Joyce now keeps a shared family calendar (with a private subscribe link), sends reminders when they come due, and works in the family's own timezone.

**Timezones.** Joyce used to work only in UTC, so "remind me at 4pm" was an hour off in a UK
summer. Each family now has a timezone, guessed from the phone number of whoever started it and
changeable by telling Joyce ("we're in New York"). Only city zones are accepted, never "UTC" or
"GMT", after Marlowe once turned "the UK" into UTC. Joyce mentions which timezone she assumed
until someone confirms it.

**Reminders arrive on their own.** Before, a reminder reached someone only the next time they
messaged Joyce. Now she sends it when it's due: an ordinary message if they've been in touch in
the last 24 hours, otherwise the new `joyce_reminder` WhatsApp template ("Reminder: …"), which was
submitted to Meta on 2026-10-17 and needs approval before it can be used. Anyone she can't reach
gets it on their next message, as before. To do this Joyce now keeps each member's phone number,
encrypted in the family's own file; members who joined earlier have theirs saved the next time
they message.

**Family calendar.** Tell Joyce about appointments, trips, school dates or someone being away and
she puts them on the family calendar, saying if they clash with anything for the same person or
the whole family. Ask "what's on this week?" or "is anyone free Saturday?". Ask for the calendar
link to see it in Google Calendar or on a phone; anyone with the link can see it, and asking for a
new one stops the old one working.

Events can be for anyone named, not just members, so a child without a phone ("Leo's dentist")
works; clash checks match on the name.

**Fix found while testing with the real model:** Joyce's saved history kept only her replies, not
what she'd done, so on the next message she'd sometimes redo the previous request (Leo's dentist
added twice). Each reply in the history now carries a short "[Done: …]" note of the actions
behind it, never sent to anyone, and she's told to act only on the newest message. This affected
notes and reminders as well as the calendar.

**Each family member now has their own conversation with Joyce.** Before, she kept one history
for the whole family, so one person's "yes" could be taken as answering something she'd said to
someone else. Now she only sees her conversation with whoever she's replying to. What anyone tells
her is still available to the rest of the family through notes, the calendar and reminders, and a
new search over everything members have said to her ("has anyone mentioned Mum's birthday?").

Joyce's admin portal now has a light pink background.

Also: `npm run joyce:templates` shows or submits Joyce's WhatsApp templates. Use the account id
1574262347469069; 1576415707195454 refuses template creation. And the README now records that
Railway's staging environment deliberately has no WhatsApp settings.

Details: "Timezones, reminders and the calendar" in `feature-to-do/joyce-family-assistant.md`.
