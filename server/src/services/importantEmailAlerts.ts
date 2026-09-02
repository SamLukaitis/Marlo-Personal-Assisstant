// server/src/services/importantEmailAlerts.ts
// Proactive classification of automated/transactional mail into a fixed category set that
// neither checkForNewImportantMessages (alerts.ts, real people only) nor
// checkNewEmailsAgainstRecentDocuments (reconciliation.ts, requires an already-saved document to
// match against) can catch. See
// docs/superpowers/specs/2026-08-26-important-email-alerts-design.md.

import { hubListMessages, hubGetMessage, AUTOMATED_SENDER_PATTERN } from "./hub.js";
import { hasAlerted, markAlerted, getSetting, setSetting, listPhoneNumbersForUser } from "../db/store.js";
import { isWhatsAppConfigured } from "../providers/whatsapp.js";
import { sendProactiveMessage } from "./outbound.js";
import {
  classifyImportantEmails,
  CATEGORY_INFO,
  type ClassifyMatch,
  type ImportantEmailCategory,
} from "./importantEmailClassifier.js";
import { getXeroForwardingEmail } from "./xero.js";
import { setPendingInvoiceForward } from "./xeroInvoiceConfirmation.js";
import type { UnifiedMessage } from "../providers/types.js";

const MAX_ALERTS_PER_CHECK = 5;
const BASELINE_KEY = "important_email_baseline_set";

// Google/Microsoft send an automated "an app was granted access to your account" notification
// every time the user connects (or reconnects) their mailbox — including to Marlowe itself during
// onboarding. That's expected, self-caused, and not a security event, but the classifier only
// sees a subject/snippet and has no way to know "marlowe.up.railway.app" in one of those refers to
// us rather than some other third-party app, so it reads exactly like a real new-sign-in alert
// (security_alert's own description: "new sign-in, password changed, suspicious activity").
// Filtered out here, before candidates ever reach the classifier — cheap and deterministic, same
// precedent as the isWhatsAppConfigured/numbers.length gates below. Read directly from the env
// var (not config.ts's SERVER_URL) so it reflects whatever's current at call time.
function ownAppHost(): string | null {
  try {
    return new URL(process.env.SERVER_URL ?? "http://localhost:4000").hostname.toLowerCase();
  } catch {
    return null;
  }
}

function mentionsOwnApp(m: UnifiedMessage): boolean {
  const host = ownAppHost();
  if (!host) return false;
  return `${m.subject} ${m.snippet}`.toLowerCase().includes(host);
}

// Namespaced so this ledger entry can never collide with alerts.ts's bare `${accountId}:${id}`
// key on the same alerted_messages table — the two features filter for opposite sender types
// today (real people vs. automated), but the prefix keeps that true by construction, not by
// coincidence, and also keeps clear of reconciliation.ts's `recon-match:`/`recon-scan:` prefixes.
function messageKey(m: UnifiedMessage): string {
  return `important-email:${m.accountId}:${m.id}`;
}

export function formatImportantEmailAlert(
  m: UnifiedMessage,
  category: ImportantEmailCategory,
  summary?: string
): string {
  const { emoji, label } = CATEGORY_INFO[category];
  // Prefer the model's plain-English summary over the raw snippet — the snippet is
  // HTML-entity-encoded and truncated mid-sentence straight from the Gmail/Graph API.
  const body = summary?.trim() || m.snippet;
  return `${emoji} ${label}: "${m.subject}" from ${m.from}\n${body}`;
}

// Returns whether every registered number actually got the message — callers must only mark a
// message alerted when this is true. Same precedent as memoryReminders.ts: a notification that
// fails to deliver must stay retriable, unlike alerts.ts's fire-and-forget notify() (acceptable
// there only because "another email will come"; not acceptable for a flight-cancellation alert).
async function notifyAll(numbers: string[], text: string): Promise<boolean> {
  let allSucceeded = true;
  for (const number of numbers) {
    try {
      await sendProactiveMessage(number, text, "alert");
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
//
// Known overlap: an email that both matches a saved document (reconciliation.ts) and a fixed
// category here can trigger two separate WhatsApp messages. Accepted for v1 — the two mechanisms
// are deliberately decoupled; revisit only if this proves annoying in practice.
export async function checkForImportantEmails(ownerId: number): Promise<void> {
  const messages = await hubListMessages(ownerId, { limit: 50 });
  const candidates = messages.filter(
    (m) => m.unread && m.from && AUTOMATED_SENDER_PATTERN.test(m.from) && !mentionsOwnApp(m)
  );

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

  // Cheap deliverability gates before the paid classification call, same precedent as alerts.ts
  // and reconciliation.ts — this feature is on by default, so every deployment without WhatsApp
  // configured (or every user with no registered numbers) must not pay for classification on
  // every tick, forever, for a message that can never be delivered. `unscanned` candidates are
  // left unmarked/retriable, same as today.
  if (!isWhatsAppConfigured()) return;
  const numbers = listPhoneNumbersForUser(ownerId).map((r) => r.phone);
  if (numbers.length === 0) return;

  let classified: Map<number, ClassifyMatch>;
  try {
    classified = await classifyImportantEmails(
      unscanned.map((m, index) => ({ index, subject: m.subject, snippet: m.snippet })),
      ownerId
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
    .map((m, index) => ({ m, match: classified.get(index) }))
    .filter((x): x is { m: UnifiedMessage; match: ClassifyMatch } => !!x.match);
  if (matches.length === 0) return;

  const toSend = matches.slice(0, MAX_ALERTS_PER_CHECK);
  // At most one invoice_due match per tick gets the "reply yes" offer — there's only one pending
  // confirmation slot per owner (see xeroInvoiceConfirmation.ts), by design, not an oversight.
  let offeredInvoiceConfirm = false;
  for (const { m, match } of toSend) {
    const { category, summary } = match;
    let text = formatImportantEmailAlert(m, category, summary);
    let confirmable: { accountId: number; messageId: string; subject: string } | null = null;

    if (category === "invoice_due" && !offeredInvoiceConfirm && getXeroForwardingEmail(ownerId)) {
      const full = await hubGetMessage(ownerId, m.accountId, m.id).catch(() => null);
      // An attachment or a real body is enough to offer — respond_to_invoice_forward_prompt
      // handles both (ingestEmailAttachment for the former, ingestEmailBodyReceipt for a
      // plain-text receipt with no attachment, e.g. a subscription renewal notice).
      if (full?.attachments?.length || full?.body?.trim()) {
        confirmable = { accountId: m.accountId, messageId: m.id, subject: m.subject };
        text += `\n\nReply "yes" and I'll forward it to Xero.`;
      }
    }

    const delivered = await notifyAll(numbers, text);
    if (delivered) {
      markAlerted(ownerId, messageKey(m));
      if (confirmable) {
        setPendingInvoiceForward(ownerId, confirmable);
        offeredInvoiceConfirm = true;
      }
    }
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
