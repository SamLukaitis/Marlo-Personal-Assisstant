# Trips and availability through the Marlowe–Joyce link — design

Status: built 2026-10-26 (see `changelog/2026-10-26-trips-and-availability.md`). The trip-flight pairing rule changed at implementation: an outbound leg and the next leg back make a flights-only trip (connections are one leg), rather than "flights close in time". Written from a brainstorm with Sam. Anything marked **(my call)**
was decided by the writer, not by Sam. Builds on `2026-10-19-marlowe-joyce-link-design.md` (the link,
the bridge, consent and the audit log already exist) and finishes items 1 and 2 of
`feature-to-do/marlowe-joyce-next-steps.md`.

## Intent

A family member can ask Joyce "when is Sam away?" or "do 14–21 Aug work for everyone?" and get a useful
answer, built from what each person's private Marlowe knows, while the person keeps tight control over
how little crosses. Sam's test for "too much": Joyce saying exactly where someone is, their itinerary,
anything to do with payments.

## Goals

1. Joyce can say **when a linked person is away** (a date range), and, only if that person allowed it,
   **which country**.
2. Joyce can say, for dates someone proposes, **who is free**: per person, free, busy, or "free except
   these days", never why.
3. The person decides, and can change their mind: trip sharing is ask each time / automatic / off, the
   country is a separate opt-in, and availability is on / off. Off takes effect at once.
4. Joyce keeps working exactly as today for people with no Marlowe, and Marlowe for people with no Joyce.
5. Joyce's isolation guarantees and the bridge's rules (no family or member id in any tool, Joyce imports
   nothing from Marlowe) are not weakened.

## Non-goals

- Shared expenses and forwarded group-chat messages (later projects).
- Any change to how Joyce encrypts or stores family data beyond one new table.
- Joyce asking "what is X doing on day Y?" There is no such question in the bridge.
- Telling the person when Joyce checked their availability (Sam: quietly answer, no note).
- Sharing trips from Marlowe users who haven't linked, or from numbers Marlowe has never heard from.

## Anti-goals (a failure even if it technically works)

- Joyce or the family seeing a city, hotel, address, flight number, booking reference, price, itinerary,
  or calendar entry title/time. Only: away dates, optional country, and per-day free/busy.
- Anything about payments or bookings beyond the dates of the trip.
- Joyce revealing that someone **declined** to share. "Not shared", "no Marlowe" and "availability off"
  are indistinguishable to the family.
- Joyce claiming "nobody is away" or "everyone is free" when she only knows what was shared.
- A trip shared, or an availability answer given, because an email, document or forwarded message said so.

## Constraints

- Same stack and rules as the link: TypeScript, Express, SQLite, WhatsApp; only `src/bridge/` imports
  both products; the bridge's allow-list test is updated for the new functions; no bridge function or
  tool takes a family or member id.
- Every proactive Marlowe message (the "share this trip?" ask) goes through `services/attention.ts`.
- Settings changes, the trip ask's answer, and unlinking happen only over WhatsApp from the person's own
  number, on a turn they started (the same rule as `send_to_family`).
- `deleteUserCompletely` must remove every new Marlowe-side table, with a test.
- Joyce's family file stays one encrypted file per family; the new table lives there.

## Decisions made with Sam

**What Joyce says about trips.** Dates, and the country only if allowed. "Sam's away 12–19 Nov
(Portugal)." or "Sam's away 12–19 Nov."

**Country is its own opt-in.** A person can share "away 12–19 Nov" without saying where.

**Ask flow.** With the setting on "ask each time" (the default), Marlowe messages the person straight away
when it spots a new trip, rather than waiting until someone asks Joyce.

**Availability.** Marlowe answers Joyce quietly from the person's calendar, with no message to the person.
For a proposed range, Joyce reports free days and the busy days: "free except the 16th". A person with one
meeting on the 16th is not "busy" for 14–21 Aug.

## Design

### Settings

`family_links` already has `trips_mode` (ask / auto / off) and `availability_on`. Add `trips_country`
(0/1, default 0, additive migration). The existing tools (`link_family`, `update_family_link`) gain a
`trips_country` property; their descriptions stop saying "not active yet". The offer text in
`bridge/index.ts` changes from "trip dates and destination" to "the dates you're away (and the country, if
you choose)".

### What counts as a trip (Marlowe side)

Marlowe already extracts `booking` entities (flights, hotels) from saved documents and connected email
(`services/documents.ts`, `entityValidation.ts`). There is no trip object. **(my call)** A trip is derived
from a person's future bookings: flights and hotel stays that are close enough in time form one trip,
whose range runs from the earliest start date to the latest end date (a hotel's check-out, or the last
flight's date). The builder chooses the grouping rule and writes it down. Only future trips are offered;
a trip is identified by a stable key so it is asked about once.

The country comes from the booking's destination (the arrival airport or the hotel's place). Only the
country name ever crosses; the city or hotel never does, and nothing is stored on Joyce's side beyond the
name. If the country can't be worked out confidently, the trip is shared without one. **(my call)**

### Marlowe → Joyce: sharing a trip

- **ask:** when a new trip is found, Marlowe sends one message through the attention gate: "I found a trip
  12–19 Nov. Share these dates with your family?" with choices *Share dates*, *Share dates and country*,
  *Don't share*. The answer is final for that trip unless the trip's dates change, in which case Marlowe
  asks again. **(my call)** The per-trip answer overrides the country setting for that trip.
- **auto:** a new trip is shared at once, with the country only if `trips_country` is on. Switching from
  ask to auto shares future trips that were never answered; trips the person declined stay declined.
  **(my call)**
- **off:** nothing is shared and nothing is asked.
- If a shared trip's dates change or the booking is cancelled, the shared row is updated or removed.
  **(my call)**

Marlowe records each trip's state in its own database (key, dates, asked / shared / declined, the Joyce
row id). Joyce's side stores only what the family may see.

### Joyce side

A new table in the family's own file, `member_trips`: member, start date, end date, country (nullable),
and a `source` of `marlowe`. Nothing else: no booking data, no Marlowe ids. Joyce gets a tool,
`who_is_away(from, to)`, returning each member whose shared trips overlap that range, with the dates and
country if present. Her reply wording follows the anti-goals: she reports what's shared, and for anyone
with nothing shared says she has nothing for them, in the same words for every reason.

Everyone in the family can see shared trips, as with everything in Joyce.

### Availability

Joyce gets a tool, `check_availability(from, to)`. Dates are in the family's time zone; the range is
capped (for example 31 days). For each family member, Joyce asks the bridge and receives only one of:

- `free`: no conflicts on any day in the range
- `free_except`: a list of dates (days, nothing finer)
- `busy`: every day in the range has a conflict
- `not_sure`

Joyce never imports the bridge. As with the join and leave hooks, Joyce exposes a resolver hook
(`joyce/hooks.ts`) that the bridge registers at server start; Joyce calls it with the member's phone and
the range. The bridge resolves the person's Marlowe owner from that phone, checks that they are linked
and have availability on, and answers. For anyone not linked, with availability off, with no calendar
connected, whose calendar fails to load in time, or for a range outside what can be answered, the answer
is `not_sure`. **(my call)**

How a day is judged **(my call)**: across all of the person's connected calendars, a day is a conflict
if any event overlaps it, timed or all-day, plus any day covered by a trip Marlowe knows about (whether
or not it was shared). Titles, times and places are read to decide and then dropped; only the dates of
conflicting days leave the bridge. No message is sent to the person and nothing about the answer is
stored on Joyce's side.

The calendar read may need a range-based call: `hubListEvents(ownerId, days)` looks forward from now. The
builder checks whether the provider calls support an arbitrary range and adds one if not.

### Switching off and leaving

- Trips set to **off**: the trips Marlowe shared are removed from Joyce at once (their rows are found
  through the audit log, `family_link_shares`, category `trip`).
- Country switched **off**: the country is cleared from every shared trip.
- Availability switched **off**: from then on every answer is `not_sure`.
- **Unlinking** or **leaving the family** removes all shared trips. This differs from notes (which stay
  with the family) because a trip is information about a person that should not outlive their link.
  **(my call)**
- Deleting a Marlowe account removes the link, settings, trip states and log.

### Audit log

The existing `family_link_shares` records each shared trip: category `trip`, a label of the dates only
(never the country, never booking details), and the Joyce row id. Availability answers are not logged.
**(my call)**

### Testing

- Nothing in `member_trips`, a bridge result, or a Joyce reply contains a city, hotel, flight number,
  reference, price, or event title; a test feeds a booking and calendar full of those and asserts none
  survive.
- Country appears only when allowed (per-trip answer in ask mode, `trips_country` in auto mode).
- Off means off: switching trips off removes shared rows; country off clears it; availability off gives
  `not_sure`.
- "Declined", "no Marlowe" and "availability off" produce identical output to Joyce.
- Free / free_except / busy / not_sure for ranges with no events, one event, all-day events, trips, no
  calendar connected, and calendar failure.
- The ask goes through the attention gate and is answered only on a user-started WhatsApp turn.
- Bridge allow-list test lists the new functions; no tool has a family or member id parameter;
  `src/joyce/` still imports nothing from Marlowe or the bridge.
- `deleteUserCompletely` leaves no trip rows.

### Docs to update when built

`README.md`, a `changelog/` entry, and `feature-to-do/marlowe-joyce-next-steps.md` (items 1 and 2 done).

## Calls added after the builder check (all my call)

- **A trip needs a known end.** A trip is a hotel stay (check-in to check-out), or two or more flights
  close in time (first flight to last flight). A lone one-way flight with no hotel is not a trip: it is
  not asked about, shared, or counted for availability. End dates are never null.
- **Joyce never gives a bare list.** She names everyone she has nothing for: "I don't have anything
  shared for Sam" for who-is-away, and "I'm not sure about Sam" for availability. The wording is the same
  whether the person has no Marlowe, has sharing off, declined, or had a calendar error. When nobody has
  shared, she says she has nothing for anyone, never "nobody is away".
- **Trip identity.** A trip is keyed by its earliest booking. Adding a booking to the same trip changes
  its dates, which asks again. Trips are derived whenever a booking entity is saved or changed.
- **Stale answers.** A reply to a trip ask applies only if the trip's dates are still the ones asked
  about; otherwise Marlowe asks again with the new dates. Several unanswered trips get one message each.
- **A reply to the ask counts as a user-started turn**, since the person sent it themselves.
- **One phone.** The availability hook uses the member's phone in Joyce. If it isn't the phone that
  consented to the link, the answer is `not_sure`.
- **Time zone.** "A day" is a day in the family's Joyce time zone (it already exists, `joyce/familyTime.ts`).
  The person's events are converted to it. Trip dates are used as the dates of the booking.
- **Existing links and in-progress trips.** Existing links keep working and silently get
  `trips_country` off, so nothing new is shared about where they are. A trip that has started but not
  ended counts as a current trip. Switching from off to auto shares future and in-progress trips.

## Left to the builder

The trip grouping rule, how a country is worked out from a booking, table and column names, the exact
wording of Marlowe's ask and Joyce's replies, how the ask's buttons and the person's answer reuse the
existing pending-action mechanism, the range cap and calendar timeout, and whether the calendar read is
extended or wrapped.
