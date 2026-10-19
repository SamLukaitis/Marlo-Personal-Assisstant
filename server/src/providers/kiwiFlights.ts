// Backup flight search: Kiwi.com's public MCP server (services/mcpClient.ts), used by
// search_flights in ai/assistant.ts when SerpApi isn't configured or a SerpApi search fails.
// No key or account: Kiwi earns from bookings made through its links. Search only.
//
// Results are reshaped into the same FlightSearchResult as providers/flights.ts, so the model
// sees one format whichever source answered, plus a `source` line saying it's Kiwi.com.
// Differences from Google Flights the model must pass on: a round trip comes back whole (return
// legs and one booking link per option, no returnFor step), there are no price insights, and
// booking is on kiwi.com rather than with the airline.
//
// Self-transfer itineraries (separate tickets glued together by Kiwi, where a missed connection
// is the traveller's problem) are switched off: they top the cheapest results on long routes.
// Kiwi publishes no terms for server use; KIWI_FLIGHTS=off switches it off without a code change.
import { createMcpClient, type McpClient } from "../services/mcpClient.js";
import { MAX_FLIGHTS, type FlightLeg, type FlightOption, type FlightSearchInput, type FlightSearchResult } from "./flights.js";

export const KIWI_MCP_URL = "https://mcp.kiwi.com";
const TIMEOUT_MS = 30_000;
const MAX_RAW_CHARS = 3000;
const CABIN_CODE = { economy: "M", premium_economy: "W", business: "C", first: "F" } as const;
const SOURCE = "Kiwi.com (backup: Google Flights wasn't available). Book through each option's bookingUrl on kiwi.com.";

let client: McpClient | null = null;

export function isKiwiFlightsEnabled(): boolean {
  return process.env.KIWI_FLIGHTS?.trim().toLowerCase() !== "off";
}

export function setKiwiClientForTest(c: McpClient | null): void {
  client = c;
}

function getClient(): McpClient {
  if (!client) client = createMcpClient({ name: "kiwi", url: KIWI_MCP_URL, timeoutMs: TIMEOUT_MS });
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

// YYYY-MM-DD -> dd/mm/yyyy, Kiwi's date format.
function kiwiDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso.trim();
}

// Kiwi's local "2026-11-20T21:15:00" -> "2026-11-20 21:15", matching Google Flights' format.
function localTime(v: unknown): string | undefined {
  const s = str(v);
  return s ? s.replace("T", " ").slice(0, 16) : undefined;
}

function minutesBetween(from?: string, to?: string): number | undefined {
  if (!from || !to) return undefined;
  const ms = Date.parse(`${to.replace(" ", "T")}:00Z`) - Date.parse(`${from.replace(" ", "T")}:00Z`);
  return Number.isFinite(ms) ? Math.round(ms / 60_000) : undefined;
}

function trimLeg(seg: Record<string, unknown>): FlightLeg {
  const leg: FlightLeg = {};
  const airline = str(seg.carrierName) ?? str(seg.carrier);
  if (airline) leg.airline = airline;
  const flightNumber = str(seg.flightNumber);
  if (flightNumber) leg.flightNumber = flightNumber;
  const from = str(seg.from);
  if (from) leg.from = from;
  const departs = localTime(seg.departureTime);
  if (departs) leg.departs = departs;
  const to = str(seg.to);
  if (to) leg.to = to;
  const arrives = localTime(seg.arrivalTime);
  if (arrives) leg.arrives = arrives;
  const seconds = num(seg.durationSeconds);
  if (seconds !== undefined) leg.durationMinutes = Math.round(seconds / 60);
  if (departs && arrives && departs.slice(0, 10) !== arrives.slice(0, 10)) leg.overnight = true;
  return leg;
}

function layoversOf(legs: FlightLeg[]): NonNullable<FlightOption["layovers"]> {
  return legs.slice(0, -1).map((leg, i) => {
    const out: { airport?: string; durationMinutes?: number; overnight?: boolean } = {};
    if (leg.to) out.airport = leg.to;
    const next = legs[i + 1];
    const d = minutesBetween(leg.arrives, next.departs);
    if (d !== undefined) out.durationMinutes = d;
    if (leg.arrives && next.departs && leg.arrives.slice(0, 10) !== next.departs.slice(0, 10)) out.overnight = true;
    return out;
  });
}

function bagsNote(b: Record<string, unknown> | null): string | undefined {
  if (!b) return undefined;
  const count = (v: unknown, one: string, many: string) => {
    const n = num(v) ?? 0;
    return n === 0 ? `no ${one}` : n === 1 ? `1 ${one}` : `${n} ${many}`;
  };
  return `Price includes ${count(b.personalItem, "personal item", "personal items")}, ${count(b.cabinBag, "cabin bag", "cabin bags")}, ${count(b.checkedBag, "checked bag", "checked bags")}`;
}

function trimItinerary(it: Record<string, unknown>): FlightOption | null {
  const out = asRecord(it.outbound);
  const legs = records(out?.segments).map(trimLeg);
  if (legs.length === 0) return null;
  const inbound = asRecord(it.inbound);
  const returnLegs = records(inbound?.segments).map(trimLeg);
  const option: FlightOption = {
    airlines: [...new Set([...legs, ...returnLegs].map((l) => l.airline).filter((a): a is string => Boolean(a)))],
    stops: legs.length - 1,
    legs,
  };
  const price = num(it.price);
  if (price !== undefined) option.price = price;
  const outSeconds = num(out?.durationSeconds);
  if (outSeconds !== undefined) option.totalDurationMinutes = Math.round(outSeconds / 60);
  const layovers = layoversOf(legs);
  if (layovers.length) option.layovers = layovers;
  if (returnLegs.length) option.returnLegs = returnLegs;
  const bookingUrl = str(it.bookingUrl);
  if (bookingUrl) option.bookingUrl = bookingUrl;

  const notes: string[] = [];
  const bags = bagsNote(asRecord(it.baggage));
  if (bags) notes.push(bags);
  if (returnLegs.length) {
    const homeFrom = legs[0].from;
    const homeTo = returnLegs[returnLegs.length - 1].to;
    if (homeFrom && homeTo && homeFrom !== homeTo) notes.push(`Flies home to ${homeTo}, not ${homeFrom}`);
    const outAirlines = new Set(legs.map((l) => l.airline));
    if (!returnLegs.some((l) => outAirlines.has(l.airline))) notes.push("Out and back are on different airlines, as separate tickets");
    const returnLayovers = layoversOf(returnLegs);
    if (returnLayovers.length) notes.push(`Return has ${returnLayovers.length} stop(s): ${returnLayovers.map((l) => l.airport).join(", ")}`);
  }
  if (notes.length) option.notes = notes;
  return option;
}

export async function searchKiwiFlights(input: FlightSearchInput): Promise<FlightSearchResult> {
  const roundTrip = Boolean(input.returnDate);
  const currency = (input.currency?.trim() || "GBP").toUpperCase();
  const adults = input.adults && input.adults > 1 ? Math.min(9, Math.floor(input.adults)) : 1;
  const args: Record<string, unknown> = {
    flyFrom: input.from.trim(),
    flyTo: input.to.trim(),
    departureDate: kiwiDate(input.departDate),
    adults,
    currency,
    locale: "en",
    sort: "price",
    allow_self_transfer: false,
  };
  if (input.returnDate) args.returnDate = kiwiDate(input.returnDate);
  if (input.cabin) args.cabinClass = CABIN_CODE[input.cabin];
  if (input.maxStops !== undefined) args.max_sector_stopovers = input.maxStops;

  const body = await getClient().callTool("search-flight", args);
  const rec = asRecord(body);
  const priceIs = roundTrip
    ? `round-trip total for ${adults} adult(s), ${currency}, including return flights`
    : `one-way for ${adults} adult(s), ${currency}`;
  const base: FlightSearchResult = { source: SOURCE, roundTrip, currency, priceIs, flights: [] };

  const error = str(rec?.error);
  if (error) throw new Error(error);
  if (!rec || !Array.isArray(rec.itineraries)) {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return { ...base, raw: text.slice(0, MAX_RAW_CHARS) };
  }
  const flights = records(rec.itineraries)
    .map(trimItinerary)
    .filter((o): o is FlightOption => o !== null)
    .slice(0, MAX_FLIGHTS);
  return flights.length ? { ...base, flights } : { ...base, message: "No flights found for that search." };
}
