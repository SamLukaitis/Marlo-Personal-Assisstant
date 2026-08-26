import { getBriefingSettings, getTodaysBriefing } from "./briefing.js";
import {
  getSetting,
  setSetting,
  listPhoneNumbersForUser,
  listAllCheckinsAscending,
  listAllUserIds,
  getEnabledTools,
} from "../db/store.js";
import { sendWhatsAppMessage, isWhatsAppConfigured } from "../providers/whatsapp.js";
import { countTravelDays } from "./travelDays.js";
import { checkForNewImportantMessages } from "./alerts.js";
import { checkNewEmailsAgainstRecentDocuments } from "./reconciliation.js";
import { checkDueMemoryReminders } from "./memoryReminders.js";

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const SCHENGEN_WARN_AT = 80;
const SCHENGEN_LIMIT = 90;

function todayKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate()
  ).padStart(2, "0")}`;
}

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
      await sendWhatsAppMessage(number, message);
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

// Loops over every tenant rather than assuming a single global run — each user's iteration is
// caught independently so one tenant's failure (a broken account, a transient API error) can't
// block or crash another tenant's briefing/alerts.
async function tick(): Promise<void> {
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
  }
}

export function startScheduler(): void {
  tick();
  setInterval(tick, CHECK_INTERVAL_MS);
}
