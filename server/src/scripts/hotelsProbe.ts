// Manual live check of hotel search — prints what providers/hotels.ts (Google Hotels via SerpApi)
// and providers/lastminuteHotels.ts (the no-key backup) return for one real search, so the field
// mapping can be confirmed against reality. Not part of the test suite (hits real servers).
//   npm run hotels:probe                    — Lisbon, three nights from 3 weeks out
//   npm run hotels:probe -- "Alfama, Lisbon"
// With SERPAPI_API_KEY set it also prints the raw Google Hotels response and spends 2 SerpApi
// credits; without it, only the lastminute.com backup is checked.
import "dotenv/config";
import { SERPAPI_URL } from "../providers/flights.js";
import { isHotelsConfigured, searchHotels, type HotelSearchInput } from "../providers/hotels.js";
import { searchLastminuteHotels } from "../providers/lastminuteHotels.js";

const daysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const input: HotelSearchInput = { location: process.argv[2] ?? "Lisbon", checkIn: daysFromNow(21), checkOut: daysFromNow(24), adults: 2 };

async function timed<T>(label: string, fn: () => Promise<T>): Promise<void> {
  const start = Date.now();
  try {
    const result = await fn();
    console.log(`\n${label} (${((Date.now() - start) / 1000).toFixed(1)}s):`, JSON.stringify(result, null, 2));
    console.log("trimmed size (chars):", JSON.stringify(result).length);
  } catch (err) {
    console.log(`\n${label} failed after ${((Date.now() - start) / 1000).toFixed(1)}s: ${(err as Error).message}`);
  }
}

if (isHotelsConfigured()) {
  const params = new URLSearchParams({
    engine: "google_hotels",
    api_key: process.env.SERPAPI_API_KEY!.trim(),
    q: input.location,
    check_in_date: input.checkIn,
    check_out_date: input.checkOut,
    adults: "2",
    currency: "GBP",
    gl: "uk",
    hl: "en",
  });
  const raw = await (await fetch(`${SERPAPI_URL}?${params}`)).json();
  console.log("raw Google Hotels (first 4000 chars):", JSON.stringify(raw, null, 2).slice(0, 4000));
  console.log("raw size (chars):", JSON.stringify(raw).length);
  await timed("Google Hotels, cheapest 4-star and up", () => searchHotels({ ...input, sort: "lowest_price", minStars: 4 }));
} else {
  console.log("SERPAPI_API_KEY not set — skipping Google Hotels.");
}

await timed("lastminute.com backup", () => searchLastminuteHotels(input));
await timed("lastminute.com backup, cheapest under 150 a night with free cancellation", () =>
  searchLastminuteHotels({ ...input, sort: "lowest_price", maxPricePerNight: 150, freeCancellation: true })
);
process.exit(0);
