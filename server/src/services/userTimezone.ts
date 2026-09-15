// Resolves "what timezone is this user in" for reminder time math (services/reminderTime.ts) —
// deterministically, with no AI guessing involved. Three sources, in priority order:
//   1. An explicit timezone the user has set (Settings page, or having answered Marlowe once via
//      WhatsApp) — always wins once present.
//   2. The IANA zone for their most recent travel check-in's GPS coordinates (geo-tz: an offline,
//      exact geographic lookup — not a heuristic guess), if the travel feature is on and they've
//      shared a location. Cached back into the setting so this is a one-time lookup per move.
//   3. Unknown — callers ask the user once (ai/assistant.ts's set_reminder/set_user_timezone).
import { find as findTimezonesForCoords } from "geo-tz";
import { IANAZone } from "luxon";
import { getSetting, setSetting, getEnabledTools, listCheckins } from "../db/store.js";

const TIMEZONE_SETTING_KEY = "timezone";

export function isValidIanaTimezone(value: string): boolean {
  return IANAZone.isValidZone(value.trim());
}

export function getUserTimezone(ownerId: number): string | null {
  const explicit = getSetting(ownerId, TIMEZONE_SETTING_KEY);
  if (explicit) return explicit;

  if (!getEnabledTools(ownerId).has("travel")) return null;
  const lastCheckin = listCheckins(ownerId, 1)[0];
  if (!lastCheckin || lastCheckin.latitude == null || lastCheckin.longitude == null) return null;

  const matches = findTimezonesForCoords(lastCheckin.latitude, lastCheckin.longitude);
  const resolved = matches[0];
  if (!resolved) return null;

  // Cache it: a later relocation naturally overwrites this once a newer check-in exists and this
  // function runs again, since listCheckins(ownerId, 1) always returns the most recent one.
  setSetting(ownerId, TIMEZONE_SETTING_KEY, resolved);
  return resolved;
}

export function setUserTimezone(ownerId: number, timezone: string): boolean {
  const trimmed = timezone.trim();
  if (!isValidIanaTimezone(trimmed)) return false;
  setSetting(ownerId, TIMEZONE_SETTING_KEY, trimmed);
  return true;
}
