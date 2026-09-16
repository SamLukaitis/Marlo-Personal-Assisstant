// Resolves "what timezone is this user in" for reminder time math (services/reminderTime.ts) —
// deterministically, with NO model involved anywhere in this chain. Three sources, in priority
// order:
//   1. An explicit timezone already on file (set via the Settings page's picker, or previously
//      resolved by #2/#3 below) — always wins once present.
//   2. The IANA zone for their most recent travel check-in's GPS coordinates (geo-tz: an offline,
//      exact geographic lookup, not a guess), if the travel feature is on and one exists.
//   3. Unknown — callers ask the user to share their WhatsApp location (chatDispatch.ts's
//      handleLocation resolves and stores it from that, via #4 below — same geo-tz lookup as #2).
//
// Earlier versions of this had a 4th source: asking the model to resolve a place name it read
// from the user's own phrasing into an IANA zone itself. That produced a real bug (a UK user's
// "10am" reminder firing an hour late) — the model had mapped "the UK" to "UTC" rather than
// "Europe/London", both of which are valid IANA zones, so nothing here could have caught it after
// the fact. The fix isn't a better prompt; it's removing the model from this decision entirely —
// see setUserTimezoneFromLocation, the only WhatsApp-side way to set this now.
import { find as findTimezonesForCoords } from "geo-tz";
import { IANAZone } from "luxon";
import { getSetting, setSetting, getEnabledTools, listCheckins } from "../db/store.js";

const TIMEZONE_SETTING_KEY = "timezone";

export function isValidIanaTimezone(value: string): boolean {
  return IANAZone.isValidZone(value.trim());
}

// geo-tz covers the entire globe (including open ocean, via nautical Etc/GMT+N zones) so a valid
// coordinate always resolves to something — the only way to get nothing back is an out-of-range
// or NaN input, which geo-tz throws on rather than returning empty. Coordinates here originate
// from WhatsApp's location-share payload (a system boundary), so that's worth guarding rather
// than trusting: caught and treated as unresolvable instead of crashing message handling.
function timezoneFromCoords(latitude: number, longitude: number): string | null {
  try {
    return findTimezonesForCoords(latitude, longitude)[0] ?? null;
  } catch {
    return null;
  }
}

export function getUserTimezone(ownerId: number): string | null {
  const explicit = getSetting(ownerId, TIMEZONE_SETTING_KEY);
  if (explicit) return explicit;

  if (!getEnabledTools(ownerId).has("travel")) return null;
  const lastCheckin = listCheckins(ownerId, 1)[0];
  if (!lastCheckin || lastCheckin.latitude == null || lastCheckin.longitude == null) return null;

  const resolved = timezoneFromCoords(lastCheckin.latitude, lastCheckin.longitude);
  if (!resolved) return null;

  // Cache it: a later relocation naturally overwrites this once a newer check-in exists and this
  // function runs again, since listCheckins(ownerId, 1) always returns the most recent one.
  setSetting(ownerId, TIMEZONE_SETTING_KEY, resolved);
  return resolved;
}

// The one WhatsApp-side way to set a timezone from chat: a real GPS coordinate the user shared
// via WhatsApp's own location-share feature (chatDispatch.ts's handleLocation calls this for
// every location message, unconditionally — no "travel" toggle gate, since this is core
// reminder-accuracy plumbing, not a travel feature). No model involved: geo-tz's lookup is a pure
// function of the coordinates, so the result is exactly as reliable as GPS itself.
export function setUserTimezoneFromLocation(ownerId: number, latitude: number, longitude: number): string | null {
  const resolved = timezoneFromCoords(latitude, longitude);
  if (resolved) setSetting(ownerId, TIMEZONE_SETTING_KEY, resolved);
  return resolved;
}

// Used by settingsRoutes.ts, where the value comes from a real <select> of IANA names the human
// picked directly — still deterministic, since nothing is inferring or guessing what the human
// meant. Not exposed to the model as a tool (see the file comment above for why).
export function setUserTimezone(ownerId: number, timezone: string): boolean {
  const trimmed = timezone.trim();
  if (!isValidIanaTimezone(trimmed)) return false;
  setSetting(ownerId, TIMEZONE_SETTING_KEY, trimmed);
  return true;
}
