import { hubListNewMessages, isAutomatedMail, senderDisplayName } from "./hub.js";
import { hasAlerted, markAlerted, getSetting, setSetting, listPhoneNumbersForUser, listEntities } from "../db/store.js";
import { tidySnippet } from "./htmlToText.js";
import { triageRealPersonEmails } from "./realPersonTriage.js";
import { IMPORTANT_EMAIL_ENTITY_TYPE, type ImportantEmailEntityData } from "./importantEmailAlerts.js";
import { isWhatsAppConfigured } from "../providers/whatsapp.js";
import { sendProactiveMessage } from "./outbound.js";
import { emailReferenceNote } from "./emailReference.js";
import { realPersonAlertMode, realPersonAlertsEnabledSince } from "./emailAlertSettings.js";
import { queueForEmailDigest } from "./emailDigest.js";
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

async function notify(numbers: string[], text: string, historyNote?: string): Promise<void> {
  for (const number of numbers) {
    try {
      await sendProactiveMessage(number, text, "alert", historyNote);
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
  // One line per scan that saw any mail, naming the gate that decided its fate — "I emailed it and
  // got no alert" was undiagnosable while every gate below dropped mail without a trace. Counts
  // only, never subject/sender/snippet. Silent when nothing was fetched (the common quiet tick).
  const logScan = (outcome: string, unseen = 0): void => {
    if (messages.length === 0) return;
    console.log(
      `alerts: owner ${ownerId} ${outcome} (fetched ${messages.length}, real-person ${candidates.length}, unseen ${unseen})`
    );
  };
  // Deliberately NOT gated on m.unread — a user who opens a real person's message the moment it
  // arrives (completely normal) must not lose the alert. hasAlerted's per-message ledger below is
  // the real "have we already handled this" check, independent of whether the user has read it;
  // unread was a redundant, strictly worse substitute that silently and permanently dropped any
  // message read before this scan ever saw it.
  const candidates = messages.filter((m) => m.from && !isAutomatedMail(m));

  // First-ever run: record the current inbox as a baseline instead of alerting on everything
  // that was already sitting there unread before this feature existed.
  if (getSetting(ownerId, BASELINE_KEY) !== "true") {
    // Only mail from before the user switched alerts on is "already sitting there" — mail that
    // arrived after it (turning alerts on and immediately testing them) must fall through and
    // alert, not get swallowed as backlog. No timestamp (never switched on from off) baselines
    // everything, as before.
    const enabledAt = realPersonAlertsEnabledSince(ownerId);
    let baselined = 0;
    for (const m of candidates) {
      if (enabledAt === 0 || new Date(m.receivedAt).getTime() < enabledAt) {
        markAlerted(ownerId, messageKey(m));
        baselined++;
      }
    }
    setSetting(ownerId, BASELINE_KEY, "true");
    logScan(`first scan: baselined ${baselined} as existing mail`);
  }

  const unseen = candidates.filter((m) => !hasAlerted(ownerId, messageKey(m)));
  if (unseen.length === 0) {
    if (candidates.length === 0) logScan("no real-person mail (all automated or no sender)");
    else logScan("nothing new (already handled)");
    return;
  }
  if (!isWhatsAppConfigured()) {
    logScan("skipped: WhatsApp is not configured", unseen.length);
    return;
  }

  const numbers = listPhoneNumbersForUser(ownerId).map((r) => r.phone);
  if (numbers.length === 0) {
    logScan("skipped: no registered phone number", unseen.length);
    return;
  }

  // See importantEmailAlerts.ts's identical check for the full rationale: don't interleave
  // individual proactive alerts into the onboarding conversation itself. Still mark everything
  // seen so it's never re-alerted later — only the push is deferred and counted.
  if (isOnboardingSuppressionActive(ownerId)) {
    for (const m of unseen) markAlerted(ownerId, messageKey(m));
    incrementSuppressedOnboardingAlerts(ownerId, unseen.length);
    logScan(`suppressed by onboarding (${unseen.length} held for the summary, not sent)`, unseen.length);
    return;
  }

  const skips = await triageUnseen(ownerId, unseen);
  for (const m of unseen) if (skips.has(m)) markAlerted(ownerId, messageKey(m));
  const toAlert = unseen.filter((m) => !skips.has(m));
  if (toAlert.length === 0) {
    logScan(`skipped ${skips.size} (marketing or repeats an earlier alert)`, unseen.length);
    return;
  }

  // Digest mode: hold the email for emailDigest.ts's once-a-day summary instead of pinging now.
  // Marked alerted at once, same as a sent alert, so it can never be queued or sent twice.
  if (realPersonAlertMode(ownerId) === "digest") {
    queueForEmailDigest(ownerId, toAlert);
    for (const m of toAlert) markAlerted(ownerId, messageKey(m));
    logScan(`queued ${toAlert.length} for the digest${skips.size ? `, skipped ${skips.size}` : ""}`, unseen.length);
    return;
  }

  const userName = getSetting(ownerId, "user_name");
  const greeting = userName ? `${userName}, ` : "";
  const toSend = toAlert.slice(0, MAX_ALERTS_PER_CHECK);
  for (const m of toSend) {
    // Never the raw email address — senderDisplayName pulls a real name out of the From header
    // (or falls back to the address's local part) so this reads like a person telling you who
    // emailed, not a log line.
    await notify(
      numbers,
      `📬 ${greeting}${senderDisplayName(m.from)} emailed you: "${m.subject}"\n${tidySnippet(m.snippet)}`,
      emailReferenceNote(m)
    );
    markAlerted(ownerId, messageKey(m));
  }

  // A burst beyond the per-check cap gets one summary line instead of individually spamming.
  const rest = toAlert.slice(MAX_ALERTS_PER_CHECK);
  if (rest.length > 0) {
    for (const m of rest) markAlerted(ownerId, messageKey(m));
    await notify(
      numbers,
      `...and ${rest.length} more new message${rest.length === 1 ? "" : "s"} that might need attention — check your inbox.`
    );
  }
  logScan(
    `sent ${toSend.length}${rest.length ? ` + overflow summary for ${rest.length}` : ""}` +
      (skips.size ? `, skipped ${skips.size}` : ""),
    unseen.length
  );
}

const RECENT_ALERT_WINDOW_MS = 48 * 60 * 60 * 1000;
const MAX_RECENT_ALERTS = 15;

// Which of `unseen` should not alert (see realPersonTriage.ts), keyed by message. Fails open: if
// the model call breaks, every message alerts as it did before the triage existed. Runs after the
// deliverability and onboarding gates so it is only paid for when an alert is actually about to go.
async function triageUnseen(ownerId: number, unseen: UnifiedMessage[]): Promise<Set<UnifiedMessage>> {
  const skipped = new Set<UnifiedMessage>();
  const since = Date.now() - RECENT_ALERT_WINDOW_MS;
  const recentAlerts = listEntities<ImportantEmailEntityData>(ownerId, { type: IMPORTANT_EMAIL_ENTITY_TYPE })
    .filter((e) => e.createdAt >= since)
    .slice(0, MAX_RECENT_ALERTS)
    .map((e) => e.data.summary);
  try {
    const verdicts = await triageRealPersonEmails(
      unseen.map((m, index) => ({ index, from: m.from, subject: m.subject, snippet: m.snippet })),
      recentAlerts,
      ownerId
    );
    for (const index of verdicts.keys()) if (unseen[index]) skipped.add(unseen[index]);
  } catch (err) {
    console.error(`alerts: triage failed for owner ${ownerId}, alerting on everything`, err);
  }
  return skipped;
}
