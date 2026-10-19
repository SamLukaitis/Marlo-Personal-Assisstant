Marlowe can now search live hotel prices and availability for a city and dates, from Google Hotels with lastminute.com as the backup.

## What changed

- New `search_hotels` tool in `server/src/ai/assistant.ts`, built the same way as
  `search_flights`: a pinned tool definition, trimmed results, a limit of 2 searches per user
  message, and a system-prompt rule. The rule tells Marlowe to say where the prices came from,
  whether a price is per night or for the whole stay and for how many people, and never to say
  it has booked or held a room.
- `server/src/providers/hotels.ts` calls SerpApi's `google_hotels` engine with the same
  `SERPAPI_API_KEY` as flights. Each hotel comes back with its price per night and for the whole
  stay, stars, guest rating (out of 5), any deal, up to 6 amenities, what up to 3 booking sites
  charge (and whether they offer free cancellation), and the hotel's website. The result ends with
  a Google Hotels link. Sponsored results are left out. It filters by maximum price per night,
  minimum stars and free cancellation, and sorts by relevance, lowest price or highest rating.
- `server/src/providers/lastminuteHotels.ts` is the backup when there's no key or a SerpApi search
  fails. It uses lastminute.com's public MCP server (`https://mcp.lastminute.com/mcp`), which
  needs no key: one call turns the city into lastminute's own id, and one searches. A live test on
  2026-10-19 took about 7 seconds. Its results don't include booking links (getting one takes two
  more calls per hotel), so each hotel gets a Booking.com search for that hotel with the dates
  filled in, and Marlowe says the price there may differ. Hostels and campsites are left out, and
  price and free-cancellation filters are applied by Marlowe because lastminute's own price filter
  isn't clearly per night. `LASTMINUTE_HOTELS=off` turns it off.
- `services/appLinks.ts`: the Booking.com link builder is now a shared `bookingComSearchUrl`.
- `npm run hotels:probe` in `server/` runs one real search on each source. It spends 2 SerpApi
  credits when a key is set.
- Tests never reach the network: `src/test/setup.ts` sets `LASTMINUTE_HOTELS=off`, and the
  provider tests use a mocked `fetch` and a fake MCP client.
- The Features page has a new "Flight and hotel prices" topic under Travel.

## Why

Before this, "find me a hotel in Lisbon 12–15 Nov under £150" only got Google Maps places
(ratings, no prices) and a Booking.com link, so Marlowe couldn't answer the budget part. Sam chose
SerpApi first with lastminute.com as the backup (2026-10-19), the same arrangement as flights, so
hotel search works even before a SerpApi key is set.

## Open questions

- Hotel and flight searches share SerpApi's 250 free searches a month. If testers use both a lot,
  the quota runs out and both fall back to their backups.
- lastminute.com's terms for automated use of its MCP server haven't been checked. See
  `feature-to-do/travel-flight-search.md`.
- The SerpApi field mapping has only been checked against SerpApi's documentation, because there
  was no key to test with. Run `npm run hotels:probe` once a key is set.
