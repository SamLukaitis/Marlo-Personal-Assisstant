// Shared suppression for the post-connect onboarding window (see postConnectSetup.ts's
// startPostConnectSetup). alerts.ts (real-person mail) and reconciliation.ts (matches against
// saved documents) call isOnboardingSuppressionActive before pushing a WhatsApp message, and
// record-but-don't-send (incrementSuppressedOnboardingAlerts) while it's true — a user who is
// mid-onboarding, answering its own yes/no questions, must not also get hit with a burst of
// separate alerts about a backlog of mail that was already sitting in their inbox before they
// connected.
//
// importantEmailAlerts.ts (flagged categories: flight change, reservation confirmed, security
// alert, etc.) doesn't use this anymore — it has its own classifier, so
// scanAndCurateImportantEmailsForOnboarding runs synchronously at connect time instead
// (startPostConnectSetup), baselining that backlog deterministically and surfacing a curated
// preview right in the "Connected!" message rather than suppressing-then-flushing it later.
// alerts.ts/reconciliation.ts still need this module because neither has a classifier to curate a
// preview from.
//
// isOnboardingSuppressionActive is true for two overlapping reasons:
//  1. postConnectSetup.ts's own question chain is still in progress (getPendingSetup non-null).
//  2. The connection happened recently (markOnboardingConnected), regardless of chain state.
//
// (2) is the one that actually matters in practice, and its absence was a real bug in the first
// version of this fix: the onboarding chain is a handful of yes/no questions that a real user
// typically finishes in well under a minute, while scheduler.ts's proactive checks run on a
// single global 5-minute tick with no relationship to any individual user's connection moment —
// so the first tick to ever see a freshly-connected owner lands anywhere from 0 to 5 minutes
// after they connect, almost always *after* pending_setup has already been cleared. Gating on
// chain state alone reproduced the exact flood this was meant to fix, just delayed by up to a
// tick. The grace period below keeps suppression active long enough to guarantee that first tick
// falls inside it, however fast the chain itself finishes.
//
// flushOnboardingAlertSummaryIfDue (called once per user per scheduler tick) reports whatever was
// suppressed, exactly once, right when suppression stops applying — a single "I found N
// important-looking emails" message instead of relaying each one individually. Real-time alerting
// resumes normally for anything that shows up after that point.
import { getSetting, setSetting, getPendingSetup, listPhoneNumbersForUser } from "../db/store.js";
import { isWhatsAppConfigured } from "../providers/whatsapp.js";
import { sendProactiveMessage } from "./outbound.js";

const COUNT_KEY = "onboarding_suppressed_alerts";
const CONNECTED_AT_KEY = "onboarding_connected_at";

// 2x scheduler.ts's CHECK_INTERVAL_MS (5 min) — comfortably covers the first tick after
// connection even if it lands late (the scheduler skips a whole cycle when the previous one is
// still running). Duplicated as a plain constant rather than imported from scheduler.ts: this
// only needs to be "comfortably more than one tick", not kept in exact lockstep, and importing
// from scheduler.ts would pull its whole dependency graph into every scanner that uses this file.
const GRACE_PERIOD_MS = 10 * 60 * 1000;

// Call once, right when a mailbox finishes connecting (startPostConnectSetup) — anchors the
// grace period to the real connection moment, independent of how fast the user answers the
// onboarding chain's own questions.
export function markOnboardingConnected(ownerId: number): void {
  setSetting(ownerId, CONNECTED_AT_KEY, String(Date.now()));
}

function isWithinConnectionGracePeriod(ownerId: number): boolean {
  const connectedAt = Number(getSetting(ownerId, CONNECTED_AT_KEY) ?? "0") || 0;
  return connectedAt > 0 && Date.now() - connectedAt < GRACE_PERIOD_MS;
}

export function isOnboardingSuppressionActive(ownerId: number): boolean {
  return getPendingSetup(ownerId) !== null || isWithinConnectionGracePeriod(ownerId);
}

export function incrementSuppressedOnboardingAlerts(ownerId: number, by = 1): void {
  if (by <= 0) return;
  const current = Number(getSetting(ownerId, COUNT_KEY) ?? "0") || 0;
  setSetting(ownerId, COUNT_KEY, String(current + by));
}

// Reads the current count and resets it to zero. Call exactly once, right when the total is
// about to be reported, so a straggler scanner tick landing later starts a fresh count instead
// of the same backlog being mentioned twice.
export function takeSuppressedOnboardingAlertCount(ownerId: number): number {
  const current = Number(getSetting(ownerId, COUNT_KEY) ?? "0") || 0;
  if (current > 0) setSetting(ownerId, COUNT_KEY, "0");
  return current;
}

// Called once per user on every scheduler tick (scheduler.ts). No-ops while suppression is still
// active (chain in progress, or still within the connection grace period) — more may still
// arrive, so it's not time to report yet. Once suppression has lapsed, reports whatever built up
// in a single message and resets the counter; takeSuppressedOnboardingAlertCount's reset makes
// this naturally idempotent, so a tick that finds nothing new to flush is silent, not a duplicate.
export async function flushOnboardingAlertSummaryIfDue(ownerId: number): Promise<void> {
  if (isOnboardingSuppressionActive(ownerId)) return;
  // Deliverability gates checked BEFORE consuming the count — same precedent as the scanners
  // themselves — so an owner with nothing to deliver to (yet) keeps its count intact for a later
  // tick to actually report, instead of the backlog being silently lost.
  if (!isWhatsAppConfigured()) return;
  const numbers = listPhoneNumbersForUser(ownerId).map((r) => r.phone);
  if (numbers.length === 0) return;
  const count = takeSuppressedOnboardingAlertCount(ownerId);
  if (count === 0) return;

  const text = `Also — I found *${count}* important-looking email${count === 1 ? "" : "s"} already in your inbox from before we started. I'll message you individually as new ones come in from here.`;
  // Fire-and-forget on delivery failure, same precedent as alerts.ts's notify() — this is a
  // friendly one-line heads-up, not the durable record itself (every suppressed match is already
  // saved via markAlerted/saveEntity by the scanner that found it), so losing just this summary
  // to a transient send failure isn't worth re-queuing the count for a retry.
  for (const number of numbers) {
    try {
      await sendProactiveMessage(number, text, "alert");
    } catch (err) {
      console.error("onboardingAlertSuppression: failed to send summary", err);
    }
  }
}
