// server/src/services/importantEmailAlerts.ts
// Proactive classification of automated/transactional mail into a fixed category set that
// neither checkForNewImportantMessages (alerts.ts, real people only) nor
// checkNewEmailsAgainstRecentDocuments (reconciliation.ts, requires an already-saved document to
// match against) can catch. See
// docs/superpowers/specs/2026-08-26-important-email-alerts-design.md.

import { hubListMessages, AUTOMATED_SENDER_PATTERN } from "./hub.js";
import { hasAlerted, markAlerted, getSetting, setSetting, listPhoneNumbersForUser } from "../db/store.js";
import { sendWhatsAppMessage, isWhatsAppConfigured } from "../providers/whatsapp.js";
import { classifyImportantEmails, CATEGORY_INFO, type ImportantEmailCategory } from "./importantEmailClassifier.js";
import type { UnifiedMessage } from "../providers/types.js";

const MAX_ALERTS_PER_CHECK = 5;
const BASELINE_KEY = "important_email_baseline_set";

// Namespaced so this ledger entry can never collide with alerts.ts's bare `${accountId}:${id}`
// key on the same alerted_messages table — the two features filter for opposite sender types
// today (real people vs. automated), but the prefix keeps that true by construction, not by
// coincidence, and also keeps clear of reconciliation.ts's `recon-match:`/`recon-scan:` prefixes.
function messageKey(m: UnifiedMessage): string {
  return `important-email:${m.accountId}:${m.id}`;
}

export function formatImportantEmailAlert(m: UnifiedMessage, category: ImportantEmailCategory): string {
  const { emoji, label } = CATEGORY_INFO[category];
  return `${emoji} ${label}: "${m.subject}" from ${m.from}\n${m.snippet}`;
}

// Returns whether every registered number actually got the message — callers must only mark a
// message alerted when this is true. Same precedent as memoryReminders.ts: a notification that
// fails to deliver must stay retriable, unlike alerts.ts's fire-and-forget notify() (acceptable
// there only because "another email will come"; not acceptable for a flight-cancellation alert).
async function notifyAll(numbers: string[], text: string): Promise<boolean> {
  let allSucceeded = true;
  for (const number of numbers) {
    try {
      await sendWhatsAppMessage(number, text);
    } catch (err) {
      console.error("importantEmailAlerts: failed to send", err);
      allSucceeded = false;
    }
  }
  return allSucceeded;
}

// Runs on the existing 5-minute scheduler tick, sibling to checkForNewImportantMessages and
// checkNewEmailsAgainstRecentDocuments — but targets automated senders specifically (the inverse
// of checkForNewImportantMessages's filter), since that's exactly the mail those two miss.
export async function checkForImportantEmails(ownerId: number): Promise<void> {
  const messages = await hubListMessages(ownerId, { limit: 50 });
  const candidates = messages.filter((m) => m.unread && m.from && AUTOMATED_SENDER_PATTERN.test(m.from));

  // First-ever run: baseline the current inbox instead of alerting on everything already sitting
  // there — same precedent as alerts.ts's BASELINE_KEY, doubly important here since this feature
  // ships on by default.
  if (getSetting(ownerId, BASELINE_KEY) !== "true") {
    for (const m of candidates) markAlerted(ownerId, messageKey(m));
    setSetting(ownerId, BASELINE_KEY, "true");
    return;
  }

  const unscanned = candidates.filter((m) => !hasAlerted(ownerId, messageKey(m)));
  if (unscanned.length === 0) return;

  let classified: Map<number, ImportantEmailCategory>;
  try {
    classified = await classifyImportantEmails(
      unscanned.map((m, index) => ({ index, subject: m.subject, snippet: m.snippet }))
    );
  } catch (err) {
    console.error(`importantEmailAlerts: classification failed for owner ${ownerId}`, err);
    return; // leave every candidate unscanned so the next tick retries classification
  }

  // A non-match has been fully examined and settled — mark it scanned now so it isn't
  // reclassified every tick. A match stays unmarked until it's actually delivered, below.
  for (let i = 0; i < unscanned.length; i++) {
    if (!classified.has(i)) markAlerted(ownerId, messageKey(unscanned[i]));
  }

  const matches = unscanned
    .map((m, index) => ({ m, category: classified.get(index) }))
    .filter((x): x is { m: UnifiedMessage; category: ImportantEmailCategory } => !!x.category);
  if (matches.length === 0) return;

  if (!isWhatsAppConfigured()) return; // matches stay unscanned, retried next tick
  const numbers = listPhoneNumbersForUser(ownerId).map((r) => r.phone);
  if (numbers.length === 0) return; // matches stay unscanned, retried next tick

  const toSend = matches.slice(0, MAX_ALERTS_PER_CHECK);
  for (const { m, category } of toSend) {
    const delivered = await notifyAll(numbers, formatImportantEmailAlert(m, category));
    if (delivered) markAlerted(ownerId, messageKey(m));
  }

  const rest = matches.slice(MAX_ALERTS_PER_CHECK);
  if (rest.length > 0) {
    const summary = `...and ${rest.length} more important email${rest.length === 1 ? "" : "s"} — check your inbox.`;
    const delivered = await notifyAll(numbers, summary);
    if (delivered) {
      for (const { m } of rest) markAlerted(ownerId, messageKey(m));
    }
  }
}
