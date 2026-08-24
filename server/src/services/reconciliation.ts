// Cross-referencing between saved documents and email — see
// docs/superpowers/specs/2026-08-24-document-email-cross-referencing-design.md for the full
// design and why this stays entirely deterministic in v1 (no LLM call on the email side at all).

import { hubListMessages } from "./hub.js";
import { sendWhatsAppMessage, isWhatsAppConfigured } from "../providers/whatsapp.js";
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

export function buildMatchNotification(docTitle: string, keys: MatchKeys): string {
  const identifier = keys.referenceCode ?? keys.flightNumber ?? "";
  const datePart = keys.eventDate ? `, ${keys.eventDate}` : "";
  return `📎 Heads up — an email about "${docTitle}" (${identifier}${datePart}) just came in. Worth a look?`;
}

const MAX_MATCH_NOTIFICATIONS_PER_RUN = 3;

// Returns whether the notification was actually delivered to every registered number — the
// caller (checkDocumentAgainstRecentEmails) must only mark a match as alerted when this is true,
// since a match that failed to deliver needs to stay eligible to be found again rather than
// being silently and permanently discarded. Same "all must succeed" bar as memoryReminders.ts
// uses for the same reason.
async function notifyMatch(ownerId: number, text: string): Promise<boolean> {
  if (!isWhatsAppConfigured()) return false;
  const numbers = listPhoneNumbersForUser(ownerId).map((r) => r.phone);
  if (numbers.length === 0) return false;

  let allSucceeded = true;
  for (const number of numbers) {
    try {
      await sendWhatsAppMessage(number, text);
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
    messages = await hubListMessages(ownerId, { limit: 50 });
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

    const delivered = await notifyMatch(ownerId, buildMatchNotification(docTitle, keys));
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
  let messages: UnifiedMessage[];
  try {
    messages = await hubListMessages(ownerId, { limit: 50 });
  } catch (err) {
    console.error(`reconciliation: failed to list messages for owner ${ownerId}`, err);
    return;
  }

  const unscanned = messages.filter((m) => !hasAlerted(ownerId, scanKey(m)));
  if (unscanned.length === 0) return;

  const recentKeys = listRecentMatchKeys(ownerId, Date.now() - RECENT_DOCUMENT_WINDOW_MS);

  let sent = 0;
  for (const m of unscanned) {
    // Mark scanned regardless of match outcome — an email that didn't match this tick never
    // needs re-checking on a later tick, whether or not it matched anything.
    markAlerted(ownerId, scanKey(m));

    if (sent >= MAX_MATCH_NOTIFICATIONS_PER_TICK || recentKeys.length === 0) continue;

    const text = `${m.subject} ${m.snippet}`;
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

      const delivered = await notifyMatch(ownerId, buildMatchNotification(row.docTitle ?? "a saved document", keys));
      if (!delivered) continue; // leave this match retriable — don't mark or count it, matches Task 4's fix

      markAlerted(ownerId, matchKey);
      sent += 1;
      break; // one matching document is enough for this email
    }
  }
}
