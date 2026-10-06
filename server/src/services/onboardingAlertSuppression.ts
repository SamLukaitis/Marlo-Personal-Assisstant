// Keeps proactive messages out of the post-connect onboarding conversation (see postConnectSetup.ts's
// startPostConnectSetup). alerts.ts routes people's mail to the evening digest while
// isOnboardingSuppressionActive is true; the attention gate (attention.ts) holds its sends while
// isPostConnectChainInProgress is true and delivers them once the question chain has finished.
// Pre-connect important mail is surfaced by importantEmailAlerts.ts's curated preview in the
// "Connected!" message. Nothing found during setup is ever summarised as a bare count.
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
import { getSetting, setSetting, getPendingSetup } from "../db/store.js";

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

// Upper bound on how long an unfinished question chain can hold alerts back — someone who
// abandons onboarding mid-chain must not lose alerts forever (and hub.ts releases a held Gmail
// checkpoint after an hour anyway, so holding past that would drop mail outright).
const CHAIN_HOLD_MAX_MS = 30 * 60 * 1000;

// importantEmailAlerts.ts's gate: true only while postConnectSetup.ts's question chain is still
// running for a recent connection. Unlike isOnboardingSuppressionActive, the caller defers
// (leaves mail unmarked and holds the checkpoint) rather than counting it, so every alert still
// arrives individually — just after the closing message instead of interleaved with the questions.
//
// Also true for the first CHAIN_START_MS after connecting regardless of pending_setup: the chain
// only sets pending_setup once the "Connected!" message and first question have gone out (after
// the onboarding email scan), so without this a scheduler tick landing in those first seconds
// could send an alert ahead of "Connected!" itself.
const CHAIN_START_MS = 2 * 60 * 1000;

export function isPostConnectChainInProgress(ownerId: number): boolean {
  const connectedAt = Number(getSetting(ownerId, CONNECTED_AT_KEY) ?? "0") || 0;
  if (connectedAt <= 0) return false;
  const sinceConnect = Date.now() - connectedAt;
  if (sinceConnect < CHAIN_START_MS) return true;
  return getPendingSetup(ownerId) !== null && sinceConnect < CHAIN_HOLD_MAX_MS;
}

export function isOnboardingSuppressionActive(ownerId: number): boolean {
  return getPendingSetup(ownerId) !== null || isWithinConnectionGracePeriod(ownerId);
}
