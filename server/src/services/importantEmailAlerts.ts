// server/src/services/importantEmailAlerts.ts
// Proactive classification of automated/transactional mail into a fixed category set that
// neither checkForNewImportantMessages (alerts.ts, real people only) nor
// checkNewEmailsAgainstRecentDocuments (reconciliation.ts, requires an already-saved document to
// match against) can catch. See
// docs/superpowers/specs/2026-08-26-important-email-alerts-design.md.

import {
  hubListNewMessages,
  hubListMessages,
  hubGetMessage,
  holdNewMessageCheckpoint,
  isAutomatedMail,
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
import { isPostConnectChainInProgress } from "./onboardingAlertSuppression.js";
import {
  classifyImportantEmails,
  CATEGORY_INFO,
  type ClassifyMatch,
  type ImportantEmailCategory,
} from "./importantEmailClassifier.js";
import { emailReferenceNote } from "./emailReference.js";
import { tidySnippet } from "./htmlToText.js";
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
// How far back the onboarding preview's own list reaches — only the last 24 hours of it is ever
// used (see isWithinOnboardingLookback), so this just needs to comfortably cover a busy day.
const ONBOARDING_LIST_LIMIT = 50;

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

// A one-time verification/login code must never be forwarded as an "important" alert — by the
// time a WhatsApp notification is read the code is typically already expired, and mistakenly
// relaying one reads as Marlowe leaking a security-sensitive code out of the user's inbox.
// Hardcoded and checked before anything reaches the classifier, same precedent as mentionsOwnApp
// above — this is not the model's call to make.
const VERIFICATION_CODE_PATTERN =
  /verification code|one-?time (code|password|passcode)|\botp\b|security code|confirmation code|access code|login code|auth(?:entication)? code|\bpasscode\b/i;

function isVerificationCode(m: UnifiedMessage): boolean {
  return VERIFICATION_CODE_PATTERN.test(`${m.subject} ${m.snippet}`);
}

// Shared by both the ongoing scheduler scan and the onboarding scan below.
function isImportantEmailCandidate(m: UnifiedMessage): boolean {
  return !!m.from && isAutomatedMail(m) && !mentionsOwnApp(m) && !isVerificationCode(m);
}

// The onboarding scan (see scanAndCurateImportantEmailsForOnboarding below) only ever flags mail
// that actually arrived in the 24 hours before connecting — a user's own feedback: surfacing a
// whole backlog of older "important-looking" automated mail the moment someone signs up reads as
// Marlowe spamming them with old mail, not as a useful finding. Older backlog is never classified
// or shown, and never alerted on later either (hub.ts's connected_at floor).
const ONBOARDING_LOOKBACK_MS = 24 * 60 * 60 * 1000;

function isWithinOnboardingLookback(m: UnifiedMessage): boolean {
  return Date.now() - new Date(m.receivedAt).getTime() < ONBOARDING_LOOKBACK_MS;
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
  const body = summary?.trim() || tidySnippet(m.snippet);
  const greeting = userName ? `${userName}, ` : "";
  return `${emoji} ${greeting}${body}`;
}

// Returns whether every registered number actually got the message — callers must only mark a
// message alerted when this is true. Same precedent as reminderScheduler.ts: a notification that
// fails to deliver must stay retriable, unlike alerts.ts's fire-and-forget notify() (acceptable
// there only because "another email will come"; not acceptable for a flight-cancellation alert).
// A retry skips numbers that already got this `itemKey` (see proactiveDelivery.ts).
function notifyAll(
  ownerId: number,
  itemKey: string,
  numbers: string[],
  text: string,
  historyNote?: string
): Promise<boolean> {
  return sendToAllNumbers(ownerId, itemKey, numbers, text, "alert", "importantEmailAlerts", historyNote);
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
  const candidates = messages.filter(isImportantEmailCandidate);

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

  // Never interleave alerts with postConnectSetup's own questions — hold everything (unmarked,
  // checkpoint held) until the chain's closing message has gone out, then alert as normal.
  if (isPostConnectChainInProgress(ownerId)) {
    holdNewMessageCheckpoint(ownerId);
    return;
  }

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

    const delivered = await notifyAll(ownerId, messageKey(m), numbers, text, emailReferenceNote(m));
    if (delivered) {
      markAlerted(ownerId, messageKey(m));
      saveFlaggedEmail(ownerId, m, match);
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
    // Marlowe offers to go through them itself rather than sending the user off to their inbox —
    // each is saved as a flagged email below, so list_flagged_emails can answer the follow-up.
    const summary = `I've also spotted ${rest.length} more important email${rest.length === 1 ? "" : "s"} — just ask and I'll run through ${rest.length === 1 ? "it" : "them"}.`;
    // Keyed on the exact set of emails it covers, so a retry of the same overflow skips numbers
    // that already have it.
    const overflowKey = `important-email-overflow:${createHash("sha256")
      .update(rest.map(({ m }) => messageKey(m)).sort().join("\n"))
      .digest("hex")}`;
    const delivered = await notifyAll(ownerId, overflowKey, numbers, summary);
    if (delivered) {
      for (const { m, match } of rest) {
        markAlerted(ownerId, messageKey(m));
        saveFlaggedEmail(ownerId, m, match);
      }
    } else {
      holdNewMessageCheckpoint(ownerId);
    }
  }
}

function saveFlaggedEmail(ownerId: number, m: UnifiedMessage, match: ClassifyMatch): void {
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

export interface OnboardingImportantEmailPreview {
  lines: string[];
  moreCount: number;
}

// Runs once, synchronously, at the exact moment a mailbox finishes connecting
// (postConnectSetup.ts's startPostConnectSetup) — the one scan that ever looks at pre-connect
// mail. Classifies only what arrived in the 24 hours before connecting (see
// isWithinOnboardingLookback) and returns a curated preview (the top ONBOARDING_PREVIEW_LIMIT by
// ONBOARDING_PREVIEW_CATEGORY_PRIORITY, plus a count of the rest) for the caller to fold into its
// own "Connected!" message. Never sends a WhatsApp message itself.
//
// Deliberately a plain list, not hubListNewMessages: the scheduler's scans never see pre-connect
// mail at all (hub.ts's connected_at floor), so there is no backlog to baseline here and no
// checkpoint to protect — and it must run even when this owner was already baselined by an
// earlier connection (replaying onboarding, reconnecting, adding a second mailbox), which is
// exactly when the old owner-level early return silently dropped the preview.
export async function scanAndCurateImportantEmailsForOnboarding(
  ownerId: number
): Promise<OnboardingImportantEmailPreview | null> {
  // The scheduler's first-run branch is for accounts that predate connected_at — a fresh
  // connection never needs it (hub.ts's floor already keeps pre-connect mail out). Settled first,
  // before any early return below: left unset, that branch would silently swallow the first
  // post-connect emails as "backlog" whenever this scan couldn't read the inbox.
  setSetting(ownerId, BASELINE_KEY, "true");

  let messages: UnifiedMessage[];
  try {
    messages = await hubListMessages(ownerId, { limit: ONBOARDING_LIST_LIMIT });
  } catch (err) {
    console.error(`importantEmailAlerts: onboarding scan failed to list messages for owner ${ownerId}`, err);
    return null;
  }
  // hub.ts swallows a per-account provider failure into an empty list, so an empty result can't
  // be told apart from "couldn't read the inbox" — return null (no claim) rather than let
  // postConnectSetup tell the user nothing is urgent. An empty result from here on means
  // "checked, nothing important".
  if (messages.length === 0) return null;

  const candidates = messages.filter(
    (m) => isImportantEmailCandidate(m) && isWithinOnboardingLookback(m) && !hasAlerted(ownerId, messageKey(m))
  );
  if (candidates.length === 0) return { lines: [], moreCount: 0 };

  let classified: Map<number, ClassifyMatch>;
  try {
    classified = await classifyImportantEmails(
      candidates.map((m, index) => ({ index, subject: m.subject, snippet: m.snippet })),
      ownerId
    );
  } catch (err) {
    console.error(`importantEmailAlerts: onboarding classification failed for owner ${ownerId}`, err);
    return null;
  }

  for (const m of candidates) markAlerted(ownerId, messageKey(m));

  const matches = candidates
    .map((m, index) => ({ m, match: classified.get(index) }))
    .filter((x): x is { m: UnifiedMessage; match: ClassifyMatch } => !!x.match);

  for (const { m, match } of matches) saveFlaggedEmail(ownerId, m, match);

  if (matches.length === 0) return { lines: [], moreCount: 0 };

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
