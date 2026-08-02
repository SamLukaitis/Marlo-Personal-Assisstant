import { getBriefingSettings, getTodaysBriefing } from "./briefing.js";
import {
  getSetting,
  setSetting,
  getWhatsAppAllowedNumbers,
  listAllCheckinsAscending,
} from "../db/store.js";
import { sendWhatsAppMessage, isWhatsAppConfigured } from "../providers/whatsapp.js";
import { countTravelDays } from "./travelDays.js";
import { checkForNewImportantMessages } from "./alerts.js";

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

function schengenAlertLine(): string | null {
  const now = Date.now();
  const sinceMs = now - 180 * 24 * 60 * 60 * 1000;
  const result = countTravelDays(listAllCheckinsAscending(), "schengen", sinceMs, now);
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
async function runDailyCheck(): Promise<void> {
  const settings = getBriefingSettings();
  if (!settings.proactive) return;
  if (getSetting("last_proactive_send_date") === todayKey()) return;
  if (currentHHMM() < settings.sendTime) return;

  if (!isWhatsAppConfigured()) {
    console.warn(
      "scheduler: proactive briefing is enabled but WhatsApp isn't configured — skipping"
    );
    setSetting("last_proactive_send_date", todayKey());
    return;
  }

  const numbers = getWhatsAppAllowedNumbers();
  if (numbers.length === 0) {
    console.warn(
      "scheduler: proactive briefing is enabled but no WhatsApp numbers are allowed — skipping"
    );
    setSetting("last_proactive_send_date", todayKey());
    return;
  }

  try {
    const briefing = await getTodaysBriefing();
    const alert = schengenAlertLine();
    const message = alert ? `${briefing.content}\n\n${alert}` : briefing.content;
    for (const number of numbers) {
      await sendWhatsAppMessage(number, message);
    }
    setSetting("last_proactive_send_date", todayKey());
  } catch (err) {
    console.error("scheduler: failed to send proactive briefing", err);
  }
}

async function runAlertsCheck(): Promise<void> {
  if (getSetting("realtime_alerts_enabled") !== "true") return;
  try {
    await checkForNewImportantMessages();
  } catch (err) {
    console.error("scheduler: alerts check failed", err);
  }
}

async function tick(): Promise<void> {
  await runDailyCheck().catch((err) => console.error("scheduler: daily check failed", err));
  await runAlertsCheck();
}

export function startScheduler(): void {
  tick();
  setInterval(tick, CHECK_INTERVAL_MS);
}
