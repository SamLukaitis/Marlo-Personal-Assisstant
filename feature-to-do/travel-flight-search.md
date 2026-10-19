# Flight search, travel requirements and baggage limits

Let Marlowe search and compare flights, check entry requirements (visas, passport rules) and tell
you the baggage allowance for a flight.

## What we found (probe, 2026-10-16)

`npm run travel:probe` in `server/` (script: `server/src/scripts/travelMcpProbe.ts`) tests public
travel MCP servers with no sign-in.

- **lastminute.com MCP** (`https://mcp.lastminute.com/mcp`): works with no account or key. A real
  London to Barcelona search returned airline, times, stops, price and a booking link. The airports
  must be 3-letter codes (`LON`, not `London`). Some results fly back from a different airport than
  the one you landed at (into BCN, home from Girona), and Marlowe must say so. It also offers
  flight + hotel packages and hotel-only search.
- **SlickTrip MCP** (`https://mcp.slicktrip.com/mcp`): connecting and listing tools works, but every
  tool call (even `find_places` and `recent_deals`) returns 401 "a SlickTrip login is required". It
  needs each user to sign in, so it's not usable from the server as-is.
- **Kiwi.com MCP** (`https://mcp.kiwi.com`, probed 2026-10-19): works with no account or key. Two
  tools: `search-flight` and `feedback-to-devs` (search only, no booking tool). A London to
  Barcelona return for 20–23 Nov returned 15 results in about 2 seconds, from £79: Ryanair, Wizz
  Air, easyJet and Vueling, each with flight numbers, times, stops, included bags and a kiwi.com
  booking link. It takes city names as well as airport codes, has filters for flexible dates (±10
  days), bags, stops, times and airlines, and can price in GBP. Things Marlowe would have to point
  out: cheapest results mix airlines on separate tickets (self-transfer) and fly home to a
  different London airport, and booking goes through Kiwi, not the airline. Kiwi earns from those
  bookings, so the search is free. No published terms for server use were found. Good candidate
  for a **backup** when SerpApi is unset or out of searches; check Kiwi's terms before relying on it.
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

## If we ever use the lastminute.com MCP

Read lastminute.com's terms for automated or commercial use of their MCP. The booking links carry
their affiliate tags.
