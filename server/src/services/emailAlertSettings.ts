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

// Things the user has said they never want to hear about ("stop telling me about Railway crash
// emails") without switching a whole kind of alert off. Each mute matches on the sender (name or
// address), the subject, or both — every part given has to appear, case-insensitively. Applied to
// both kinds of email ping and to the daily digest; the mail itself is left alone in the inbox.
export interface EmailAlertMute {
  from?: string;
  subject?: string;
}

const MUTES_KEY = "email_alert_mutes";
const MAX_MUTES = 100;
const MAX_MUTE_PART = 100;

export function listEmailAlertMutes(ownerId: number): EmailAlertMute[] {
  try {
    const parsed = JSON.parse(getSetting(ownerId, MUTES_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((m) => m && (m.from || m.subject)) : [];
  } catch {
    return [];
  }
}

function cleanPart(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const flat = value.replace(/\s+/g, " ").trim().slice(0, MAX_MUTE_PART);
  return flat || undefined;
}

function sameMute(a: EmailAlertMute, b: EmailAlertMute): boolean {
  return (a.from ?? "").toLowerCase() === (b.from ?? "").toLowerCase() &&
    (a.subject ?? "").toLowerCase() === (b.subject ?? "").toLowerCase();
}

// Returns the cleaned mute, or null when neither part has any text.
export function addEmailAlertMute(ownerId: number, mute: { from?: unknown; subject?: unknown }): EmailAlertMute | null {
  const from = cleanPart(mute.from);
  const subject = cleanPart(mute.subject);
  if (!from && !subject) return null;
  const clean: EmailAlertMute = { ...(from ? { from } : {}), ...(subject ? { subject } : {}) };
  const existing = listEmailAlertMutes(ownerId).filter((m) => !sameMute(m, clean));
  setSetting(ownerId, MUTES_KEY, JSON.stringify([...existing, clean].slice(-MAX_MUTES)));
  return clean;
}

// Removes every mute whose parts match what's given (a bare `from` removes all mutes on that sender).
export function removeEmailAlertMutes(ownerId: number, mute: { from?: unknown; subject?: unknown }): number {
  const from = cleanPart(mute.from)?.toLowerCase();
  const subject = cleanPart(mute.subject)?.toLowerCase();
  if (!from && !subject) return 0;
  const all = listEmailAlertMutes(ownerId);
  const kept = all.filter(
    (m) => !((!from || (m.from ?? "").toLowerCase() === from) && (!subject || (m.subject ?? "").toLowerCase() === subject))
  );
  setSetting(ownerId, MUTES_KEY, JSON.stringify(kept));
  return all.length - kept.length;
}

export function isMutedEmail(mutes: EmailAlertMute[], m: { from: string; subject: string }): boolean {
  const from = m.from.toLowerCase();
  const subject = m.subject.toLowerCase();
  return mutes.some(
    (mute) =>
      (!mute.from || from.includes(mute.from.toLowerCase())) &&
      (!mute.subject || subject.includes(mute.subject.toLowerCase()))
  );
}
