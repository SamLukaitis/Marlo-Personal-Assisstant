// Google Maps Platform "Maps Grounding Lite" over MCP (services/mcpClient.ts). Two upstream tools
// are used: search_places (real place data + Google Maps links) and compute_routes
// (driving/walking distance and duration — no public transport). The assistant's own tools
// (find_places / get_route in ai/assistant.ts) are pinned definitions that call into here.
//
// Results are trimmed before they reach the model: every tool result is re-sent at full input
// price on each later turn of the same message's loop (feature-to-do/token-cost-reduction.md), and
// Places responses carry reviews/photos/hours arrays the model doesn't need. If the upstream
// shape is ever unrecognised, a truncated raw payload is passed through instead of an empty
// answer, so a Google-side format change degrades to "verbose" rather than "no results".
//
// Terms: Google requires its attribution to be shown with any grounded answer, and forbids
// caching Maps data — attribution and Maps links are always passed through, and nothing here is
// persisted.
import { createMcpClient, type McpClient } from "../services/mcpClient.js";

export const MAPS_MCP_URL = "https://mapstools.googleapis.com/mcp";
const EXPECTED_TOOLS = ["search_places", "compute_routes"];
const MAX_PLACES = 8;
const DEFAULT_RADIUS_METERS = 2000;
const MAX_RAW_CHARS = 3000;

export interface PlaceSummary {
  name?: string;
  address?: string;
  rating?: number;
  ratingCount?: number;
  openNow?: boolean;
  mapsUrl?: string;
  placeId?: string;
  summary?: string;
}

export interface PlacesResult {
  places: PlaceSummary[];
  summary?: string;
  attribution?: unknown;
  raw?: string;
}

export interface RouteResult {
  mode: "drive" | "walk";
  distanceMeters?: number;
  durationSeconds?: number;
  attribution?: unknown;
  raw?: string;
}

export type RoutePoint = string;

let client: McpClient | null = null;
let toolCheckDone = false;

export function isMapsConfigured(): boolean {
  return Boolean(process.env.GOOGLE_MAPS_API_KEY?.trim());
}

export function setMapsClientForTest(c: McpClient | null): void {
  client = c;
  toolCheckDone = false;
}

function getClient(): McpClient {
  if (!client) {
    client = createMcpClient({
      name: "google-maps",
      url: MAPS_MCP_URL,
      headers: { "X-Goog-Api-Key": process.env.GOOGLE_MAPS_API_KEY?.trim() ?? "" },
    });
  }
  if (!toolCheckDone) {
    toolCheckDone = true;
    // Fire-and-forget: surfaces an upstream rename in the admin portal's logs instead of as a
    // confusing tool error, without delaying the user's first answer.
    const c = client;
    void c
      .listToolNames()
      .then((names) => {
        const missing = EXPECTED_TOOLS.filter((t) => !names.includes(t));
        if (missing.length) console.warn(`maps: Grounding Lite no longer lists expected tool(s): ${missing.join(", ")}`);
      })
      .catch((err) => console.warn("maps: couldn't list Grounding Lite tools", err));
  }
  return client;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim()) return v;
  const rec = asRecord(v);
  return rec && typeof rec.text === "string" && rec.text.trim() ? rec.text : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function rawOf(result: unknown): string {
  const text = typeof result === "string" ? result : JSON.stringify(result);
  return text.slice(0, MAX_RAW_CHARS);
}

function trimPlace(p: Record<string, unknown>): PlaceSummary | null {
  const name = str(p.displayName) ?? str(p.name) ?? str(p.title);
  const hours = asRecord(p.currentOpeningHours) ?? asRecord(p.regularOpeningHours);
  const links = asRecord(p.googleMapsLinks);
  const place: PlaceSummary = {};
  if (name) place.name = name;
  const address = str(p.formattedAddress) ?? str(p.address) ?? str(p.shortFormattedAddress);
  if (address) place.address = address;
  const rating = num(p.rating);
  if (rating !== undefined) place.rating = rating;
  const ratingCount = num(p.userRatingCount);
  if (ratingCount !== undefined) place.ratingCount = ratingCount;
  if (typeof hours?.openNow === "boolean") place.openNow = hours.openNow;
  const mapsUrl = str(p.googleMapsUri) ?? str(links?.placeUri) ?? str(p.maps_uri) ?? str(p.mapsUri) ?? str(p.url);
  if (mapsUrl) place.mapsUrl = mapsUrl;
  const placeId = str(p.id) ?? str(p.place_id) ?? str(p.placeId);
  if (placeId) place.placeId = placeId;
  const summary = str(p.summary) ?? str(p.editorialSummary) ?? str(p.generativeSummary);
  if (summary) place.summary = summary;
  // A place with none of these is noise; one with only a link or id still carries the Maps
  // source the answer must cite (Grounding Lite may put names only in the top-level summary).
  return place.name || place.mapsUrl || place.placeId ? place : null;
}

export async function searchPlaces(input: {
  query: string;
  near?: { latitude: number; longitude: number };
  radiusMeters?: number;
}): Promise<PlacesResult> {
  const args: Record<string, unknown> = { text_query: input.query };
  if (input.near) {
    args.location_bias = {
      circle: {
        center: { latitude: input.near.latitude, longitude: input.near.longitude },
        radius_meters: input.radiusMeters ?? DEFAULT_RADIUS_METERS,
      },
    };
  }
  const result = await getClient().callTool("search_places", args);

  const rec = asRecord(result);
  if (!rec || !Array.isArray(rec.places)) {
    const fallback: PlacesResult = { places: [], raw: rawOf(result) };
    if (rec?.attribution !== undefined) fallback.attribution = rec.attribution;
    return fallback;
  }

  const places = rec.places
    .map((p) => asRecord(p))
    .filter((p): p is Record<string, unknown> => p !== null)
    .map(trimPlace)
    .filter((p): p is PlaceSummary => p !== null)
    .slice(0, MAX_PLACES);
  const out: PlacesResult = { places };
  const summary = str(rec.summary);
  if (summary) out.summary = summary;
  if (rec.attribution !== undefined) out.attribution = rec.attribution;
  // Places came back but trimming found no Maps link: the shape isn't what we map, so pass the
  // raw payload too rather than an answer with no sources.
  if (rec.places.length > 0 && !places.some((p) => p.mapsUrl)) out.raw = rawOf(result);
  return out;
}

const LAT_LNG = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;
// Google place IDs are opaque; in practice they start "ChIJ" / "Ei" / "Gh" and contain no spaces.
const PLACE_ID = /^(ChIJ|Ei|Gh)[A-Za-z0-9_-]{10,}$/;

function toWaypoint(point: RoutePoint): Record<string, unknown> {
  const m = LAT_LNG.exec(point);
  if (m) return { lat_lng: { latitude: Number(m[1]), longitude: Number(m[2]) } };
  if (PLACE_ID.test(point.trim())) return { place_id: point.trim() };
  return { address: point };
}

function parseDurationSeconds(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const m = /^(\d+(?:\.\d+)?)s$/.exec(v.trim());
    if (m) return Math.round(Number(m[1]));
  }
  return undefined;
}

export async function computeRoute(input: {
  origin: RoutePoint;
  destination: RoutePoint;
  mode: "drive" | "walk";
}): Promise<RouteResult> {
  const result = await getClient().callTool("compute_routes", {
    origin: toWaypoint(input.origin),
    destination: toWaypoint(input.destination),
    travel_mode: input.mode === "walk" ? "WALK" : "DRIVE",
  });

  const rec = asRecord(result);
  const first = rec && Array.isArray(rec.routes) ? asRecord(rec.routes[0]) : null;
  const distanceMeters = num(first?.distanceMeters);
  const durationSeconds = parseDurationSeconds(first?.duration);
  if (distanceMeters === undefined && durationSeconds === undefined) {
    const fallback: RouteResult = { mode: input.mode, raw: rawOf(result) };
    if (rec?.attribution !== undefined) fallback.attribution = rec.attribution;
    return fallback;
  }
  const out: RouteResult = { mode: input.mode };
  if (distanceMeters !== undefined) out.distanceMeters = distanceMeters;
  if (durationSeconds !== undefined) out.durationSeconds = durationSeconds;
  if (rec?.attribution !== undefined) out.attribution = rec.attribution;
  return out;
}
