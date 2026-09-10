import { getBriefingSettings, getTodaysBriefing } from "./briefing.js";
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
import { sendProactiveMessage } from "./outbound.js";
import { countTravelDays } from "./travelDays.js";
import { checkForNewImportantMessages } from "./alerts.js";
import { checkNewEmailsAgainstRecentDocuments } from "./reconciliation.js";
import { checkDueMemoryReminders } from "./memoryReminders.js";
import { checkForImportantEmails } from "./importantEmailAlerts.js";
import { todayKey } from "./dateKey.js";

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const SCHENGEN_WARN_AT = 80;
const SCHENGEN_LIMIT = 90;

function currentHHMM(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

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

// Runs every few minutes and fires at most once per calendar day, once local time has passed
// the configured send time — not a precise cron, but good enough for a personal daily nudge,
// and it still catches up later in the day if the server was off right at the target time.
async function runDailyCheckForUser(ownerId: number): Promise<void> {
  const settings = getBriefingSettings(ownerId);
  if (!settings.proactive) return;
  if (getSetting(ownerId, "last_proactive_send_date") === todayKey()) return;
  if (currentHHMM() < settings.sendTime) return;

  if (!isWhatsAppConfigured()) {
    console.warn(
      "scheduler: proactive briefing is enabled but WhatsApp isn't configured — skipping"
    );
    setSetting(ownerId, "last_proactive_send_date", todayKey());
    return;
  }

  const numbers = listPhoneNumbersForUser(ownerId).map((r) => r.phone);
  if (numbers.length === 0) {
    console.warn(
      `scheduler: proactive briefing is enabled for user ${ownerId} but they have no WhatsApp numbers registered — skipping`
    );
    setSetting(ownerId, "last_proactive_send_date", todayKey());
    return;
  }

  try {
    const briefing = await getTodaysBriefing(ownerId);
    // Both channels (UI and WhatsApp) must reflect the same enabled/disabled state — a user
    // with travel off gets no Schengen line, same as their Setup page shows no travel section.
    const alert = getEnabledTools(ownerId).has("travel") ? schengenAlertLine(ownerId) : null;
    const message = alert ? `${briefing.content}\n\n${alert}` : briefing.content;
    for (const number of numbers) {
      await sendProactiveMessage(number, message, "digest");
    }
    setSetting(ownerId, "last_proactive_send_date", todayKey());
  } catch (err) {
    console.error(`scheduler: failed to send proactive briefing for user ${ownerId}`, err);
  }
}

async function runAlertsCheckForUser(ownerId: number): Promise<void> {
  if (getSetting(ownerId, "realtime_alerts_enabled") !== "true") return;
  try {
    await checkForNewImportantMessages(ownerId);
  } catch (err) {
    console.error(`scheduler: alerts check failed for user ${ownerId}`, err);
  }
}

async function runMemoryReminderCheckForUser(ownerId: number): Promise<void> {
  try {
    await checkDueMemoryReminders(ownerId);
  } catch (err) {
    console.error(`scheduler: memory reminder check failed for user ${ownerId}`, err);
  }
}

async function runReconciliationCheckForUser(ownerId: number): Promise<void> {
  try {
    await checkNewEmailsAgainstRecentDocuments(ownerId);
  } catch (err) {
    console.error(`scheduler: reconciliation check failed for user ${ownerId}`, err);
  }
}

async function runImportantEmailAlertsCheckForUser(ownerId: number): Promise<void> {
  if (getSetting(ownerId, "important_email_alerts_enabled") === "false") return;
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
  for (const ownerId of listAllUserIds()) {
    await runDailyCheckForUser(ownerId).catch((err) =>
      console.error(`scheduler: daily check failed for user ${ownerId}`, err)
    );
    await runAlertsCheckForUser(ownerId).catch((err) =>
      console.error(`scheduler: alerts check failed for user ${ownerId}`, err)
    );
    await runMemoryReminderCheckForUser(ownerId).catch((err) =>
      console.error(`scheduler: memory reminder check failed for user ${ownerId}`, err)
    );
    await runReconciliationCheckForUser(ownerId).catch((err) =>
      console.error(`scheduler: reconciliation check failed for user ${ownerId}`, err)
    );
    await runImportantEmailAlertsCheckForUser(ownerId).catch((err) =>
      console.error(`scheduler: important-email check failed for user ${ownerId}`, err)
    );
  }
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
