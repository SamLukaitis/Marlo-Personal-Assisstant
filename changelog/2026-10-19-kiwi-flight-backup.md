Flight search now falls back to Kiwi.com when Google Flights (SerpApi) isn't set up or a search fails, so Marlowe can always look up flights.

## What changed

- New `server/src/providers/kiwiFlights.ts` calls Kiwi.com's public MCP server
  (`https://mcp.kiwi.com`), which needs no key or account. Its results are reshaped into the same
  format as the Google Flights ones, with a `source` line saying they're from Kiwi.com.
- `search_flights` in `server/src/ai/assistant.ts` tries Google Flights first when
  `SERPAPI_API_KEY` is set. If it isn't set, or the search fails (out of searches, bad key,
  SerpApi down), it searches Kiwi.com instead. If both fail, Marlowe gets one short error.
- Because Kiwi needs no key, the `search_flights` tool is now offered even with no SerpApi key.
  `KIWI_FLIGHTS=off` turns the backup off; with it off and no key, the tool isn't offered.
- Differences Marlowe is told to pass on with Kiwi results: a round trip comes back whole (return
  flights included, one kiwi.com booking link per option), there's no "price is low/high"
  insight, and booking is through Kiwi.com rather than the airline. Each option also says which
  bags the price includes, and flags a return to a different airport or out and back on different
  airlines.
- Kiwi's "self-transfer" itineraries (separate tickets joined by Kiwi, where a missed connection
  is the traveller's problem) are switched off, because they filled the cheapest results on long
  routes.
- `npm run travel:probe` now checks Kiwi too.
- Tests: `src/test/setup.ts` sets `KIWI_FLIGHTS=off`, so tests never reach the real Kiwi server.

## Why

SerpApi's free plan is 250 searches a month, and until a key is set in Railway there's no flight
search at all. A live test on 2026-10-19 showed Kiwi returns good results (London to Barcelona:
Ryanair, Wizz Air, easyJet, Vueling, from £79, in about 2 seconds).

## Open question

Kiwi publishes no terms for using its MCP server from a product. Check before relying on it
widely; see `feature-to-do/travel-flight-search.md`.
