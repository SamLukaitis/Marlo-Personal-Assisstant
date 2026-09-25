import { getSetting, setSetting } from "../db/store.js";

// The two independent kinds of email ping, both on unless the user has explicitly turned them
// off — from Settings (alertRoutes.ts) or by asking in chat (assistant.ts's set_email_alerts):
// - real-person alerts (alerts.ts): "X emailed you" whenever a person, not a newsletter, writes.
//   Used to be opt-in, which left WhatsApp-only users with no way to ever get them; only an
//   explicit "false" (including one saved back when it was opt-in) turns it off now.
// - important-email alerts (importantEmailAlerts.ts): flight changes, deliveries, invoices due,
//   etc. picked out of automated mail. Always defaulted on.
const REAL_PERSON_KEY = "realtime_alerts_enabled";
const IMPORTANT_KEY = "important_email_alerts_enabled";
const REAL_PERSON_ENABLED_AT_KEY = "realtime_alerts_enabled_at";

export function realPersonAlertsEnabled(ownerId: number): boolean {
  return getSetting(ownerId, REAL_PERSON_KEY) !== "false";
}

export function importantEmailAlertsEnabled(ownerId: number): boolean {
  return getSetting(ownerId, IMPORTANT_KEY) !== "false";
}

// When the user last switched real-person alerts on from off, or 0 if they never did (a user still
// on the default has no such moment). alerts.ts's first scan uses it so mail that arrives after
// switching on isn't swallowed as "already sitting in the inbox".
export function realPersonAlertsEnabledSince(ownerId: number): number {
  return Number(getSetting(ownerId, REAL_PERSON_ENABLED_AT_KEY) ?? "0") || 0;
}

export function setRealPersonAlertsEnabled(ownerId: number, enabled: boolean): void {
  if (enabled && !realPersonAlertsEnabled(ownerId)) {
    setSetting(ownerId, REAL_PERSON_ENABLED_AT_KEY, String(Date.now()));
  }
  setSetting(ownerId, REAL_PERSON_KEY, enabled ? "true" : "false");
}

// Real-person mail only: "digest" (the default) holds them for one summary at emailDigestTime
// (emailDigest.ts), "instant" pings per email as it arrives — a user opts into that by asking in
// chat. Important automated mail (flights, bookings...) is always instant — a digest would be the
// wrong time to hear a flight moved.
export type RealPersonAlertMode = "instant" | "digest";
const REAL_PERSON_MODE_KEY = "realtime_alerts_mode";
const DIGEST_TIME_KEY = "email_digest_time";
const DEFAULT_DIGEST_TIME = "21:00";

export function realPersonAlertMode(ownerId: number): RealPersonAlertMode {
  return getSetting(ownerId, REAL_PERSON_MODE_KEY) === "instant" ? "instant" : "digest";
}

// True once the user has picked a mode themselves (in chat), as opposed to living with the default.
export function realPersonAlertModeChosen(ownerId: number): boolean {
  return getSetting(ownerId, REAL_PERSON_MODE_KEY) !== null;
}

export function setRealPersonAlertMode(ownerId: number, mode: RealPersonAlertMode): void {
  setSetting(ownerId, REAL_PERSON_MODE_KEY, mode);
}

export function emailDigestTime(ownerId: number): string {
  return getSetting(ownerId, DIGEST_TIME_KEY) ?? DEFAULT_DIGEST_TIME;
}

// "21:00" -> "9pm", "18:30" -> "6:30pm".
export function formatDigestTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}${m === 0 ? "" : `:${String(m).padStart(2, "0")}`}${h < 12 ? "am" : "pm"}`;
}

export function isValidDigestTime(time: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
}

export function setEmailDigestTime(ownerId: number, time: string): void {
  if (!isValidDigestTime(time)) throw new Error(`digest time must be 24h HH:MM, got "${time}"`);
  setSetting(ownerId, DIGEST_TIME_KEY, time);
}

export function setImportantEmailAlertsEnabled(ownerId: number, enabled: boolean): void {
  setSetting(ownerId, IMPORTANT_KEY, enabled ? "true" : "false");
}
