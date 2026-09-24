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

export function realPersonAlertsEnabled(ownerId: number): boolean {
  return getSetting(ownerId, REAL_PERSON_KEY) !== "false";
}

export function importantEmailAlertsEnabled(ownerId: number): boolean {
  return getSetting(ownerId, IMPORTANT_KEY) !== "false";
}

export function setRealPersonAlertsEnabled(ownerId: number, enabled: boolean): void {
  setSetting(ownerId, REAL_PERSON_KEY, enabled ? "true" : "false");
}

export function setImportantEmailAlertsEnabled(ownerId: number, enabled: boolean): void {
  setSetting(ownerId, IMPORTANT_KEY, enabled ? "true" : "false");
}
