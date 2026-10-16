// Manual live check against SerpApi's Google Flights engine — prints the raw upstream response
// and what providers/flights.ts trims it to, so the field mapping can be confirmed against reality.
// Not part of the test suite (needs a real key and spends 2-3 SerpApi credits).
//   SERPAPI_API_KEY=... npm run flights:probe
import "dotenv/config";
import { SERPAPI_URL, searchFlights } from "../providers/flights.js";

const key = process.env.SERPAPI_API_KEY?.trim();
if (!key) {
  console.error("Set SERPAPI_API_KEY first.");
  process.exit(1);
}

const daysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const depart = daysFromNow(21);
const back = daysFromNow(24);

const params = new URLSearchParams({
  engine: "google_flights",
  api_key: key,
  departure_id: "LHR,LGW,STN,LTN,LCY",
  arrival_id: "BCN",
  outbound_date: depart,
  return_date: back,
  currency: "GBP",
  hl: "en",
});
const raw = await (await fetch(`${SERPAPI_URL}?${params}`)).json();
console.log("raw (first 4000 chars):", JSON.stringify(raw, null, 2).slice(0, 4000));

const trimmed = await searchFlights({ from: "LHR,LGW,STN,LTN,LCY", to: "BCN", departDate: depart, returnDate: back });
console.log("trimmed round trip:", JSON.stringify(trimmed, null, 2));
console.log("trimmed size (chars):", JSON.stringify(trimmed).length, "vs raw:", JSON.stringify(raw).length);

const token = trimmed.flights.find((f) => f.returnFor)?.returnFor;
if (token) {
  const returns = await searchFlights({ from: "LHR,LGW,STN,LTN,LCY", to: "BCN", departDate: depart, returnDate: back, returnFor: token });
  console.log("trimmed returns:", JSON.stringify(returns, null, 2));
}
process.exit(0);
