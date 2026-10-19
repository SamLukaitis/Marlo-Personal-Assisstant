// Hand-off links for apps that don't let us act for a user (Uber, OpenTable, Spotify, …): Marlowe
// builds a link that opens the app already filled in and the user confirms there. Pure — no I/O —
// so every URL format lives here and is pinned by appLinks.test.ts. Each builder starts from its
// own fixed host; model input only ever goes in through URLSearchParams/encodeURIComponent, so it
// can't redirect the link anywhere else. See docs/superpowers/specs/2026-10-12-app-handoff-links-design.md.
import { DateTime } from "luxon";

export type AppName = "uber" | "lyft" | "google_maps" | "opentable" | "resy" | "spotify" | "airbnb" | "booking_com" | "whatsapp";
export const APP_NAMES: readonly AppName[] = ["uber", "lyft", "google_maps", "opentable", "resy", "spotify", "airbnb", "booking_com", "whatsapp"];

export type AppLinkResult = { url: string; label: string } | { error: string };

interface Place {
  name?: string;
  address?: string;
  latitude?: number;
  longitude?: number;
}

interface Ctx {
  today: string; // the user's local date, YYYY-MM-DD
  now: string; // the user's local time, HH:MM
}

const MAX_TEXT = 200;
const TRAVEL_MODES: Record<string, string> = { drive: "driving", walk: "walking", transit: "transit", bike: "bicycling" };

export class InputError extends Error {}

function text(value: unknown, field: string, max: number = MAX_TEXT): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new InputError(`${field} must be text.`);
  const collapsed = value
    // Invisible formatting (bidi overrides/isolates, LRM/RLM, zero-width chars) is dropped outright...
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
    // ...while control characters and line/paragraph separators become word breaks.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Cut by code point, not UTF-16 unit: a half emoji makes encodeURIComponent throw.
  const cleaned = Array.from(collapsed).slice(0, max).join("").trimEnd();
  return cleaned || undefined;
}

// Shared with phoneSteps.ts so model text reaching the phone is cleaned exactly like link text.
export { text as cleanText };

function requiredText(value: unknown, field: string): string {
  const t = text(value, field);
  if (!t) throw new InputError(`${field} is required for this app.`);
  return t;
}

function coordinate(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    // Number("") is 0, and Number() also takes hex/exponents — only plain decimals count.
    const s = value.trim();
    if (!s) return undefined;
    return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
  }
  return typeof value === "number" && Number.isFinite(value) ? value : NaN;
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

function count(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 20) {
    throw new InputError(`${field} must be a whole number from 1 to 20.`);
  }
  return n;
}

function date(value: unknown, field: string, ctx: Ctx): string | undefined {
  const t = text(value, field);
  if (!t) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t) || !DateTime.fromISO(t).isValid) throw new InputError(`${field} must be a date as YYYY-MM-DD.`);
  if (t < ctx.today) throw new InputError(`${field} is in the past (today is ${ctx.today}).`);
  return t;
}

function time(value: unknown): string | undefined {
  const t = text(value, "time");
  if (!t) return undefined;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new InputError("time must be 24-hour HH:MM, e.g. 20:00.");
  return t;
}

function stay(raw: Record<string, unknown>, ctx: Ctx): { city: string; checkIn?: string; checkOut?: string; guests?: number } {
  const city = requiredText(raw.city, "city");
  const checkIn = date(raw.check_in, "check_in", ctx);
  const checkOut = date(raw.check_out, "check_out", ctx);
  if ((checkIn === undefined) !== (checkOut === undefined)) throw new InputError("Give both check_in and check_out, or neither.");
  if (checkIn && checkOut && checkOut <= checkIn) throw new InputError("check_out must be after check_in.");
  return { city, checkIn, checkOut, guests: count(raw.guests, "guests") };
}

function opentable(raw: Record<string, unknown>, ctx: Ctx): AppLinkResult {
  const query = requiredText(raw.query, "query");
  const partySize = count(raw.party_size, "party_size");
  const d = date(raw.date, "date", ctx);
  const t = time(raw.time);
  if (t && !d) throw new InputError("Give a date with the time.");
  const u = new URL("https://www.opentable.com/s");
  u.searchParams.set("term", query);
  if (partySize) u.searchParams.set("covers", String(partySize));
  if (d) {
    const slot = t ?? "19:00";
    if (d === ctx.today && slot < ctx.now) {
      throw new InputError(`${slot} has already passed today (it's ${ctx.now} for the user now). Ask for a later time.`);
    }
    u.searchParams.set("dateTime", `${d}T${slot}`);
  }
  return { url: u.toString(), label: "Open in OpenTable" };
}

function resy(raw: Record<string, unknown>, ctx: Ctx): AppLinkResult {
  const city = requiredText(raw.city, "city");
  const slug = city.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) throw new InputError("city must contain letters, e.g. 'New York, NY'.");
  const query = text(raw.query, "query");
  const seats = count(raw.party_size, "party_size");
  const d = date(raw.date, "date", ctx);
  const u = new URL(`https://resy.com/cities/${slug}`);
  if (d) u.searchParams.set("date", d);
  if (seats) u.searchParams.set("seats", String(seats));
  if (query) u.searchParams.set("query", query);
  return { url: u.toString(), label: "Open in Resy" };
}

function airbnb(raw: Record<string, unknown>, ctx: Ctx): AppLinkResult {
  const s = stay(raw, ctx);
  const u = new URL(`https://www.airbnb.com/s/${pathSegment(s.city, "city")}/homes`);
  if (s.checkIn && s.checkOut) {
    u.searchParams.set("checkin", s.checkIn);
    u.searchParams.set("checkout", s.checkOut);
  }
  if (s.guests) u.searchParams.set("adults", String(s.guests));
  return { url: u.toString(), label: "Open in Airbnb" };
}

// Also used by providers/lastminuteHotels.ts, with a hotel's name and city as `search`.
export function bookingComSearchUrl(search: string, checkIn?: string, checkOut?: string, guests?: number): string {
  const u = new URL("https://www.booking.com/searchresults.html");
  u.searchParams.set("ss", search);
  if (checkIn && checkOut) {
    u.searchParams.set("checkin", checkIn);
    u.searchParams.set("checkout", checkOut);
  }
  if (guests) u.searchParams.set("group_adults", String(guests));
  u.searchParams.set("no_rooms", "1");
  return u.toString();
}

function bookingCom(raw: Record<string, unknown>, ctx: Ctx): AppLinkResult {
  const s = stay(raw, ctx);
  return { url: bookingComSearchUrl(s.city, s.checkIn, s.checkOut, s.guests), label: "Open in Booking.com" };
}

// A WhatsApp chat with the message already typed: the user only taps Send. With no number it opens
// WhatsApp's contact picker instead. wa.me needs the full international number, so a local one
// ("07700…") is refused rather than guessed into a country.
function whatsapp(raw: Record<string, unknown>): AppLinkResult {
  const message = text(raw.message, "message", 1000);
  if (!message) throw new InputError("message is required for this app.");
  const phoneText = text(raw.phone, "phone");
  let path = "";
  if (phoneText) {
    const compact = phoneText.replace(/[\s().-]/g, "");
    if (!/^(\+|00)?\d+$/.test(compact)) throw new InputError("phone must be a phone number (digits, optionally starting with +).");
    if (!/^(\+|00)/.test(compact)) {
      throw new InputError("phone must be the full international number (e.g. +44 7700 900123), not a local one.");
    }
    const digits = compact.replace(/^(\+|00)/, "");
    if (digits.length < 7 || digits.length > 15) throw new InputError("phone must be 7 to 15 digits.");
    path = digits;
  }
  return { url: `https://wa.me/${path}?text=${encodeURIComponent(message)}`, label: "Open in WhatsApp" };
}

const BUILDERS: Record<AppName, (raw: Record<string, unknown>, ctx: Ctx) => AppLinkResult> = {
  uber,
  lyft,
  google_maps: googleMaps,
  opentable,
  resy,
  spotify,
  airbnb,
  booking_com: bookingCom,
  whatsapp,
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
