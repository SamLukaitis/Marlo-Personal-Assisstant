import { hubListNewMessages, AUTOMATED_SENDER_PATTERN, senderDisplayName } from "./hub.js";
import { hasAlerted, markAlerted, getSetting, setSetting, listPhoneNumbersForUser } from "../db/store.js";
import { isWhatsAppConfigured } from "../providers/whatsapp.js";
import { sendProactiveMessage } from "./outbound.js";
import {
  isOnboardingSuppressionActive,
  incrementSuppressedOnboardingAlerts,
} from "./onboardingAlertSuppression.js";
import type { UnifiedMessage } from "../providers/types.js";

const MAX_ALERTS_PER_CHECK = 5;
const BASELINE_KEY = "alerts_baseline_set";

function messageKey(m: UnifiedMessage): string {
  return `${m.accountId}:${m.id}`;
}

async function notify(numbers: string[], text: string): Promise<void> {
  for (const number of numbers) {
    try {
      await sendProactiveMessage(number, text, "alert");
    } catch (err) {
      console.error("alerts: failed to send", err);
    }
  }
}

// Polls for unread mail from real people (not newsletters/notifications) and pings WhatsApp
// the moment one shows up, instead of waiting for the next day's briefing. Dedupes via a
// persisted ledger so the same message never triggers twice across restarts. Runs per-tenant —
// scheduler.ts loops over every user and calls this once per owner.
export async function checkForNewImportantMessages(ownerId: number): Promise<void> {
  const messages = await hubListNewMessages(ownerId);
  // Deliberately NOT gated on m.unread — a user who opens a real person's message the moment it
  // arrives (completely normal) must not lose the alert. hasAlerted's per-message ledger below is
  // the real "have we already handled this" check, independent of whether the user has read it;
  // unread was a redundant, strictly worse substitute that silently and permanently dropped any
  // message read before this scan ever saw it.
  const candidates = messages.filter((m) => m.from && !AUTOMATED_SENDER_PATTERN.test(m.from));

  // First-ever run: record the current inbox as a baseline instead of alerting on everything
  // that was already sitting there unread before this feature existed.
  if (getSetting(ownerId, BASELINE_KEY) !== "true") {
    for (const m of candidates) markAlerted(ownerId, messageKey(m));
    setSetting(ownerId, BASELINE_KEY, "true");
    return;
  }

  const unseen = candidates.filter((m) => !hasAlerted(ownerId, messageKey(m)));
  if (unseen.length === 0) return;
  if (!isWhatsAppConfigured()) return;

  const numbers = listPhoneNumbersForUser(ownerId).map((r) => r.phone);
  if (numbers.length === 0) return;

  // See importantEmailAlerts.ts's identical check for the full rationale: don't interleave
  // individual proactive alerts into the onboarding conversation itself. Still mark everything
  // seen so it's never re-alerted later — only the push is deferred and counted.
  if (isOnboardingSuppressionActive(ownerId)) {
    for (const m of unseen) markAlerted(ownerId, messageKey(m));
    incrementSuppressedOnboardingAlerts(ownerId, unseen.length);
    return;
  }

  const userName = getSetting(ownerId, "user_name");
  const greeting = userName ? `${userName}, ` : "";
  const toSend = unseen.slice(0, MAX_ALERTS_PER_CHECK);
  for (const m of toSend) {
    // Never the raw email address — senderDisplayName pulls a real name out of the From header
    // (or falls back to the address's local part) so this reads like a person telling you who
    // emailed, not a log line.
    await notify(
      numbers,
      `📬 ${greeting}${senderDisplayName(m.from)} emailed you: "${m.subject}"\n${m.snippet}`
    );
    markAlerted(ownerId, messageKey(m));
  }

  // A burst beyond the per-check cap gets one summary line instead of individually spamming.
  const rest = unseen.slice(MAX_ALERTS_PER_CHECK);
  if (rest.length > 0) {
    for (const m of rest) markAlerted(ownerId, messageKey(m));
    await notify(
      numbers,
      `...and ${rest.length} more new message${rest.length === 1 ? "" : "s"} that might need attention — check your inbox.`
    );
  }
}
