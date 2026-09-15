// server/src/services/importantEmailAlerts.ts
// Proactive classification of automated/transactional mail into a fixed category set that
// neither checkForNewImportantMessages (alerts.ts, real people only) nor
// checkNewEmailsAgainstRecentDocuments (reconciliation.ts, requires an already-saved document to
// match against) can catch. See
// docs/superpowers/specs/2026-08-26-important-email-alerts-design.md.

import {
  hubListNewMessages,
  hubGetMessage,
  holdNewMessageCheckpoint,
  withMessageCache,
  AUTOMATED_SENDER_PATTERN,
} from "./hub.js";
import {
  hasAlerted,
  markAlerted,
  getSetting,
  setSetting,
  listPhoneNumbersForUser,
  saveEntity,
} from "../db/store.js";
import { isWhatsAppConfigured } from "../providers/whatsapp.js";
import { createHash } from "node:crypto";
import { sendToAllNumbers } from "./proactiveDelivery.js";
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

// Priority order for scanAndCurateImportantEmailsForOnboarding's preview — most-urgent-feeling
// first, so a security alert or government letter never gets buried behind a routine booking
// confirmation just because it happened to sort later in the inbox.
const ONBOARDING_PREVIEW_CATEGORY_PRIORITY: ImportantEmailCategory[] = [
  "security_alert",
  "government_mail",
  "flight_change",
  "reservation_confirmed",
  "invoice_due",
  "refund_dispute",
  "delivery_notification",
  "subscription_renewal",
];
const ONBOARDING_PREVIEW_LIMIT = 3;

// entities.type for a flagged email, stored the moment its alert is actually delivered — durable,
// queryable ground truth (via list_flagged_emails in assistant.ts) so the assistant can answer a
// later question about a flight change/invoice/etc. from the real classified data instead of its
// own prior paraphrase (or nothing at all, once that reply ages out of chat history). Never
// injected into the system prompt, so it costs nothing on turns that don't ask for it — same
// on-demand-tool-call cost as search_messages.
export const IMPORTANT_EMAIL_ENTITY_TYPE = "important_email";

export interface ImportantEmailEntityData {
  accountId: number;
  accountEmail: string;
  messageId: string;
  category: ImportantEmailCategory;
  subject: string;
  from: string;
  summary: string;
  receivedAt: string;
}

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

// No account email, sender address, raw subject, or category label in the visible text — those
// read as a machine-generated log line, not something a person would send. The classifier's
// summary (buildClassifyPrompt) is written to already be a complete, natural sentence with key
// specifics in *bold*, so it's the entire message body; this just adds the emoji and, when known,
// a name-first greeting ("Sam, ...") so it reads like a text from someone who knows the user.
export function formatImportantEmailAlert(
  m: UnifiedMessage,
  category: ImportantEmailCategory,
  userName: string | null,
  summary?: string
): string {
  const { emoji } = CATEGORY_INFO[category];
  // Prefer the model's plain-English summary over the raw snippet — the snippet is
  // HTML-entity-encoded and truncated mid-sentence straight from the Gmail/Graph API.
  const body = summary?.trim() || m.snippet;
  const greeting = userName ? `${userName}, ` : "";
  return `${emoji} ${greeting}${body}`;
}

// Returns whether every registered number actually got the message — callers must only mark a
// message alerted when this is true. Same precedent as memoryReminders.ts: a notification that
// fails to deliver must stay retriable, unlike alerts.ts's fire-and-forget notify() (acceptable
// there only because "another email will come"; not acceptable for a flight-cancellation alert).
// A retry skips numbers that already got this `itemKey` (see proactiveDelivery.ts).
function notifyAll(ownerId: number, itemKey: string, numbers: string[], text: string): Promise<boolean> {
  return sendToAllNumbers(ownerId, itemKey, numbers, text, "alert", "importantEmailAlerts");
}

// Runs on the existing 5-minute scheduler tick, sibling to checkForNewImportantMessages and
// checkNewEmailsAgainstRecentDocuments — but targets automated senders specifically (the inverse
// of checkForNewImportantMessages's filter), since that's exactly the mail those two miss.
//
// Known overlap: an email that both matches a saved document (reconciliation.ts) and a fixed
// category here can trigger two separate WhatsApp messages. Accepted for v1 — the two mechanisms
// are deliberately decoupled; revisit only if this proves annoying in practice.
export async function checkForImportantEmails(ownerId: number): Promise<void> {
  const messages = await hubListNewMessages(ownerId);
  // Deliberately NOT gated on m.unread — a user who opens a flight-booking/invoice notification
  // the moment it arrives (completely normal) must not lose the alert. hasAlerted's per-message
  // ledger below is the real "have we already handled this" check, independent of whether the
  // user has read it; unread was a redundant, strictly worse substitute that silently and
  // permanently dropped any message read before this scan ever saw it.
  const candidates = messages.filter(
    (m) => m.from && AUTOMATED_SENDER_PATTERN.test(m.from) && !mentionsOwnApp(m)
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
  // left unmarked, but the Gmail checkpoint is deliberately NOT held here: this isn't a transient
  // failure, and holding it would re-fetch the same growing window of mail on every tick.
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
    // Leave every candidate unscanned so the next tick retries classification — and hold the
    // Gmail checkpoint, or the next tick's incremental fetch would never list them again.
    holdNewMessageCheckpoint(ownerId);
    return;
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
  const userName = getSetting(ownerId, "user_name");
  // At most one invoice_due match per tick gets the "reply yes" offer — there's only one pending
  // confirmation slot per owner (see xeroInvoiceConfirmation.ts), by design, not an oversight.
  let offeredInvoiceConfirm = false;
  for (const { m, match } of toSend) {
    const { category, summary } = match;
    let text = formatImportantEmailAlert(m, category, userName, summary);
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

    const delivered = await notifyAll(ownerId, messageKey(m), numbers, text);
    if (delivered) {
      markAlerted(ownerId, messageKey(m));
      saveEntity<ImportantEmailEntityData>(ownerId, {
        type: IMPORTANT_EMAIL_ENTITY_TYPE,
        data: {
          accountId: m.accountId,
          accountEmail: m.accountEmail,
          messageId: m.id,
          category,
          subject: m.subject,
          from: m.from,
          summary: summary?.trim() || m.snippet,
          receivedAt: m.receivedAt,
        },
      });
      if (confirmable) {
        setPendingInvoiceForward(ownerId, confirmable);
        offeredInvoiceConfirm = true;
      }
    } else {
      holdNewMessageCheckpoint(ownerId); // left unmarked to retry — see the classification catch above
    }
  }

  const rest = matches.slice(MAX_ALERTS_PER_CHECK);
  if (rest.length > 0) {
    const summary = `...and ${rest.length} more important email${rest.length === 1 ? "" : "s"} — check your inbox.`;
    // Keyed on the exact set of emails it covers, so a retry of the same overflow skips numbers
    // that already have it.
    const overflowKey = `important-email-overflow:${createHash("sha256")
      .update(rest.map(({ m }) => messageKey(m)).sort().join("\n"))
      .digest("hex")}`;
    const delivered = await notifyAll(ownerId, overflowKey, numbers, summary);
    if (delivered) {
      for (const { m } of rest) markAlerted(ownerId, messageKey(m));
    } else {
      holdNewMessageCheckpoint(ownerId);
    }
  }
}

export interface OnboardingImportantEmailPreview {
  lines: string[];
  moreCount: number;
}

// Runs once, synchronously, at the exact moment a mailbox finishes connecting
// (postConnectSetup.ts's startPostConnectSetup) — classifies the CURRENT inbox backlog right
// then and there, baselines every candidate found (matched or not) so checkForImportantEmails's
// own scheduler-driven scan never re-examines or re-alerts on any of it, and returns a curated
// preview (the top ONBOARDING_PREVIEW_LIMIT by ONBOARDING_PREVIEW_CATEGORY_PRIORITY, plus a count
// of the rest) for the caller to fold into its own "Connected!" message. Never sends a WhatsApp
// message itself — sending is entirely the caller's job.
//
// This is what makes the *first* scan happen at a deterministic, known-good moment instead of
// whenever the next 5-minute scheduler tick happens to land, which was a real, reported bug (see
// onboardingAlertSuppression.ts's module comment) — alerts.ts/reconciliation.ts still rely on
// that grace-period approach since neither has a classifier to curate a preview from.
export function scanAndCurateImportantEmailsForOnboarding(
  ownerId: number
): Promise<OnboardingImportantEmailPreview | null> {
  // Its own message scope, so the Gmail checkpoint isn't saved until this scan has handled the
  // backlog (and can be held if classification fails) — see hub.ts's withMessageCache.
  return withMessageCache(() => scanAndCurateImportantEmailsForOnboardingInScope(ownerId));
}

async function scanAndCurateImportantEmailsForOnboardingInScope(
  ownerId: number
): Promise<OnboardingImportantEmailPreview | null> {
  // Already baselined (e.g. a scheduler tick somehow beat this call to it) — nothing left for a
  // one-time onboarding preview to do; the scheduler's own scan is now the source of truth.
  if (getSetting(ownerId, BASELINE_KEY) === "true") return null;

  let messages: UnifiedMessage[];
  try {
    messages = await hubListNewMessages(ownerId);
  } catch (err) {
    console.error(`importantEmailAlerts: onboarding scan failed to list messages for owner ${ownerId}`, err);
    // BASELINE_KEY stays unset — checkForImportantEmails's own first-run branch still covers
    // this account's very first scheduler tick, just silently (no curated preview), same as
    // before this feature existed.
    return null;
  }
  const candidates = messages.filter(
    (m) => m.from && AUTOMATED_SENDER_PATTERN.test(m.from) && !mentionsOwnApp(m)
  );

  // This scan IS the baseline, regardless of whether anything below actually matches — set it
  // now so checkForImportantEmails's own first-run branch is never reached for this owner again;
  // from here on its `unscanned` filter sees only genuinely new mail.
  setSetting(ownerId, BASELINE_KEY, "true");
  if (candidates.length === 0) return null;

  let classified: Map<number, ClassifyMatch>;
  try {
    classified = await classifyImportantEmails(
      candidates.map((m, index) => ({ index, subject: m.subject, snippet: m.snippet })),
      ownerId
    );
  } catch (err) {
    console.error(`importantEmailAlerts: onboarding classification failed for owner ${ownerId}`, err);
    // Candidates deliberately stay unmarked even though BASELINE_KEY is now true —
    // checkForImportantEmails's `unscanned` filter will pick every one of them straight back up
    // on its first tick and classify+alert normally, same as any other new mail. Losing the
    // one-time curated preview here is acceptable; losing the alerts entirely would not be — hence
    // holding the Gmail checkpoint, without which that next tick would never list them.
    holdNewMessageCheckpoint(ownerId);
    return null;
  }

  for (let i = 0; i < candidates.length; i++) {
    if (!classified.has(i)) markAlerted(ownerId, messageKey(candidates[i]));
  }

  const matches = candidates
    .map((m, index) => ({ m, match: classified.get(index) }))
    .filter((x): x is { m: UnifiedMessage; match: ClassifyMatch } => !!x.match);

  for (const { m, match } of matches) {
    markAlerted(ownerId, messageKey(m));
    saveEntity<ImportantEmailEntityData>(ownerId, {
      type: IMPORTANT_EMAIL_ENTITY_TYPE,
      data: {
        accountId: m.accountId,
        accountEmail: m.accountEmail,
        messageId: m.id,
        category: match.category,
        subject: m.subject,
        from: m.from,
        summary: match.summary?.trim() || m.snippet,
        receivedAt: m.receivedAt,
      },
    });
  }

  if (matches.length === 0) return null;

  const sorted = [...matches].sort(
    (a, b) =>
      ONBOARDING_PREVIEW_CATEGORY_PRIORITY.indexOf(a.match.category) -
      ONBOARDING_PREVIEW_CATEGORY_PRIORITY.indexOf(b.match.category)
  );
  const shown = sorted.slice(0, ONBOARDING_PREVIEW_LIMIT);
  const lines = shown.map(({ m, match }) => {
    const { emoji } = CATEGORY_INFO[match.category];
    return `${emoji} ${match.summary?.trim() || m.snippet}`;
  });

  return { lines, moreCount: matches.length - shown.length };
}
