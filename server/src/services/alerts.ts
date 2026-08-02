import { hubListMessages, AUTOMATED_SENDER_PATTERN } from "./hub.js";
import {
  hasAlerted,
  markAlerted,
  getSetting,
  setSetting,
  getWhatsAppAllowedNumbers,
} from "../db/store.js";
import { sendWhatsAppMessage, isWhatsAppConfigured } from "../providers/whatsapp.js";
import type { UnifiedMessage } from "../providers/types.js";

const MAX_ALERTS_PER_CHECK = 5;
const BASELINE_KEY = "alerts_baseline_set";

function messageKey(m: UnifiedMessage): string {
  return `${m.accountId}:${m.id}`;
}

async function notify(numbers: string[], text: string): Promise<void> {
  for (const number of numbers) {
    try {
      await sendWhatsAppMessage(number, text);
    } catch (err) {
      console.error("alerts: failed to send", err);
    }
  }
}

// Polls for unread mail from real people (not newsletters/notifications) and pings WhatsApp
// the moment one shows up, instead of waiting for the next day's briefing. Dedupes via a
// persisted ledger so the same message never triggers twice across restarts.
export async function checkForNewImportantMessages(): Promise<void> {
  const messages = await hubListMessages({ limit: 50 });
  const candidates = messages.filter(
    (m) => m.unread && m.from && !AUTOMATED_SENDER_PATTERN.test(m.from)
  );

  // First-ever run: record the current inbox as a baseline instead of alerting on everything
  // that was already sitting there unread before this feature existed.
  if (getSetting(BASELINE_KEY) !== "true") {
    for (const m of candidates) markAlerted(messageKey(m));
    setSetting(BASELINE_KEY, "true");
    return;
  }

  const unseen = candidates.filter((m) => !hasAlerted(messageKey(m)));
  if (unseen.length === 0) return;
  if (!isWhatsAppConfigured()) return;

  const numbers = getWhatsAppAllowedNumbers();
  if (numbers.length === 0) return;

  const toSend = unseen.slice(0, MAX_ALERTS_PER_CHECK);
  for (const m of toSend) {
    await notify(
      numbers,
      `📬 New message that might need attention:\n"${m.subject}" from ${m.from}\n${m.snippet}`
    );
    markAlerted(messageKey(m));
  }

  // A burst beyond the per-check cap gets one summary line instead of individually spamming.
  const rest = unseen.slice(MAX_ALERTS_PER_CHECK);
  if (rest.length > 0) {
    for (const m of rest) markAlerted(messageKey(m));
    await notify(
      numbers,
      `...and ${rest.length} more new message${rest.length === 1 ? "" : "s"} that might need attention — check your inbox.`
    );
  }
}
