// Cross-referencing between saved documents and email — see
// docs/superpowers/specs/2026-08-24-document-email-cross-referencing-design.md for the full
// design and why this stays entirely deterministic in v1 (no LLM call on the email side at all).

import { hubListMessages, hubListNewMessages } from "./hub.js";
import { isWhatsAppConfigured } from "../providers/whatsapp.js";
import { sendProactiveMessage } from "./outbound.js";
import { hasAlerted, markAlerted, listPhoneNumbersForUser, listRecentMatchKeys } from "../db/store.js";
import type { UnifiedMessage } from "../providers/types.js";

export interface MatchKeys {
  referenceCode?: string;
  flightNumber?: string;
  vendor?: string;
  eventDate?: string;
}

// Below this length, a substring match against free-text email content is too likely to be a
// coincidence (e.g. a 3-character flight number like "AA1" appearing in unrelated text) —
// accepting some missed short-identifier matches in exchange for far fewer false positives.
const MIN_IDENTIFIER_LENGTH = 4;

// Raised from 50 → 150 (2026-08-26): 50 was too shallow to catch older confirmation emails (e.g.
// a hostel booking from weeks before a trip actually starts) — see
// docs/superpowers/specs/2026-08-26-email-search-depth-and-attachment-extraction-design.md. This
// runs unattended on scheduler.ts's 5-minute tick, so the number is picked to bound the added
// Gmail/Graph API load per tick, not just to match search_messages' one-off cost.
export const RECONCILIATION_SCAN_LIMIT = 150;

// v1 ships strong-tier matching only (see the design doc) — this only ever compares a document's
// structured keys against a raw text blob (an email's subject + snippet), never two structured
// MatchKeys objects against each other, since email never gets its own LLM extraction call in
// this version. Returns "strong" | null; a "weak" tier is deliberately not implemented yet.
export function matchTier(keys: MatchKeys, text: string): "strong" | null {
  const haystack = text.toLowerCase();

  if (keys.referenceCode && keys.referenceCode.length >= MIN_IDENTIFIER_LENGTH) {
    if (haystack.includes(keys.referenceCode.toLowerCase())) return "strong";
  }
  if (keys.flightNumber && keys.flightNumber.length >= MIN_IDENTIFIER_LENGTH) {
    if (haystack.includes(keys.flightNumber.toLowerCase())) return "strong";
  }
  return null;
}

export function buildMatchNotification(docTitle: string, keys: MatchKeys, accountEmail?: string): string {
  const identifier = keys.referenceCode ?? keys.flightNumber ?? "";
  const datePart = keys.eventDate ? `, ${keys.eventDate}` : "";
  const prefix = accountEmail ? `[${accountEmail}] ` : "";
  return `${prefix}📎 Heads up — an email about "${docTitle}" (${identifier}${datePart}) just came in. Worth a look?`;
}

const MAX_MATCH_NOTIFICATIONS_PER_RUN = 3;

// Returns whether the notification was actually delivered to every registered number — callers
// must only mark a match as alerted when this is true, since a match that failed to deliver
// needs to stay eligible to be found again rather than being silently and permanently discarded.
async function notifyMatch(ownerId: number, text: string): Promise<boolean> {
  if (!isWhatsAppConfigured()) return false;
  const numbers = listPhoneNumbersForUser(ownerId).map((r) => r.phone);
  if (numbers.length === 0) return false;

  let allSucceeded = true;
  for (const number of numbers) {
    try {
      await sendProactiveMessage(number, text, "alert");
    } catch (err) {
      console.error("reconciliation: failed to send match notification", err);
      allSucceeded = false;
    }
  }
  return allSucceeded;
}

// Runs synchronously right after a document saves (see documents.ts) — checks the new
// document's own identifiers against a bounded window of recent mail. No LLM call: a reference
// code or flight number is specific enough that finding it verbatim in a subject/snippet is
// already a strong match.
export async function checkDocumentAgainstRecentEmails(
  ownerId: number,
  documentId: number,
  docTitle: string,
  keys: MatchKeys
): Promise<void> {
  if (!keys.referenceCode && !keys.flightNumber) return; // nothing strong-tier-checkable in v1

  let messages: UnifiedMessage[];
  try {
    messages = await hubListMessages(ownerId, { limit: RECONCILIATION_SCAN_LIMIT });
  } catch (err) {
    console.error(`reconciliation: failed to list messages for owner ${ownerId}`, err);
    return;
  }

  let sent = 0;
  for (const m of messages) {
    if (sent >= MAX_MATCH_NOTIFICATIONS_PER_RUN) break;

    const text = `${m.subject} ${m.snippet}`;
    if (matchTier(keys, text) !== "strong") continue;

    const matchKey = `recon-match:${documentId}:${m.accountId}:${m.id}`;
    if (hasAlerted(ownerId, matchKey)) continue;

    const delivered = await notifyMatch(ownerId, buildMatchNotification(docTitle, keys, m.accountEmail));
    if (!delivered) continue; // leave this match retriable — don't mark or count it

    markAlerted(ownerId, matchKey);
    sent += 1;
  }
}

const RECENT_DOCUMENT_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_MATCH_NOTIFICATIONS_PER_TICK = 5;

function scanKey(m: UnifiedMessage): string {
  return `recon-scan:${m.accountId}:${m.id}`;
}

// Runs on the existing 5-minute scheduler tick (scheduler.ts), sibling to
// checkForNewImportantMessages — but deliberately unfiltered by AUTOMATED_SENDER_PATTERN, since
// an automated airline/vendor notice is exactly what this is meant to catch.
export async function checkNewEmailsAgainstRecentDocuments(ownerId: number): Promise<void> {
  // Cheap early-return before paying for a mail-provider API call: a user with zero indexed
  // documents in the window can never match anything. Deliberately no separate opt-out setting
  // for this check (unlike the other two scheduler checks) — this is the intended low-blast-
  // radius gate for now.
  const recentKeys = listRecentMatchKeys(ownerId, Date.now() - RECENT_DOCUMENT_WINDOW_MS);
  if (recentKeys.length === 0) return;

  let messages: UnifiedMessage[];
  try {
    // Unlike checkDocumentAgainstRecentEmails above (which needs the CURRENT recent-mail window,
    // since it's checking one just-saved document against mail that may have arrived any time in
    // that window), this runs on the scheduler tick and already only acts on messages it hasn't
    // scanned before (the unscanned filter below) — genuinely "what's new since last check", so
    // it shares the same incremental fetch as alerts.ts/importantEmailAlerts.ts.
    messages = await hubListNewMessages(ownerId);
  } catch (err) {
    console.error(`reconciliation: failed to list messages for owner ${ownerId}`, err);
    return;
  }

  const unscanned = messages.filter((m) => !hasAlerted(ownerId, scanKey(m)));
  if (unscanned.length === 0) return;

  let sent = 0;
  for (const m of unscanned) {
    // Once the per-tick cap is hit, stop entirely rather than continuing — the remaining
    // messages haven't been examined at all, so they must stay unscanned to get a fair chance
    // on the next tick instead of being silently marked-and-dropped.
    if (sent >= MAX_MATCH_NOTIFICATIONS_PER_TICK) break;

    const text = `${m.subject} ${m.snippet}`;
    // Tracks whether any candidate document matched this email but failed to deliver — if so,
    // this email must stay unscanned so it's re-examined (and retried) on the next tick, even
    // though other candidates for the same email may have matched and delivered fine.
    let hadUndeliveredMatch = false;

    for (const row of recentKeys) {
      const keys: MatchKeys = {
        referenceCode: row.referenceCode ?? undefined,
        flightNumber: row.flightNumber ?? undefined,
        vendor: row.vendor ?? undefined,
        eventDate: row.eventDate ?? undefined,
      };
      if (matchTier(keys, text) !== "strong") continue;

      const matchKey = `recon-match:${row.documentId}:${m.accountId}:${m.id}`;
      if (hasAlerted(ownerId, matchKey)) continue;

      const delivered = await notifyMatch(
        ownerId,
        buildMatchNotification(row.docTitle ?? "a saved document", keys, m.accountEmail)
      );
      if (!delivered) {
        hadUndeliveredMatch = true;
        continue; // leave this match retriable — don't mark or count it, but still check other candidates
      }

      markAlerted(ownerId, matchKey);
      sent += 1;
      break; // one matching document is enough for this email
    }

    // Mark scanned only once this email has been fully examined AND every match found for it
    // (if any) was successfully delivered. A match that failed to deliver must keep the email
    // eligible for re-examination on a later tick — otherwise the scan-key filter above would
    // make that match permanently unreachable, defeating the retriable-match guarantee entirely.
    if (!hadUndeliveredMatch) {
      markAlerted(ownerId, scanKey(m));
    }
  }
}
