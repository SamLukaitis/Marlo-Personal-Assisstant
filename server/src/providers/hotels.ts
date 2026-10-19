// Hotel prices and availability from Google Hotels, via SerpApi's google_hotels engine — the same
// SERPAPI_API_KEY and monthly search quota as providers/flights.ts. The assistant's own tool
// (search_hotels in ai/assistant.ts) is a pinned definition that calls into here, with
// providers/lastminuteHotels.ts as the backup. Search only: nothing here books.
//
// Results are trimmed before they reach the model, for the same reason as providers/flights.ts: a
// raw response carries images, GPS, nearby places and health-and-safety lists the model doesn't
// need, and every tool result is re-sent on each later turn of the message's loop. If the upstream
// shape is ever unrecognised (a query naming one hotel comes back as that hotel's detail page, not
// a list), a truncated raw payload is passed through instead.
import { SERPAPI_URL } from "./flights.js";

const TIMEOUT_MS = 25_000;
export const MAX_HOTELS = 6;
const MAX_AMENITIES = 6;
const MAX_SELLERS = 3;
const MAX_RAW_CHARS = 3000;

export type HotelSort = "relevance" | "lowest_price" | "highest_rating";
const SORT_CODE: Record<Exclude<HotelSort, "relevance">, string> = { lowest_price: "3", highest_rating: "8" };

export interface HotelSearchInput {
  // A city or area ("Lisbon", "Alfama, Lisbon").
  location: string;
  checkIn: string; // YYYY-MM-DD
  checkOut: string; // YYYY-MM-DD, after checkIn
  adults?: number;
  sort?: HotelSort;
  maxPricePerNight?: number;
  minStars?: 2 | 3 | 4 | 5;
  freeCancellation?: boolean;
  currency?: string;
}

export interface HotelOption {
  name: string;
  kind?: string;
  stars?: number;
  rating?: string;
  pricePerNight?: number;
  totalPrice?: number;
  freeCancellation?: boolean;
  deal?: string;
  amenities?: string[];
  distanceKmFromCentre?: number;
  // Google Hotels only: what each booking site charges per night, cheapest first as Google lists them.
  sellers?: { source: string; perNight?: number; freeCancellation?: boolean }[];
  website?: string;
  // lastminute.com backup only: a Booking.com search for this hotel with the dates filled in.
  bookingUrl?: string;
}

export interface HotelSearchResult {
  // Set only on lastminute.com backup results; absent means Google Hotels.
  source?: string;
  location: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  adults: number;
  currency: string;
  priceIs: string;
  hotels: HotelOption[];
  googleHotelsUrl?: string;
  message?: string;
  raw?: string;
}

export function isHotelsConfigured(): boolean {
  return Boolean(process.env.SERPAPI_API_KEY?.trim());
}

// Whole nights between two YYYY-MM-DD dates; 0 or less when the dates are missing or out of order.
export function nightsBetween(checkIn: string, checkOut: string): number {
  const ms = Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.round(ms / 86_400_000) : 0;
}

export function adultsOf(input: HotelSearchInput): number {
  return input.adults && input.adults >= 1 ? Math.min(9, Math.floor(input.adults)) : 2;
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

function records(v: unknown): Record<string, unknown>[] {
  return (Array.isArray(v) ? v : []).map(asRecord).filter((r): r is Record<string, unknown> => r !== null);
}

function lowest(rate: unknown): number | undefined {
  return num(asRecord(rate)?.extracted_lowest);
}

function trimProperty(p: Record<string, unknown>): HotelOption | null {
  const name = str(p.name);
  if (!name) return null;
  const option: HotelOption = { name };
  const kind = str(p.type);
  if (kind) option.kind = kind;
  // "4-star hotel" -> 4, when there's no extracted number.
  const stars = num(p.extracted_hotel_class) ?? Number(/(\d)-star/.exec(str(p.hotel_class) ?? "")?.[1] ?? NaN);
  if (Number.isFinite(stars) && stars > 0) option.stars = stars;
  const rating = num(p.overall_rating);
  if (rating !== undefined) {
    const reviews = num(p.reviews);
    option.rating = `${rating}/5${reviews !== undefined ? ` (${reviews} reviews)` : ""}`;
  }
  const perNight = lowest(p.rate_per_night);
  if (perNight !== undefined) option.pricePerNight = perNight;
  const total = lowest(p.total_rate);
  if (total !== undefined) option.totalPrice = total;
  const deal = str(p.deal_description) ?? str(p.deal);
  if (deal) option.deal = deal;
  const amenities = (Array.isArray(p.amenities) ? p.amenities : []).filter((a): a is string => typeof a === "string");
  if (amenities.length) option.amenities = amenities.slice(0, MAX_AMENITIES);
  const sellers = records(p.prices)
    .map((s) => {
      const source = str(s.source);
      if (!source) return null;
      const out: NonNullable<HotelOption["sellers"]>[number] = { source };
      const n = lowest(s.rate_per_night);
      if (n !== undefined) out.perNight = n;
      if (s.free_cancellation === true) out.freeCancellation = true;
      return out;
    })
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .slice(0, MAX_SELLERS);
  if (sellers.length) option.sellers = sellers;
  const website = str(p.link);
  if (website) option.website = website;
  return option;
}

export function priceIsText(nights: number, adults: number, currency: string): string {
  return `totalPrice is for all ${nights} night(s) for ${adults} adult(s) in one room; pricePerNight is the nightly rate; ${currency}`;
}

export async function searchHotels(input: HotelSearchInput): Promise<HotelSearchResult> {
  const currency = (input.currency?.trim() || "GBP").toUpperCase();
  const adults = adultsOf(input);
  const nights = nightsBetween(input.checkIn, input.checkOut);
  const params = new URLSearchParams({
    engine: "google_hotels",
    api_key: process.env.SERPAPI_API_KEY?.trim() ?? "",
    q: input.location.trim(),
    check_in_date: input.checkIn,
    check_out_date: input.checkOut,
    adults: String(adults),
    currency,
    gl: "uk",
    hl: "en",
  });
  if (input.sort && input.sort !== "relevance") params.set("sort_by", SORT_CODE[input.sort]);
  if (input.maxPricePerNight && input.maxPricePerNight > 0) params.set("max_price", String(Math.floor(input.maxPricePerNight)));
  if (input.minStars) params.set("hotel_class", [2, 3, 4, 5].filter((s) => s >= input.minStars!).join(","));
  if (input.freeCancellation) params.set("free_cancellation", "true");

  const res = await fetch(`${SERPAPI_URL}?${params}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body: unknown = await res.json().catch(() => null);
  const rec = asRecord(body);
  const base: HotelSearchResult = {
    location: input.location.trim(),
    checkIn: input.checkIn,
    checkOut: input.checkOut,
    nights,
    adults,
    currency,
    priceIs: `${priceIsText(nights, adults, currency)}, as Google Hotels shows them`,
    hotels: [],
  };
  const url = str(asRecord(rec?.search_metadata)?.google_hotels_url);
  if (url) base.googleHotelsUrl = url;

  const error = str(rec?.error);
  if (error) {
    // "No results" comes back as an error string — a real answer, not a failure.
    if (/hasn't returned any results/i.test(error)) return { ...base, message: "No hotels found for that search." };
    throw new Error(error);
  }
  if (!res.ok) throw new Error(`SerpApi returned HTTP ${res.status}`);
  if (!rec || !Array.isArray(rec.properties)) {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return { ...base, raw: text.slice(0, MAX_RAW_CHARS) };
  }

  // Sponsored `ads` are left out. Google's own order is kept, but places with no price for these
  // dates (usually sold out) go last.
  const options = records(rec.properties)
    .map(trimProperty)
    .filter((o): o is HotelOption => o !== null);
  const priced = options.filter((o) => o.pricePerNight !== undefined || o.totalPrice !== undefined);
  const unpriced = options.filter((o) => o.pricePerNight === undefined && o.totalPrice === undefined);
  const hotels = [...priced, ...unpriced].slice(0, MAX_HOTELS);
  return hotels.length ? { ...base, hotels } : { ...base, message: "No hotels found for that search." };
}
