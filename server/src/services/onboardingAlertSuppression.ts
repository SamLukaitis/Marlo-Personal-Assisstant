// Shared suppressed-alert counter for the post-connect onboarding window (see
// postConnectSetup.ts's startPostConnectSetup / sendClosingMessage). Each proactive scanner
// (alerts.ts, importantEmailAlerts.ts, reconciliation.ts) increments this instead of pushing a
// WhatsApp message while getPendingSetup(ownerId) is still set — a user who is mid-onboarding,
// answering its own yes/no questions, must not also get hit with a burst of separate alerts
// about a backlog of mail that was already sitting in their inbox before they connected (this
// was a real bug: a fresh connection commonly has several months' or days' worth of automated
// mail waiting, and the scanners' own per-tick caps just mean the flood arrives as 5-6 separate
// WhatsApp pings interleaved with the onboarding conversation itself).
//
// sendClosingMessage reads-and-resets this exactly once, right when onboarding finishes, to
// mention the total in a single line instead of relaying each one individually. Real-time
// alerting resumes normally for anything that shows up after that point — this only defers the
// backlog that was found *during* the onboarding window, it never drops it (every suppressed
// match is still fully recorded — markAlerted/saveEntity — by the caller, exactly as if it had
// been sent).
import { getSetting, setSetting } from "../db/store.js";

const SETTING_KEY = "onboarding_suppressed_alerts";

export function incrementSuppressedOnboardingAlerts(ownerId: number, by = 1): void {
  if (by <= 0) return;
  const current = Number(getSetting(ownerId, SETTING_KEY) ?? "0") || 0;
  setSetting(ownerId, SETTING_KEY, String(current + by));
}

// Reads the current count and resets it to zero. Call exactly once, right when the total is
// about to be reported, so a straggler scanner tick landing later starts a fresh count instead
// of the same backlog being mentioned twice.
export function takeSuppressedOnboardingAlertCount(ownerId: number): number {
  const current = Number(getSetting(ownerId, SETTING_KEY) ?? "0") || 0;
  if (current > 0) setSetting(ownerId, SETTING_KEY, "0");
  return current;
}
