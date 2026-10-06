// Cross-referencing between saved documents and email — see
// docs/superpowers/specs/2026-08-24-document-email-cross-referencing-design.md for the full
// design and why this stays entirely deterministic in v1 (no LLM call on the email side at all).
//
// Only genuinely new mail is checked (checkNewEmailsAgainstRecentDocuments, on the scheduler tick).
// There used to be a second check that ran every time a document was saved and scanned the last 150
// emails already in the inbox — it sent one identical-looking "an email about your <document> just
// came in" alert per matching email, and all of them again for every new document about the same
// booking (alert spam, reported 2026-09-15). The mail it found was almost always mail the user
// already had, often the very email the document came from, so it was removed rather than tuned.
// Matches now go to the attention gate (attention.ts) rather than messaging — see
// docs/superpowers/specs/2026-09-28-attention-gate-design.md.

import { hubListNewMessages } from "./hub.js";
import { hasAlerted, markAlerted, listRecentMatchKeys } from "../db/store.js";
import { submitAttentionItem } from "./attention.js";
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

const RECENT_DOCUMENT_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

// Marked once an email has been examined, matched or not, so each email is handled at most once
// however many saved documents match it.
function scanKey(m: UnifiedMessage): string {
  return `recon-scan:${m.accountId}:${m.id}`;
}

// Runs on the scheduler tick. A match is handed to the attention gate as a "document_match": if the
// gate already knows this booking (from its confirmation email or the saved document) it merges
// silently; otherwise it's one line in the next briefing/digest. Never messages on its own.
// Deliberately unfiltered by sender type — an automated airline/vendor notice is exactly what
// this is meant to catch.
export async function checkNewEmailsAgainstRecentDocuments(ownerId: number): Promise<void> {
  // Cheap early-return before paying for a mail-provider API call: a user with no indexed
  // documents in the window can never match anything.
  const recentKeys = listRecentMatchKeys(ownerId, Date.now() - RECENT_DOCUMENT_WINDOW_MS);
  if (recentKeys.length === 0) return;

  let messages: UnifiedMessage[];
  try {
    // Shares the same incremental "what's new since last check" fetch as alerts.ts and
    // importantEmailAlerts.ts (hub.ts's hubListNewMessages).
    messages = await hubListNewMessages(ownerId);
  } catch (err) {
    console.error(`reconciliation: failed to list messages for owner ${ownerId}`, err);
    return;
  }

  for (const m of messages) {
    if (hasAlerted(ownerId, scanKey(m))) continue;
    const text = `${m.subject} ${m.snippet}`;
    // Most recently indexed document first (listRecentMatchKeys orders by created_at DESC).
    const row = recentKeys.find(
      (r) =>
        matchTier({ referenceCode: r.referenceCode ?? undefined, flightNumber: r.flightNumber ?? undefined }, text) ===
        "strong"
    );
    if (row) {
      await submitAttentionItem(ownerId, {
        source: "reconciliation",
        category: "document_match",
        details: {
          summary: `*${row.docTitle ?? "A saved document"}* — new email: "${m.subject}"`,
          reference: row.referenceCode ?? undefined,
          flightNumber: row.flightNumber ?? undefined,
          eventStart: row.eventDate ?? undefined,
          accountId: m.accountId,
          messageId: m.id,
          emailSubject: m.subject,
          emailFrom: m.from,
        },
        fallbackKey: `msg:${m.accountId}:${m.id}`,
      });
    }
    markAlerted(ownerId, scanKey(m));
  }
}
