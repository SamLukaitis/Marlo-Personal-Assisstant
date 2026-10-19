Marlowe can now look up live flight prices and availability from Google Flights.

**What changed:** A new `search_flights` assistant tool (`server/src/providers/flights.ts`) calls
SerpApi's Google Flights engine. Ask "how much is London to Barcelona on the 20th?" or "is it
cheaper to fly Friday or Saturday?" and Marlowe returns the airlines, flight numbers, times, stops,
layovers and prices, Google's view of whether the price is low or high, and a Google Flights link
to book. For round trips it can then show return flights for the outbound the user picks. It points
out overnight legs, long layovers and flights that are often delayed.

**Why SerpApi and not an MCP server:** we probed the public travel MCPs first
(`npm run travel:probe`). lastminute.com works without sign-in but its terms for automated use are
unclear, and SlickTrip needs each user to log in. SerpApi has clear paid terms, covers every airline
Google Flights shows (including low-cost carriers), and is a plain REST call.

**Limits and cost:** off unless `SERPAPI_API_KEY` is set. At most 4 searches per user message, to
protect quota (the free plan is 250 searches a month). Search only: nothing is booked or held.
Baggage and visa questions still go through web search on the airline's or government's own site;
see `feature-to-do/travel-flight-search.md` for what's next.
