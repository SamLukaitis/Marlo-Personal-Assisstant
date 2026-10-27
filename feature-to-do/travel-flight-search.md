# Flight and hotel search, travel requirements and baggage limits

Let Marlo search and compare flights and hotels, check entry requirements (visas, passport rules) and tell
you the baggage allowance for a flight.

## What we found (probe, 2026-10-16)

`npm run travel:probe` in `server/` (script: `server/src/scripts/travelMcpProbe.ts`) tests public
travel MCP servers with no sign-in.

- **lastminute.com MCP** (`https://mcp.lastminute.com/mcp`): works with no account or key. A real
  London to Barcelona search returned airline, times, stops, price and a booking link. The airports
  must be 3-letter codes (`LON`, not `London`). Some results fly back from a different airport than
  the one you landed at (into BCN, home from Girona), and Marlo must say so. It also offers
  flight + hotel packages and hotel-only search.
- **SlickTrip MCP** (`https://mcp.slicktrip.com/mcp`): connecting and listing tools works, but every
  tool call (even `find_places` and `recent_deals`) returns 401 "a SlickTrip login is required". It
  needs each user to sign in, so it's not usable from the server as-is.
- **Kiwi.com MCP** (`https://mcp.kiwi.com`, probed 2026-10-19): works with no account or key. Two
  tools: `search-flight` and `feedback-to-devs` (search only, no booking tool). A London to
  Barcelona return for 20–23 Nov returned 15 results in about 2 seconds, from £79: Ryanair, Wizz
  Air, easyJet and Vueling, each with flight numbers, times, stops, included bags and a kiwi.com
  booking link. It takes city names as well as airport codes, has filters for flexible dates (±10
  days), bags, stops, times and airlines, and can price in GBP. Things Marlo would have to point
  out: cheapest results mix airlines on separate tickets (self-transfer) and fly home to a
  different London airport, and booking goes through Kiwi, not the airline. Kiwi earns from those
  bookings, so the search is free. No published terms for server use were found. Built in as the
  backup on 2026-10-19 (`changelog/2026-10-19-kiwi-flight-backup.md`). Still to do: find or ask
  for Kiwi's terms for server use; `KIWI_FLIGHTS=off` turns it off if they rule it out.
- **Entry requirements and baggage:** neither lastminute.com nor SlickTrip covers these. They need another source (web
  search over official/airline pages, or an API like Sherpa).

## Done so far (2026-10-16)

Flight search is built on SerpApi's Google Flights engine, not an MCP (see
`changelog/2026-10-16-flight-search.md`). Still to do:

- **Baggage limits:** Duffel offers carry structured baggage allowances per fare; that's the
  best source if this becomes a common question. Booking through Duffel would also be possible.
- **Entry requirements:** for UK passport holders, the free GOV.UK Content API
  (`https://www.gov.uk/api/content/foreign-travel-advice/<country>`) has the Foreign Office's
  entry rules. For other passports, web search over government sites, or Sherpa (about $1,500 a
  month) if it's ever worth paying for.
- **Price alerts:** watch a route and message the user when the price drops. This would go through
  the attention gate (`services/attention.ts`).

## Hotel search (built 2026-10-19)

`search_hotels` uses SerpApi's Google Hotels engine, with lastminute.com's MCP
(`search_only_hotel`, after `resolve_destination_id`) as the no-key backup, the same arrangement as
flights. See `changelog/2026-10-19-hotel-search.md`. Still to do:

- Run `npm run hotels:probe` once `SERPAPI_API_KEY` is set, to check the Google Hotels field
  mapping against a real response (only checked against SerpApi's docs so far).
- lastminute.com booking links: the backup currently links to a Booking.com search for each hotel.
  lastminute's own link needs `select_hotel_options` then `generate_booking_link` per hotel, which
  would add two calls and more waiting.
- Flights and hotels share SerpApi's 250 free searches a month. Watch usage once testers start.

## lastminute.com terms

Now in use for the hotel backup. Read lastminute.com's terms for automated or commercial use of
their MCP before relying on it widely; `LASTMINUTE_HOTELS=off` turns it off without a code change.
Their booking links carry their affiliate tags (Marlo doesn't use them yet).
