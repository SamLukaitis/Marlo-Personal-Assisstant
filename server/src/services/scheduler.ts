import { getBriefingSettings, getTodaysBriefing, refreshBriefing } from "./briefing.js";
import { withMessageCache } from "./hub.js";
import {
  getSetting,
  setSetting,
  listPhoneNumbersForUser,
  listAllCheckinsAscending,
  listAllUserIds,
  getEnabledTools,
  deleteExpiredPendingActions,
  deleteExpiredSeenWamids,
  pruneOldServerLogs,
} from "../db/store.js";
import { isWhatsAppConfigured } from "../providers/whatsapp.js";
import { sendToAllNumbers } from "./proactiveDelivery.js";
import { countTravelDays } from "./travelDays.js";
import { checkForNewImportantMessages } from "./alerts.js";
import { importantEmailAlertsEnabled, realPersonAlertsEnabled } from "./emailAlertSettings.js";
import { checkNewEmailsAgainstRecentDocuments } from "./reconciliation.js";
import { checkForImportantEmails } from "./importantEmailAlerts.js";
import { flushEmailDigestIfDue } from "./emailDigest.js";
import { sweepStalledPhoneActions } from "./phoneActions.js";
import { syncBookingReminders } from "./tripPrep.js";
import { userLocalClock } from "./userTimezone.js";
import {
  collectAttentionForBriefing,
  commitAttentionBundle,
  deliverDueAttentionItems,
  type AttentionBundle,
} from "./attention.js";

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const SCHENGEN_WARN_AT = 80;
const SCHENGEN_LIMIT = 90;

function schengenAlertLine(ownerId: number): string | null {
  const now = Date.now();
  const sinceMs = now - 180 * 24 * 60 * 60 * 1000;
  const result = countTravelDays(listAllCheckinsAscending(ownerId), "schengen", sinceMs, now);
  if (result.daysPresent >= SCHENGEN_LIMIT) {
    return `🚨 Schengen alert: you've used ${result.daysPresent}/90 days in the last 180 days — you're at or over the limit.`;
  }
  if (result.daysPresent >= SCHENGEN_WARN_AT) {
    return `⚠️ Schengen check: ${result.daysPresent}/90 days used in the last 180 days — getting close to the limit.`;
  }
  return null;
}

// The exact text of the daily proactive push: the LLM-synthesized briefing plus whatever non-LLM
// lines get appended after it. Shared with the WhatsApp simulator's "Send daily briefing" button
// (routes/whatsappSimRoutes.ts) so what that button sends can never drift from what the real
// scheduled send does — which is the whole point of testing a briefing rewrite through it.
//
// `refresh` rebuilds today's briefing from scratch instead of reusing the one already stored for
// today. That's what the simulator wants (a snapshot of right now, repeatable on every press) and
// never what the scheduler wants (one build per day, reused by the Assistant page's briefing bar).
//
// `attention` is what the attention gate is holding for this briefing (attention.ts). The scheduler
// passes the bundle it will commit once the send succeeds; the simulator omits it and gets a
// preview of the same items, left uncommitted so the real send still carries them.
export async function composeDailyBriefingMessage(
  ownerId: number,
  refresh = false,
  attention: AttentionBundle = collectAttentionForBriefing(ownerId, Date.now())
): Promise<string> {
  const briefing = refresh ? await refreshBriefing(ownerId, attention) : await getTodaysBriefing(ownerId, attention);
  // Both channels (UI and WhatsApp) must reflect the same enabled/disabled state — a user
  // with travel off gets no Schengen line, same as their Setup page shows no travel section.
  const alert = getEnabledTools(ownerId).has("travel") ? schengenAlertLine(ownerId) : null;
  return alert ? `${briefing.content}\n\n${alert}` : briefing.content;
}

// Runs every few minutes and fires at most once per calendar day, once the user's own local time
// (userTimezone.ts; the server's clock if theirs isn't known yet) has passed the configured send time — not a precise cron, but good enough for a personal daily nudge,
// and it still catches up later in the day if the server was off right at the target time.
export async function runDailyCheckForUser(ownerId: number): Promise<void> {
  const settings = getBriefingSettings(ownerId);
  if (!settings.proactive) return;
  const { dateKey, hhmm } = userLocalClock(ownerId);
  // ">=": a stamp later than the user's own date (their timezone moved west, or the day the
  // stamp switched from server-local to user-local dates) also counts as already sent today.
  if ((getSetting(ownerId, "last_proactive_send_date") ?? "") >= dateKey) return;
  if (hhmm < settings.sendTime) return;

  if (!isWhatsAppConfigured()) {
    console.warn(
      "scheduler: proactive briefing is enabled but WhatsApp isn't configured — skipping"
    );
    setSetting(ownerId, "last_proactive_send_date", dateKey);
    return;
  }

  const numbers = listPhoneNumbersForUser(ownerId).map((r) => r.phone);
  if (numbers.length === 0) {
    console.warn(
      `scheduler: proactive briefing is enabled for user ${ownerId} but they have no WhatsApp numbers registered — skipping`
    );
    setSetting(ownerId, "last_proactive_send_date", dateKey);
    return;
  }

  try {
    // What the attention gate is holding for this morning (acknowledgements, non-urgent items, and
    // reminders due in the next couple of hours), folded in so they don't each ping separately.
    const now = Date.now();
    const attention = collectAttentionForBriefing(ownerId, now);
    const message = await composeDailyBriefingMessage(ownerId, false, attention);
    // Only stamp the day done once every number has it; a retry next tick skips numbers that
    // already got today's briefing (see proactiveDelivery.ts).
    const itemKey = `daily-briefing:${dateKey}`;
    if (await sendToAllNumbers(ownerId, itemKey, numbers, message, "digest", "scheduler")) {
      setSetting(ownerId, "last_proactive_send_date", dateKey);
      commitAttentionBundle(ownerId, attention, now);
    }
  } catch (err) {
    console.error(`scheduler: failed to send proactive briefing for user ${ownerId}`, err);
  }
}

async function runAlertsCheckForUser(ownerId: number): Promise<void> {
  if (!realPersonAlertsEnabled(ownerId)) return;
  try {
    await checkForNewImportantMessages(ownerId);
  } catch (err) {
    console.error(`scheduler: alerts check failed for user ${ownerId}`, err);
  }
}

async function runReconciliationCheckForUser(ownerId: number): Promise<void> {
  try {
    await checkNewEmailsAgainstRecentDocuments(ownerId);
  } catch (err) {
    console.error(`scheduler: reconciliation check failed for user ${ownerId}`, err);
  }
}

// Gated on the same "travel" tool toggle as the Schengen alert above — no separate setting to
// add or explain, and consistent with "travel off means no travel-derived proactive pushes".
async function runTripPrepCheckForUser(ownerId: number): Promise<void> {
  if (!getEnabledTools(ownerId).has("travel")) return;
  try {
    await syncBookingReminders(ownerId);
  } catch (err) {
    console.error(`scheduler: trip-prep sync failed for user ${ownerId}`, err);
  }
}

async function runImportantEmailAlertsCheckForUser(ownerId: number): Promise<void> {
  if (!importantEmailAlertsEnabled(ownerId)) return;
  try {
    await checkForImportantEmails(ownerId);
  } catch (err) {
    console.error(`scheduler: important-email check failed for user ${ownerId}`, err);
  }
}

// Loops over every tenant rather than assuming a single global run — each user's iteration is
// caught independently so one tenant's failure (a broken account, a transient API error) can't
// block or crash another tenant's briefing/alerts.
const SERVER_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // logs are a debugging aid, not a permanent record

async function tick(): Promise<void> {
  deleteExpiredPendingActions();
  deleteExpiredSeenWamids();
  pruneOldServerLogs(SERVER_LOG_RETENTION_MS);
  const startedAt = Date.now();
  const ownerIds = listAllUserIds();
  let realPersonAlertsOff = 0;
  for (const ownerId of ownerIds) {
    if (!realPersonAlertsEnabled(ownerId)) realPersonAlertsOff++;
    await runDailyCheckForUser(ownerId).catch((err) =>
      console.error(`scheduler: daily check failed for user ${ownerId}`, err)
    );
    await runTripPrepCheckForUser(ownerId).catch((err) =>
      console.error(`scheduler: trip-prep check failed for user ${ownerId}`, err)
    );
    // alerts/reconciliation/important-email each independently call hubListMessages for this
    // same user — sharing one withMessageCache scope collapses the ones that fetch an identical
    // (query, limit) window (alerts + important-email both use {limit:50}) into a single Gmail
    // fetch instead of paying for it twice. See hub.ts's withMessageCache doc comment.
    await withMessageCache(async () => {
      // Important-email first: it records what it alerted on, which the real-person check then
      // reads so a venue's own confirmation of a booking it just announced isn't announced twice.
      await runImportantEmailAlertsCheckForUser(ownerId).catch((err) =>
        console.error(`scheduler: important-email check failed for user ${ownerId}`, err)
      );
      await runAlertsCheckForUser(ownerId).catch((err) =>
        console.error(`scheduler: alerts check failed for user ${ownerId}`, err)
      );
      await runReconciliationCheckForUser(ownerId).catch((err) =>
        console.error(`scheduler: reconciliation check failed for user ${ownerId}`, err)
      );
    });
    // After every source has submitted this tick, so a reminder or deferred alert that fell due
    // goes out once, in order, under the day's cap.
    await deliverDueAttentionItems(ownerId).catch((err) =>
      console.error(`scheduler: attention delivery failed for user ${ownerId}`, err)
    );
    // After the alert scan so mail that arrived just before the digest time is in it. Not gated on
    // the digest mode: a user who switches back to instant with mail still queued still gets it.
    await flushEmailDigestIfDue(ownerId).catch((err) =>
      console.error(`scheduler: email digest failed for user ${ownerId}`, err)
    );
  }
  // Not per-owner: a stalled Shortcut run is found across all users in one pass. The tick runs
  // every 5 minutes, so a stalled run is reported 5-10 minutes after the tap.
  await sweepStalledPhoneActions().catch((err) => console.error("scheduler: phone action sweep failed", err));
  console.log(
    `scheduler: tick finished — ${ownerIds.length} user${ownerIds.length === 1 ? "" : "s"}, ` +
      `real-person alerts off for ${realPersonAlertsOff}, ${Date.now() - startedAt}ms`
  );
}

// setInterval fires on a fixed clock regardless of how long the previous tick() took. At
// multi-tenant scale, tick() awaits real network calls per user in a loop, so a full pass can
// plausibly exceed CHECK_INTERVAL_MS — a raw setInterval would then start a second, overlapping
// tick() on top of the first (double-sending briefings/alerts) on a single process, with no
// second instance required. Self-rescheduling after each tick finishes, guarded against
// re-entry, makes that impossible: the next tick is never scheduled until the current one (and
// its own timer) has fully settled.
let tickInFlight = false;

export async function tickGuarded(): Promise<void> {
  if (tickInFlight) {
    console.warn("scheduler: previous tick still running — skipping this cycle");
    return;
  }
  tickInFlight = true;
  try {
    await tick();
  } finally {
    tickInFlight = false;
  }
}

export function startScheduler(): void {
  void tickGuarded();
  setInterval(() => void tickGuarded(), CHECK_INTERVAL_MS);
}
