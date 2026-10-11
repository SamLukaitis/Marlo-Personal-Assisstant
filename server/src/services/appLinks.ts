// Hand-off links for apps that don't let us act for a user (Uber, OpenTable, Spotify, …): Marlowe
// builds a link that opens the app already filled in and the user confirms there. Pure — no I/O —
// so every URL format lives here and is pinned by appLinks.test.ts. Each builder starts from its
// own fixed host; model input only ever goes in through URLSearchParams/encodeURIComponent, so it
// can't redirect the link anywhere else. See docs/superpowers/specs/2026-10-12-app-handoff-links-design.md.

export type AppName = "uber" | "lyft" | "google_maps" | "opentable" | "resy" | "spotify" | "airbnb" | "booking_com";
export const APP_NAMES: readonly AppName[] = ["uber", "lyft", "google_maps", "opentable", "resy", "spotify", "airbnb", "booking_com"];

export type AppLinkResult = { url: string; label: string } | { error: string };

interface Place {
  name?: string;
  address?: string;
  latitude?: number;
  longitude?: number;
}

interface Ctx {
  today: string;
}

const MAX_TEXT = 200;
const TRAVEL_MODES: Record<string, string> = { drive: "driving", walk: "walking", transit: "transit", bike: "bicycling" };

class InputError extends Error {}

function text(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new InputError(`${field} must be text.`);
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
  return cleaned || undefined;
}

function requiredText(value: unknown, field: string): string {
  const t = text(value, field);
  if (!t) throw new InputError(`${field} is required for this app.`);
  return t;
}

function coordinate(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : NaN;
}

function place(value: unknown, field: string): Place | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object") throw new InputError(`${field} must be an object with name/address/latitude/longitude.`);
  const raw = value as Record<string, unknown>;
  const latitude = coordinate(raw.latitude);
  const longitude = coordinate(raw.longitude);
  if ((latitude === undefined) !== (longitude === undefined)) {
    throw new InputError(`${field} needs both latitude and longitude, or neither.`);
  }
  if (latitude !== undefined && longitude !== undefined) {
    if (Number.isNaN(latitude) || Number.isNaN(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
      throw new InputError(`${field} has invalid coordinates.`);
    }
  }
  const p: Place = { name: text(raw.name, `${field}.name`), address: text(raw.address, `${field}.address`), latitude, longitude };
  if (!p.name && !p.address && p.latitude === undefined) return undefined;
  return p;
}

// One URL path segment from model text. A segment of only dots ("." / "..", even percent-encoded)
// is resolved away by the URL parser, changing the path, so refuse it rather than encode it.
function pathSegment(value: string, field: string): string {
  if (/^\.+$/.test(value)) throw new InputError(`${field} must contain letters or numbers.`);
  return encodeURIComponent(value);
}

function hasCoords(p: Place): p is Place & { latitude: number; longitude: number } {
  return p.latitude !== undefined && p.longitude !== undefined;
}

function placeText(p: Place): string | undefined {
  return [p.name, p.address].filter(Boolean).join(", ") || undefined;
}

function requiredDestination(raw: Record<string, unknown>): Place {
  const p = place(raw.destination, "destination");
  if (!p) throw new InputError("destination is required (a name, address or coordinates).");
  return p;
}

function uber(raw: Record<string, unknown>): AppLinkResult {
  const origin = place(raw.origin, "origin");
  const dest = requiredDestination(raw);
  const u = new URL("https://m.uber.com/ul/");
  u.searchParams.set("action", "setPickup");
  if (!origin) {
    u.searchParams.set("pickup", "my_location");
  } else {
    setUberPlace(u, "pickup", origin);
  }
  setUberPlace(u, "dropoff", dest);
  return { url: u.toString(), label: "Open in Uber" };
}

function setUberPlace(u: URL, prefix: "pickup" | "dropoff", p: Place): void {
  if (hasCoords(p)) {
    u.searchParams.set(`${prefix}[latitude]`, String(p.latitude));
    u.searchParams.set(`${prefix}[longitude]`, String(p.longitude));
  }
  const nickname = p.name ?? p.address;
  const address = p.address ?? p.name;
  if (nickname) u.searchParams.set(`${prefix}[nickname]`, nickname);
  if (address) u.searchParams.set(`${prefix}[formatted_address]`, address);
}

function lyft(raw: Record<string, unknown>): AppLinkResult {
  const origin = place(raw.origin, "origin");
  const dest = requiredDestination(raw);
  if (!hasCoords(dest) || (origin && !hasCoords(origin))) {
    throw new InputError("Lyft links need coordinates for each place. Use uber or google_maps for a place you only have a name or address for.");
  }
  const u = new URL("https://lyft.com/ride");
  u.searchParams.set("id", "lyft");
  if (origin && hasCoords(origin)) {
    u.searchParams.set("pickup[latitude]", String(origin.latitude));
    u.searchParams.set("pickup[longitude]", String(origin.longitude));
  }
  u.searchParams.set("destination[latitude]", String(dest.latitude));
  u.searchParams.set("destination[longitude]", String(dest.longitude));
  return { url: u.toString(), label: "Open in Lyft" };
}

function mapsPoint(p: Place): string {
  return hasCoords(p) ? `${p.latitude},${p.longitude}` : (placeText(p) as string);
}

function googleMaps(raw: Record<string, unknown>): AppLinkResult {
  const origin = place(raw.origin, "origin");
  const dest = requiredDestination(raw);
  const mode = text(raw.travel_mode, "travel_mode");
  if (mode && !Object.hasOwn(TRAVEL_MODES, mode)) throw new InputError(`travel_mode must be one of: ${Object.keys(TRAVEL_MODES).join(", ")}.`);
  const u = new URL("https://www.google.com/maps/dir/");
  u.searchParams.set("api", "1");
  if (origin) u.searchParams.set("origin", mapsPoint(origin));
  u.searchParams.set("destination", mapsPoint(dest));
  if (mode) u.searchParams.set("travelmode", TRAVEL_MODES[mode]);
  return { url: u.toString(), label: "Open in Google Maps" };
}

function spotify(raw: Record<string, unknown>): AppLinkResult {
  const query = requiredText(raw.query, "query");
  return { url: `https://open.spotify.com/search/${pathSegment(query, "query")}`, label: "Open in Spotify" };
}

// Task 2 adds opentable, resy, airbnb and booking_com to this table.
const BUILDERS: Partial<Record<AppName, (raw: Record<string, unknown>, ctx: Ctx) => AppLinkResult>> = {
  uber,
  lyft,
  google_maps: googleMaps,
  spotify,
};

export function makeAppLink(raw: Record<string, unknown>, ctx: Ctx): AppLinkResult {
  const app = raw.app as AppName;
  const build = APP_NAMES.includes(app) ? BUILDERS[app] : undefined;
  if (!build) return { error: `app must be one of: ${APP_NAMES.join(", ")}.` };
  try {
    return build(raw, ctx);
  } catch (e) {
    if (e instanceof InputError) return { error: e.message };
    throw e;
  }
}
