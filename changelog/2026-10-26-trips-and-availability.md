A family can now ask Joyce when someone is away and whether dates work for everyone, with each person's Marlowe deciding how little to share.

## What changed

Until now the Marlowe–Joyce link only carried notes ("send this to Joyce"). Two more things now cross it.

- **Who is away.** Marlowe works out a person's trips from the flights and hotels it has saved for
  them (a hotel stay with the flights around it, or an outbound flight and the flight back; a lone
  one-way flight isn't a trip). By default it messages them when it spots one: "Share these dates with
  your family?", with buttons *Share dates*, *Dates + country* and *Don't share* (or they can reply in
  words). They can instead share every trip automatically or never. Joyce can then answer "when is
  Sam away?" with the dates, and the country only if the person allowed it. Never a city, hotel,
  itinerary, booking reference or price. If the dates change (a hotel is added), Marlowe asks again.
- **Country is its own switch.** `trips_country` (off by default, and off for everyone who linked
  before this) decides whether the country goes with the dates in automatic mode. In "ask" mode they
  choose per trip.
- **Availability.** Joyce can ask each member's Marlowe about proposed dates (up to 31 days) and gets
  back, per person, free, busy, free except certain days, or not sure. Marlowe answers quietly from
  the person's connected calendars (and the days of any trip it knows about, shared or not) and never
  tells the person Joyce asked. Event titles, times and places are never sent, only the dates of the
  days that clash.

## Privacy rules built in

- Joyce says the same thing whether someone has no Marlowe, has sharing off, declined, or Marlowe
  couldn't tell: "Nothing is shared for X" / "I'm not sure about X". She never says "nobody is away".
- Switching trips off removes every shared trip at once; switching the country off removes it from
  shared trips; availability off means "not sure". Unlinking or leaving the family always removes
  shared trips (notes still stay with the family, as before).
- Availability is "not sure" if the calendar couldn't be read, there's no calendar connected, or the
  number asking isn't the one that consented to the link.

## How it's built

- **Joyce:** a `member_trips` table in each family's own encrypted file (dates, optional country, no
  booking data); tools `who_is_away` and `check_availability` (`joyce/tripTools.ts`) that take dates
  only. Joyce still imports nothing from Marlowe: availability goes through a resolver hook
  (`joyce/hooks.ts`) the bridge registers at startup, and a new `onFamilyLeaving` hook fires just
  before someone's number stops reaching the family, so their trips can be removed.
- **Marlowe:** `services/tripDerivation.ts` (trips from `booking` entities, country from a small
  Haiku call that sees only the destination text), `services/availability.ts` (which days clash),
  `bridge/trips.ts` (sharing, asking, answering, removal), `hubListEventsBetween` for reading a date
  range of the calendar. New tables/columns in `app.db`: `family_trips` and `family_links.trips_country`;
  `deleteUserCompletely` clears `family_trips`. The scheduler's 5-minute tick looks for new trips.
- **Tools:** `answer_trip_question` (typed answer to the trip question) and a `trips_country` setting
  on `link_family` / `update_family_link`.
- The trip question is sent with `sendProactiveMessageWithButtons` directly, like the Joyce offer, not
  through `services/attention.ts`; it only goes to someone who linked and asked for it.

Design: `docs/superpowers/specs/2026-10-26-joyce-trips-and-availability-design.md`. One call the design
left open: a trip someone declined to share still counts as busy days for availability (shown as
"free except…" with no reason).

## Not built yet

Shared expenses and who-owes-who, forwarded group-chat messages, a reminder for people who ignore the
link offer. See `feature-to-do/marlowe-joyce-next-steps.md`.
