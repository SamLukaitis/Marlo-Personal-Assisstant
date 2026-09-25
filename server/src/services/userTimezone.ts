// Resolves "what timezone is this user in" for reminder time math (services/reminderTime.ts) —
// deterministically, with NO model involved anywhere in this chain. Sources, in priority order:
//   1. A zone picked in the Settings page — a deliberate choice, always wins.
//   2. The more recent of: a location the user shared on WhatsApp (chatDispatch.ts's handleLocation
//      stores it, see setUserTimezoneFromLocation) and their latest travel check-in's GPS point
//      (geo-tz: an offline, exact geographic lookup, not a guess), if the travel feature is on. So
//      moving country updates it as soon as either kind of location arrives.
//   3. A guess from their WhatsApp number (phoneTimezoneGuess.ts: the area code for a US/Canadian
//      number, else the most likely zone for the country). For someone who has never shared
//      anything; replaced by anything above.
//   4. Unknown — callers ask the user to share their WhatsApp location.
// Only #1 and a shared location are stored (a check-in or a phone number is re-derived each time,
// so a newer one can move it). Rows saved before the source was recorded count as #1.
//
// Earlier versions of this had a 4th source: asking the model to resolve a place name it read
// from the user's own phrasing into an IANA zone itself. That produced a real bug (a UK user's
// "10am" reminder firing an hour late) — the model had mapped "the UK" to "UTC" rather than
// "Europe/London", both of which are valid IANA zones, so nothing here could have caught it after
// the fact. The fix isn't a better prompt; it's removing the model from this decision entirely —
// see setUserTimezoneFromLocation, the only WhatsApp-side way to set this now.
import { find as findTimezonesForCoords } from "geo-tz";
import { DateTime, IANAZone } from "luxon";
import { guessTimezoneFromPhone } from "./phoneTimezoneGuess.js";
import { getSetting, setSetting, getEnabledTools, listCheckins, listPhoneNumbersForUser } from "../db/store.js";

const TIMEZONE_SETTING_KEY = "timezone";
const TIMEZONE_SOURCE_KEY = "timezone_source"; // "picker" | "location"; absent on older rows
const TIMEZONE_SET_AT_KEY = "timezone_set_at";

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

function latestCheckinZone(ownerId: number): { zone: string; at: number } | null {
  if (!getEnabledTools(ownerId).has("travel")) return null;
  const lastCheckin = listCheckins(ownerId, 1)[0];
  if (!lastCheckin || lastCheckin.latitude == null || lastCheckin.longitude == null) return null;
  const zone = timezoneFromCoords(lastCheckin.latitude, lastCheckin.longitude);
  return zone ? { zone, at: lastCheckin.checkedInAt } : null;
}

function phoneGuessZone(ownerId: number): string | null {
  for (const { phone } of listPhoneNumbersForUser(ownerId)) {
    const zone = guessTimezoneFromPhone(phone);
    if (zone) return zone;
  }
  return null;
}

export function getUserTimezone(ownerId: number): string | null {
  const stored = getSetting(ownerId, TIMEZONE_SETTING_KEY);
  if (stored && getSetting(ownerId, TIMEZONE_SOURCE_KEY) !== "location") return stored;

  const checkin = latestCheckinZone(ownerId);
  if (stored) {
    const sharedAt = Number(getSetting(ownerId, TIMEZONE_SET_AT_KEY) ?? "0") || 0;
    return checkin && checkin.at > sharedAt ? checkin.zone : stored;
  }
  return checkin?.zone ?? phoneGuessZone(ownerId);
}

// The user's current wall-clock date ("YYYY-MM-DD") and time ("HH:MM") for "send at 9pm"-style
// schedules. Falls back to the server's own clock when their timezone isn't known yet (nothing has
// set it — see the sources above), which is what these schedules used before they had a timezone.
export function userLocalClock(ownerId: number): { dateKey: string; hhmm: string } {
  const timezone = getUserTimezone(ownerId);
  const zoned = timezone ? DateTime.now().setZone(timezone) : DateTime.now();
  const now = zoned.isValid ? zoned : DateTime.now();
  return { dateKey: now.toFormat("yyyy-MM-dd"), hhmm: now.toFormat("HH:mm") };
}

// The one WhatsApp-side way to set a timezone from chat: a real GPS coordinate the user shared
// via WhatsApp's own location-share feature (chatDispatch.ts's handleLocation calls this for
// every location message, unconditionally — no "travel" toggle gate, since this is core
// reminder-accuracy plumbing, not a travel feature). No model involved: geo-tz's lookup is a pure
// function of the coordinates, so the result is exactly as reliable as GPS itself.
export function setUserTimezoneFromLocation(ownerId: number, latitude: number, longitude: number): string | null {
  const resolved = timezoneFromCoords(latitude, longitude);
  if (resolved) {
    setSetting(ownerId, TIMEZONE_SETTING_KEY, resolved);
    setSetting(ownerId, TIMEZONE_SOURCE_KEY, "location");
    setSetting(ownerId, TIMEZONE_SET_AT_KEY, String(Date.now()));
  }
  return resolved;
}

// Used by settingsRoutes.ts, where the value comes from a real <select> of IANA names the human
// picked directly — still deterministic, since nothing is inferring or guessing what the human
// meant. Not exposed to the model as a tool (see the file comment above for why).
export function setUserTimezone(ownerId: number, timezone: string): boolean {
  const trimmed = timezone.trim();
  if (!isValidIanaTimezone(trimmed)) return false;
  setSetting(ownerId, TIMEZONE_SETTING_KEY, trimmed);
  setSetting(ownerId, TIMEZONE_SOURCE_KEY, "picker");
  return true;
}
