// Cross-referencing between saved documents and email — see
// docs/superpowers/specs/2026-08-24-document-email-cross-referencing-design.md for the full
// design and why this stays entirely deterministic in v1 (no LLM call on the email side at all).

import { hubListMessages } from "./hub.js";
import { sendWhatsAppMessage, isWhatsAppConfigured } from "../providers/whatsapp.js";
import { hasAlerted, markAlerted, listPhoneNumbersForUser } from "../db/store.js";
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

async function notifyMatch(ownerId: number, text: string): Promise<void> {
  if (!isWhatsAppConfigured()) return;
  const numbers = listPhoneNumbersForUser(ownerId).map((r) => r.phone);
  for (const number of numbers) {
    try {
      await sendWhatsAppMessage(number, text);
    } catch (err) {
      console.error("reconciliation: failed to send match notification", err);
    }
  }
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

    await notifyMatch(ownerId, buildMatchNotification(docTitle, keys));
    markAlerted(ownerId, matchKey);
    sent += 1;
  }
}
