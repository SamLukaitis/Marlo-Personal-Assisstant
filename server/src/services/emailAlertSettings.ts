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

export function setImportantEmailAlertsEnabled(ownerId: number, enabled: boolean): void {
  setSetting(ownerId, IMPORTANT_KEY, enabled ? "true" : "false");
}
