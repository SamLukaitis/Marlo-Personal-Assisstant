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

import { hubListNewMessages, holdNewMessageCheckpoint } from "./hub.js";
import { isWhatsAppConfigured } from "../providers/whatsapp.js";
import { sendProactiveMessage } from "./outbound.js";
import { hasAlerted, markAlerted, listPhoneNumbersForUser, listRecentMatchKeys, getSetting } from "../db/store.js";
import {
  isOnboardingSuppressionActive,
  incrementSuppressedOnboardingAlerts,
} from "./onboardingAlertSuppression.js";
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

export interface EmailDocumentMatch {
  subject: string;
  docTitle: string;
  keys: MatchKeys;
}

// Past this many, the rest of a burst is summarized as a count rather than listed.
const MAX_LISTED_MATCHES = 5;

function identifierPart(keys: MatchKeys): string {
  const identifier = keys.referenceCode ?? keys.flightNumber ?? "";
  return identifier ? ` — reference *${identifier}*` : "";
}

// One message per check, however many emails matched. Every email is named by its subject so the
// alert says which email it means (previously the text came only from the document, so several
// matching emails produced identical messages). No account email — the doc title and identifier
// are bolded so the concrete facts stand out, with a name-first greeting when known, matching the
// tone of the other alert types (importantEmailAlerts.ts, alerts.ts).
export function buildMatchNotification(matches: EmailDocumentMatch[], userName: string | null): string {
  const greeting = userName ? `${userName}, ` : "";

  if (matches.length === 1) {
    const [{ subject, docTitle, keys }] = matches;
    const datePart = keys.eventDate ? ` (${keys.eventDate})` : "";
    return `📎 ${greeting}an email about your *${docTitle}*${datePart} came in: "${subject}"${identifierPart(keys)}. Worth a look?`;
  }

  const lines = matches
    .slice(0, MAX_LISTED_MATCHES)
    .map(({ subject, docTitle, keys }) => `• "${subject}" — your *${docTitle}*${identifierPart(keys)}`);
  const rest = matches.length - MAX_LISTED_MATCHES;
  const more = rest > 0 ? `\n…and ${rest} more.` : "";
  return `📎 ${greeting}${matches.length} emails came in about things you've saved:\n${lines.join("\n")}${more}`;
}

const RECENT_DOCUMENT_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

// Marked once an email has been fully handled — matched and alerted (or recorded during
// onboarding), or examined and found to match nothing. This is what makes each email alert at most
// once, however many saved documents match it.
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
    // Shares the same incremental "what's new since last check" fetch as alerts.ts and
    // importantEmailAlerts.ts (hub.ts's hubListNewMessages).
    messages = await hubListNewMessages(ownerId);
  } catch (err) {
    console.error(`reconciliation: failed to list messages for owner ${ownerId}`, err);
    return;
  }

  const unscanned = messages.filter((m) => !hasAlerted(ownerId, scanKey(m)));
  if (unscanned.length === 0) return;

  // Undeliverable for reasons that won't fix themselves on the next tick — leave everything
  // unscanned, but don't hold the Gmail checkpoint (that would re-fetch the same growing window of
  // mail every tick). Same posture as importantEmailAlerts.ts.
  if (!isWhatsAppConfigured()) return;
  const numbers = listPhoneNumbersForUser(ownerId).map((r) => r.phone);
  if (numbers.length === 0) return;

  const matched: { message: UnifiedMessage; match: EmailDocumentMatch }[] = [];
  for (const m of unscanned) {
    const text = `${m.subject} ${m.snippet}`;
    // Most recently indexed document first (listRecentMatchKeys orders by created_at DESC) — one
    // document is enough to name the email; the email itself is only ever alerted once.
    const row = recentKeys.find((r) =>
      matchTier(
        { referenceCode: r.referenceCode ?? undefined, flightNumber: r.flightNumber ?? undefined },
        text
      ) === "strong"
    );
    if (!row) {
      markAlerted(ownerId, scanKey(m));
      continue;
    }
    matched.push({
      message: m,
      match: {
        subject: m.subject,
        docTitle: row.docTitle ?? "a saved document",
        keys: {
          referenceCode: row.referenceCode ?? undefined,
          flightNumber: row.flightNumber ?? undefined,
          eventDate: row.eventDate ?? undefined,
        },
      },
    });
  }
  if (matched.length === 0) return;

  // While postConnectSetup.ts's onboarding chain is still in progress, don't interleave proactive
  // alerts into that conversation — record the matches so they're never alerted later, and count
  // them for onboardingAlertSuppression.ts's one-time summary instead.
  if (isOnboardingSuppressionActive(ownerId)) {
    incrementSuppressedOnboardingAlerts(ownerId, matched.length);
    for (const { message } of matched) markAlerted(ownerId, scanKey(message));
    return;
  }

  const text = buildMatchNotification(
    matched.map((x) => x.match),
    getSetting(ownerId, "user_name")
  );
  let allDelivered = true;
  for (const number of numbers) {
    try {
      await sendProactiveMessage(number, text, "alert");
    } catch (err) {
      console.error("reconciliation: failed to send match notification", err);
      allDelivered = false;
    }
  }

  if (allDelivered) {
    for (const { message } of matched) markAlerted(ownerId, scanKey(message));
  } else {
    // Leave the matches unscanned so the next tick retries them — and hold the Gmail checkpoint,
    // or that tick's incremental fetch would never list them again.
    holdNewMessageCheckpoint(ownerId);
  }
}
