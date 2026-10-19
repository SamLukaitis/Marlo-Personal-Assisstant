// Backup hotel search: lastminute.com's public MCP server (services/mcpClient.ts), used by
// search_hotels in ai/assistant.ts when SerpApi isn't configured or a SerpApi search fails.
// No key or account. Search only.
//
// Two calls per search: resolve_destination_id turns the city name into lastminute's own id, then
// search_only_hotel. Results are reshaped into the same HotelSearchResult as providers/hotels.ts,
// plus a `source` line saying they're from lastminute.com. lastminute's search returns no booking
// links (getting one takes two more calls per hotel, and a search already takes ~20 seconds), so
// each hotel gets a Booking.com search for it with the dates filled in instead — the model must
// say the price there may differ.
//
// Its price filter isn't clearly per night, so price and free cancellation are filtered here
// from a larger batch. Hostels and campsites are left out: this is a hotel search, and they fill
// the cheapest results otherwise. lastminute's terms for automated use haven't been checked;
// LASTMINUTE_HOTELS=off switches it off without a code change.
import { createMcpClient, type McpClient } from "../services/mcpClient.js";
import { bookingComSearchUrl } from "../services/appLinks.js";
import { MAX_HOTELS, adultsOf, nightsBetween, priceIsText, type HotelOption, type HotelSearchInput, type HotelSearchResult } from "./hotels.js";

export const LASTMINUTE_MCP_URL = "https://mcp.lastminute.com/mcp";
const TIMEOUT_MS = 45_000;
const MAX_RAW_CHARS = 3000;
const MAX_AMENITIES = 6;
// lastminute's maximum. Filtering happens here, so ask for as many as it gives.
const FETCH_RESULTS = 20;
// Every accommodation type except 4 (hostels) and 11 (campsites).
const ACCOMMODATION_TYPES = "1,2,3,5,6,7,8,9,10,12,13,14";
const SORT = { relevance: "recommended", lowest_price: "price", highest_rating: "review_score" } as const;
const SOURCE =
  "lastminute.com (backup: Google Hotels wasn't available). Prices are lastminute.com's and indicative until a room is picked; each bookingUrl is a Booking.com search for that hotel, where the price may differ.";

let client: McpClient | null = null;

export function isLastminuteHotelsEnabled(): boolean {
  return process.env.LASTMINUTE_HOTELS?.trim().toLowerCase() !== "off";
}

export function setLastminuteClientForTest(c: McpClient | null): void {
  client = c;
}

function getClient(): McpClient {
  if (!client) client = createMcpClient({ name: "lastminute", url: LASTMINUTE_MCP_URL, timeoutMs: TIMEOUT_MS });
  return client;
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

type Destination = { id: string; name: string } | { suggestions: string[] };

async function resolveOnce(cityName: string): Promise<Destination> {
  const rec = asRecord(await getClient().callTool("resolve_destination_id", { lang: "en", city_name: cityName }));
  const error = str(rec?.error);
  if (error) throw new Error(error);
  const id = str(rec?.id) ?? (num(rec?.id) !== undefined ? String(rec?.id) : undefined);
  if (rec?.success === true && id) return { id, name: str(rec.name) ?? cityName };
  const suggestions = records(rec?.suggestions)
    .map((s) => [str(s.name), str(s.country)].filter(Boolean).join(", "))
    .filter(Boolean)
    .slice(0, 5);
  return { suggestions };
}

// "Alfama, Lisbon" isn't a city lastminute knows, so the last part is tried before giving up.
async function resolveDestination(location: string): Promise<Destination> {
  const first = await resolveOnce(location);
  const parts = location.split(",").map((p) => p.trim()).filter(Boolean);
  if ("id" in first || parts.length < 2) return first;
  const city = await resolveOnce(parts[parts.length - 1]);
  return "id" in city || city.suggestions.length ? city : first;
}

function trimHotel(h: Record<string, unknown>, ctx: { city: string; nights: number; input: HotelSearchInput; adults: number }): HotelOption | null {
  const name = str(h.name);
  if (!name) return null;
  const option: HotelOption = { name };
  const stars = num(h.stars);
  if (stars !== undefined && stars > 0) option.stars = stars;
  // lastminute's score is out of 100.
  const rating = num(h.rating);
  if (rating !== undefined && rating > 0) {
    const reviews = num(h.reviews);
    option.rating = `${(rating / 10).toFixed(1)}/10${reviews !== undefined ? ` (${reviews} reviews)` : ""}`;
  }
  const total = num(h.price_total);
  if (total !== undefined) {
    option.totalPrice = total;
    if (ctx.nights > 0) option.pricePerNight = Math.round((total / ctx.nights) * 100) / 100;
  }
  if (typeof h.cancellable === "boolean") option.freeCancellation = h.cancellable;
  const amenities = (Array.isArray(h.facilities) ? h.facilities : []).filter((a): a is string => typeof a === "string");
  if (amenities.length) option.amenities = amenities.slice(0, MAX_AMENITIES);
  const distance = num(h.distance_km);
  if (distance !== undefined) option.distanceKmFromCentre = distance;
  option.bookingUrl = bookingComSearchUrl(`${name}, ${ctx.city}`, ctx.input.checkIn, ctx.input.checkOut, ctx.adults);
  return option;
}

export async function searchLastminuteHotels(input: HotelSearchInput): Promise<HotelSearchResult> {
  const adults = adultsOf(input);
  const nights = nightsBetween(input.checkIn, input.checkOut);
  const location = input.location.trim();
  const base: HotelSearchResult = {
    source: SOURCE,
    location,
    checkIn: input.checkIn,
    checkOut: input.checkOut,
    nights,
    adults,
    currency: "GBP",
    priceIs: priceIsText(nights, adults, "GBP"),
    hotels: [],
  };

  const dest = await resolveDestination(location);
  if (!("id" in dest)) {
    const hint = dest.suggestions.length ? ` Did they mean: ${dest.suggestions.join("; ")}?` : "";
    return { ...base, message: `lastminute.com didn't recognise "${location}" as a city.${hint}` };
  }

  const args: Record<string, unknown> = {
    destination: dest.id,
    date_from: input.checkIn,
    date_to: input.checkOut,
    adults: String(adults),
    lang: "en",
    sort: SORT[input.sort ?? "relevance"],
    max_results: FETCH_RESULTS,
    accommodation_type: ACCOMMODATION_TYPES,
  };
  if (input.minStars) args.hotel_stars = [1, 2, 3, 4, 5].filter((s) => s >= input.minStars!).join(",");

  const body = await getClient().callTool("search_only_hotel", args);
  const rec = asRecord(body);
  const error = str(rec?.error);
  if (error) throw new Error(error);
  if (!rec || !Array.isArray(rec.products_summary)) {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return { ...base, raw: text.slice(0, MAX_RAW_CHARS) };
  }

  const products = records(rec.products_summary);
  const currency = (str(products[0]?.currency) ?? str(asRecord(rec.price_range)?.currency) ?? "GBP").toUpperCase();
  // lastminute has no currency choice, so a budget in another currency can't be compared.
  const asked = input.currency?.trim().toUpperCase();
  const otherCurrency = Boolean(asked && asked !== currency);
  const max = input.maxPricePerNight && input.maxPricePerNight > 0 && !otherCurrency ? input.maxPricePerNight : undefined;
  const priceIs = `${priceIsText(nights, adults, currency)}${otherCurrency ? ` (lastminute.com can't price in ${asked}${input.maxPricePerNight ? ", so the budget wasn't applied" : ""})` : ""}`;
  const withCurrency = { ...base, location: dest.name, currency, priceIs };
  const hotels = products
    .map((h) => trimHotel(h, { city: dest.name, nights, input, adults }))
    .filter((o): o is HotelOption => o !== null)
    .filter((o) => !max || (o.pricePerNight !== undefined && o.pricePerNight <= max))
    .filter((o) => !input.freeCancellation || o.freeCancellation === true)
    .slice(0, MAX_HOTELS);
  return hotels.length ? { ...withCurrency, hotels } : { ...withCurrency, message: "No hotels found for that search." };
}
