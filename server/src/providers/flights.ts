// Flight prices and availability from Google Flights, via SerpApi's google_flights engine (plain
// REST — there is no official Google Flights API). The assistant's own tool (search_flights in
// ai/assistant.ts) is a pinned definition that calls into here. Search only: nothing here books.
//
// Results are trimmed before they reach the model, for the same reason as providers/maps.ts: every
// tool result is re-sent at full input price on each later turn of the message's loop, and a raw
// SerpApi response carries logos, emissions, legroom and booking tokens the model doesn't need. If
// the upstream shape is ever unrecognised, a truncated raw payload is passed through instead.
//
// Quota: every uncached search spends one SerpApi credit. SerpApi serves an identical search from
// its own 1-hour cache for free, so nothing is cached here.
export const SERPAPI_URL = "https://serpapi.com/search.json";
const TIMEOUT_MS = 25_000;
export const MAX_FLIGHTS = 6;
const MAX_RAW_CHARS = 3000;

export type Cabin = "economy" | "premium_economy" | "business" | "first";
const CABIN_CODE: Record<Cabin, string> = { economy: "1", premium_economy: "2", business: "3", first: "4" };

export interface FlightSearchInput {
  // IATA airport codes, comma-separated for several ("LHR,LGW,STN"), or a Google kgmid ("/m/04jpl").
  from: string;
  to: string;
  departDate: string; // YYYY-MM-DD
  returnDate?: string; // YYYY-MM-DD; omit for one-way
  adults?: number;
  cabin?: Cabin;
  maxStops?: 0 | 1 | 2;
  currency?: string;
  // From an outbound option of an earlier round-trip search: fetches the return flights for it.
  returnFor?: string;
}

export interface FlightLeg {
  airline?: string;
  flightNumber?: string;
  from?: string;
  departs?: string;
  to?: string;
  arrives?: string;
  durationMinutes?: number;
  overnight?: boolean;
  oftenDelayed?: boolean;
}

export interface FlightOption {
  price?: number;
  best?: boolean;
  airlines: string[];
  stops: number;
  totalDurationMinutes?: number;
  legs: FlightLeg[];
  layovers?: { airport?: string; durationMinutes?: number; overnight?: boolean }[];
  notes?: string[];
  returnFor?: string;
  // Kiwi.com backup only (providers/kiwiFlights.ts): a round trip comes back whole, with its
  // return legs and a per-option booking link, instead of a returnFor follow-up search.
  returnLegs?: FlightLeg[];
  bookingUrl?: string;
}

export interface FlightSearchResult {
  // Set only on Kiwi.com backup results; absent means Google Flights.
  source?: string;
  roundTrip: boolean;
  currency: string;
  priceIs: string;
  flights: FlightOption[];
  priceInsights?: { lowest?: number; level?: string; typicalRange?: [number, number] };
  googleFlightsUrl?: string;
  message?: string;
  raw?: string;
}

export function isFlightsConfigured(): boolean {
  return Boolean(process.env.SERPAPI_API_KEY?.trim());
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function rawOf(result: unknown): string {
  const text = typeof result === "string" ? result : JSON.stringify(result);
  return text.slice(0, MAX_RAW_CHARS);
}

function trimLeg(l: Record<string, unknown>): FlightLeg {
  const dep = asRecord(l.departure_airport);
  const arr = asRecord(l.arrival_airport);
  const leg: FlightLeg = {};
  const airline = str(l.airline);
  if (airline) leg.airline = airline;
  const flightNumber = str(l.flight_number);
  if (flightNumber) leg.flightNumber = flightNumber;
  const from = str(dep?.id);
  if (from) leg.from = from;
  const departs = str(dep?.time);
  if (departs) leg.departs = departs;
  const to = str(arr?.id);
  if (to) leg.to = to;
  const arrives = str(arr?.time);
  if (arrives) leg.arrives = arrives;
  const duration = num(l.duration);
  if (duration !== undefined) leg.durationMinutes = duration;
  if (l.overnight === true) leg.overnight = true;
  if (l.often_delayed_by_over_30_min === true) leg.oftenDelayed = true;
  return leg;
}

function trimOption(o: Record<string, unknown>, best: boolean, roundTrip: boolean): FlightOption | null {
  const rawLegs = Array.isArray(o.flights) ? o.flights : [];
  const legs = rawLegs.map(asRecord).filter((l): l is Record<string, unknown> => l !== null).map(trimLeg);
  if (legs.length === 0) return null;
  const option: FlightOption = {
    airlines: [...new Set(legs.map((l) => l.airline).filter((a): a is string => Boolean(a)))],
    stops: legs.length - 1,
    legs,
  };
  const price = num(o.price);
  if (price !== undefined) option.price = price;
  if (best) option.best = true;
  const total = num(o.total_duration);
  if (total !== undefined) option.totalDurationMinutes = total;
  const layovers = (Array.isArray(o.layovers) ? o.layovers : [])
    .map(asRecord)
    .filter((l): l is Record<string, unknown> => l !== null)
    .map((l) => {
      const out: { airport?: string; durationMinutes?: number; overnight?: boolean } = {};
      const airport = str(l.id) ?? str(l.name);
      if (airport) out.airport = airport;
      const d = num(l.duration);
      if (d !== undefined) out.durationMinutes = d;
      if (l.overnight === true) out.overnight = true;
      return out;
    });
  if (layovers.length) option.layovers = layovers;
  // Itinerary-level notes are where Google puts fare/baggage caveats ("Checked baggage for a fee").
  const notes = (Array.isArray(o.extensions) ? o.extensions : []).filter((e): e is string => typeof e === "string");
  if (notes.length) option.notes = notes;
  const token = str(o.departure_token);
  if (roundTrip && token) option.returnFor = token;
  return option;
}

export async function searchFlights(input: FlightSearchInput): Promise<FlightSearchResult> {
  const roundTrip = Boolean(input.returnDate);
  const currency = (input.currency?.trim() || "GBP").toUpperCase();
  const params = new URLSearchParams({
    engine: "google_flights",
    api_key: process.env.SERPAPI_API_KEY?.trim() ?? "",
    departure_id: input.from.trim(),
    arrival_id: input.to.trim(),
    outbound_date: input.departDate,
    type: roundTrip ? "1" : "2",
    currency,
    hl: "en",
  });
  if (input.returnDate) params.set("return_date", input.returnDate);
  if (input.adults && input.adults > 1) params.set("adults", String(Math.min(9, Math.floor(input.adults))));
  if (input.cabin) params.set("travel_class", CABIN_CODE[input.cabin]);
  // SerpApi: 1 = nonstop only, 2 = one stop or fewer, 3 = two stops or fewer.
  if (input.maxStops !== undefined) params.set("stops", String(input.maxStops + 1));
  if (input.returnFor) params.set("departure_token", input.returnFor);

  const res = await fetch(`${SERPAPI_URL}?${params}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body: unknown = await res.json().catch(() => null);
  const rec = asRecord(body);
  const priceIs = roundTrip
    ? `round-trip total for ${input.adults ?? 1} adult(s), ${currency}`
    : `one-way for ${input.adults ?? 1} adult(s), ${currency}`;
  const base: FlightSearchResult = { roundTrip, currency, priceIs, flights: [] };
  const url = str(asRecord(rec?.search_metadata)?.google_flights_url);
  if (url) base.googleFlightsUrl = url;

  const error = str(rec?.error);
  if (error) {
    // "No results" comes back as an error string — a real answer, not a failure.
    if (/hasn't returned any results/i.test(error)) return { ...base, message: "No flights found for that search." };
    throw new Error(error);
  }
  if (!res.ok) throw new Error(`SerpApi returned HTTP ${res.status}`);
  if (!rec || (!Array.isArray(rec.best_flights) && !Array.isArray(rec.other_flights))) {
    return { ...base, raw: rawOf(body) };
  }

  const options = [
    ...(Array.isArray(rec.best_flights) ? rec.best_flights : []).map((o) => [o, true] as const),
    ...(Array.isArray(rec.other_flights) ? rec.other_flights : []).map((o) => [o, false] as const),
  ]
    .map(([o, best]) => {
      const r = asRecord(o);
      return r ? trimOption(r, best, roundTrip && !input.returnFor) : null;
    })
    .filter((o): o is FlightOption => o !== null);
  // Google's "best" picks first, then the cheapest of the rest, so a cheap outlier isn't cut off.
  const best = options.filter((o) => o.best);
  const rest = options.filter((o) => !o.best).sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
  const out: FlightSearchResult = { ...base, flights: [...best, ...rest].slice(0, MAX_FLIGHTS) };

  const insights = asRecord(rec.price_insights);
  if (insights) {
    const pi: NonNullable<FlightSearchResult["priceInsights"]> = {};
    const lowest = num(insights.lowest_price);
    if (lowest !== undefined) pi.lowest = lowest;
    const level = str(insights.price_level);
    if (level) pi.level = level;
    const range = insights.typical_price_range;
    if (Array.isArray(range) && range.length === 2 && range.every((n) => num(n) !== undefined)) {
      pi.typicalRange = [range[0] as number, range[1] as number];
    }
    if (Object.keys(pi).length) out.priceInsights = pi;
  }
  if (out.flights.length === 0) out.message = "No flights found for that search.";
  return out;
}
