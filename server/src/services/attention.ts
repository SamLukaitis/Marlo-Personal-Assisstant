// The attention gate: every unprompted message about the user's mail, bookings and bills goes
// through here, so Marlowe behaves like a PA — interrupting only for what can't wait, reminding
// at the moment something matters, and folding everything else into the briefing or digest.
// Decisions live in attentionRules.ts; this file does the storage and sending.
// See docs/superpowers/specs/2026-09-28-attention-gate-design.md.
import {
  getAttentionItem,
  insertAttentionItem,
  updateAttentionItem,
  listAttentionItems,
  countCappedAttentionSentSince,
  listPhoneNumbersForUser,
  type AttentionDetails,
  type AttentionItemRow,
  type AttentionSource,
  type AttentionTier,
} from "../db/store.js";
import { isWhatsAppConfigured } from "../providers/whatsapp.js";
import { sendToAllNumbers } from "./proactiveDelivery.js";
import { getUserTimezone } from "./userTimezone.js";
import { getBriefingSettings } from "./briefing.js";
import { isPostConnectChainInProgress } from "./onboardingAlertSuppression.js";
import { getXeroForwardingEmail } from "./xero.js";
import { setPendingInvoiceForward } from "./xeroInvoiceConfirmation.js";
import { emailReferenceNote } from "./emailReference.js";
import {
  DAILY_CAP,
  CAP_EXEMPT_CATEGORIES,
  QUIET_HOURS_EXEMPT_CATEGORIES,
  tierFor,
  eventKeyFor,
  surfaceAtFor,
  inQuietHours,
  nextAllowedTime,
  localDayStart,
  isConcrete,
  interruptText,
  reminderText,
  ackLine,
  briefLine,
  phoneStepsFor,
} from "./attentionRules.js";
import { createPhoneAction, phoneSuggestionsEnabled, PROACTIVE_TTL_MS } from "./phoneActions.js";

export interface AttentionCandidate {
  source: AttentionSource;
  category: string;
  details: AttentionDetails;
  fallbackKey: string;
  // True when the user told us about it themselves (a document they sent), so the briefing
  // doesn't say "noted" about something they already know we have.
  acknowledged?: boolean;
}

export type SubmitOutcome = "sent" | "scheduled" | "queued" | "merged" | "dropped" | "deferred" | "held" | "failed";

const TIER_RANK: Record<AttentionTier, number> = { drop: 0, brief: 1, scheduled: 2, interrupt: 3 };
const BRIEFING_LOOKAHEAD_MS = 2 * 60 * 60 * 1000;

function definedOnly(details: AttentionDetails): Partial<AttentionDetails> {
  return Object.fromEntries(
    Object.entries(details).filter(([, v]) => v !== undefined && v !== null && v !== "")
  ) as Partial<AttentionDetails>;
}

// An email is the freshest word on an event, so its fields win; a saved document or a
// reconciliation match only fills gaps (a reconciliation summary is weaker than the email's own).
function mergeDetails(existing: AttentionDetails, incoming: AttentionDetails, source: AttentionSource): AttentionDetails {
  if (source === "email") return { ...existing, ...definedOnly(incoming) };
  return { ...definedOnly(incoming), ...definedOnly(existing), summary: existing.summary || incoming.summary };
}

function briefingTimeFor(ownerId: number): string | null {
  const settings = getBriefingSettings(ownerId);
  return settings.proactive ? settings.sendTime : null;
}

function reachableNumbers(ownerId: number): string[] {
  if (!isWhatsAppConfigured()) return [];
  return listPhoneNumbersForUser(ownerId).map((r) => r.phone);
}

function historyNoteFor(details: AttentionDetails): string | undefined {
  if (details.accountId === undefined || !details.messageId) return undefined;
  return emailReferenceNote({
    accountId: details.accountId,
    id: details.messageId,
    subject: details.emailSubject ?? "",
    from: details.emailFrom ?? "",
  });
}

interface PreparedItem {
  item: AttentionItemRow;
  text: string;
  offer: { accountId: number; messageId: string; subject: string } | null;
}

// Decides whether a due item may go out now — quiet hours, the day's cap (`cappedSent` already
// sent or about to be today), and the concreteness check — and builds its text. Anything that
// can't go now is re-filed (deferred, held, or downgraded to the briefing) and returns an outcome.
function prepareItem(
  ownerId: number,
  item: AttentionItemRow,
  now: number,
  cappedSent: number
): PreparedItem | SubmitOutcome {
  const zone = getUserTimezone(ownerId);
  if (inQuietHours(now, zone) && !QUIET_HOURS_EXEMPT_CATEGORIES.includes(item.category)) {
    updateAttentionItem(ownerId, item.id, { surfaceAt: nextAllowedTime(now, zone, briefingTimeFor(ownerId)) });
    return "deferred";
  }
  if (!CAP_EXEMPT_CATEGORIES.includes(item.category) && cappedSent >= DAILY_CAP) {
    updateAttentionItem(ownerId, item.id, { status: "held" });
    return "held";
  }
  let text =
    item.tier === "interrupt"
      ? interruptText(item.category, item.details, false)
      : reminderText(item.category, item.details, zone, now);
  if (!isConcrete(text)) {
    updateAttentionItem(ownerId, item.id, { tier: "brief", surfaceAt: null });
    return "queued";
  }
  const offer =
    item.category === "invoice_due" && item.details.xeroOffer && getXeroForwardingEmail(ownerId)
      ? item.details.xeroOffer
      : null;
  if (offer) text += `\n\nReply "yes" and I'll forward it to Xero.`;
  // Created now, when the reminder actually goes out, so its expiry runs from when they see it.
  // Only scheduled reminders: an interrupt is about something that changed, not something to set up.
  if (item.tier !== "interrupt" && phoneSuggestionsEnabled(ownerId)) {
    // A failed link must not cost the reminder itself, nor stop the other due items in this run.
    try {
      const suggestion = phoneStepsFor(item.details, zone, now);
      if (suggestion) {
        const { url } = createPhoneAction(ownerId, suggestion.steps, {
          source: "reminder",
          label: suggestion.label,
          ttlMs: PROACTIVE_TTL_MS,
          notAfter: suggestion.notAfter,
          now,
        });
        text += `\n\n${suggestion.label}: ${url}`;
      }
    } catch (err) {
      console.error("attention: phone link failed; sending the reminder without it", err);
    }
  }
  return { item, text, offer };
}

function cappedSentToday(ownerId: number, now: number): number {
  return countCappedAttentionSentSince(ownerId, localDayStart(now, getUserTimezone(ownerId)), CAP_EXEMPT_CATEGORIES);
}

// Sends one or more prepared items as a single WhatsApp message — several things falling due at
// once (typically the morning after quiet hours) arrive together rather than as a burst of pings.
// Leaves them pending on a send failure so the next tick retries; only a delivered item counts
// against the cap.
async function sendPrepared(ownerId: number, ready: PreparedItem[], now: number): Promise<SubmitOutcome> {
  const numbers = reachableNumbers(ownerId);
  if (numbers.length === 0) return "failed";
  const key =
    ready.length === 1
      ? `attention:${ready[0].item.id}:${ready[0].item.tier}:${ready[0].item.surfaceAt ?? 0}`
      : `attention:batch:${ready.map((r) => `${r.item.id}@${r.item.surfaceAt ?? 0}`).join(",")}`;
  const notes = ready.map((r) => historyNoteFor(r.item.details)).filter((n): n is string => !!n);
  const delivered = await sendToAllNumbers(
    ownerId,
    key,
    numbers,
    ready.map((r) => r.text).join("\n\n"),
    "alert",
    "attention",
    notes.length ? notes.join("\n") : undefined
  );
  if (!delivered) return "failed";
  for (const r of ready) updateAttentionItem(ownerId, r.item.id, { status: "sent", sentAt: now });
  // One pending-confirmation slot per owner (xeroInvoiceConfirmation.ts): the latest offer wins.
  const offer = ready.map((r) => r.offer).filter(Boolean).at(-1);
  if (offer) setPendingInvoiceForward(ownerId, offer);
  return "sent";
}

async function deliverItem(ownerId: number, item: AttentionItemRow, now: number): Promise<SubmitOutcome> {
  const prepared = prepareItem(ownerId, item, now, cappedSentToday(ownerId, now));
  return typeof prepared === "string" ? prepared : sendPrepared(ownerId, [prepared], now);
}

// A change to an event we already know about (a flight moved): one message now, while the row
// itself keeps its reminder, re-timed to the new details. Outside the flight-change exemption,
// quiet hours skip the ping — the updated details still reach the user via the reminder/briefing.
async function sendChange(
  ownerId: number,
  row: AttentionItemRow,
  category: string,
  details: AttentionDetails,
  moved: boolean,
  now: number
): Promise<SubmitOutcome> {
  const zone = getUserTimezone(ownerId);
  if (inQuietHours(now, zone) && !QUIET_HOURS_EXEMPT_CATEGORIES.includes(category)) return "merged";
  const text = interruptText(category, details, moved);
  if (!isConcrete(text)) return "merged";
  const numbers = reachableNumbers(ownerId);
  if (numbers.length === 0) return "failed";
  const delivered = await sendToAllNumbers(
    ownerId,
    `attention:${row.id}:change:${details.summary}`,
    numbers,
    text,
    "alert",
    "attention",
    historyNoteFor(details)
  );
  return delivered ? "sent" : "failed";
}

export async function submitAttentionItem(ownerId: number, candidate: AttentionCandidate): Promise<SubmitOutcome> {
  const now = Date.now();
  const zone = getUserTimezone(ownerId);
  const tier = tierFor(candidate.category, candidate.details, now, zone);
  const eventKey = eventKeyFor(candidate.details, candidate.fallbackKey);
  const existing = getAttentionItem(ownerId, eventKey);

  if (existing) {
    const details = mergeDetails(existing.details, candidate.details, candidate.source);
    const reschedule = existing.tier === "scheduled" && existing.status === "pending";
    const newSurface = reschedule ? surfaceAtFor(existing.category, details, zone) : existing.surfaceAt;
    const moved = reschedule && newSurface !== null && newSurface !== existing.surfaceAt;
    const patch: Parameters<typeof updateAttentionItem>[2] = { details };
    if (reschedule && newSurface !== null) patch.surfaceAt = Math.max(newSurface, now);
    // A routine update we dropped can be followed by one that matters (a failed delivery).
    if (existing.status === "dropped" && tier !== "interrupt" && TIER_RANK[tier] > TIER_RANK.drop) {
      const surface = tier === "scheduled" ? surfaceAtFor(candidate.category, details, zone) : null;
      patch.tier = surface === null && tier === "scheduled" ? "brief" : tier;
      patch.status = "pending";
      patch.surfaceAt = surface === null ? null : Math.max(surface, now);
    }
    const updated = updateAttentionItem(ownerId, existing.id, patch);
    if (tier !== "interrupt") return "merged";
    // The same news again (the same email seen twice): a repeat, not something new to say. A second,
    // different change to the same flight is news, and goes out.
    if (
      candidate.category === existing.category &&
      candidate.details.summary.trim() === existing.details.summary.trim()
    ) {
      return "merged";
    }
    return sendChange(ownerId, updated, candidate.category, candidate.details, moved, now);
  }

  const base = { eventKey, source: candidate.source, category: candidate.category, details: candidate.details };
  if (tier === "drop") {
    insertAttentionItem(ownerId, { ...base, tier, status: "dropped", surfaceAt: null });
    return "dropped";
  }
  if (tier === "brief") {
    insertAttentionItem(ownerId, { ...base, tier, status: "pending", surfaceAt: null });
    return "queued";
  }
  if (tier === "scheduled") {
    const surfaceAt = surfaceAtFor(candidate.category, candidate.details, zone);
    insertAttentionItem(ownerId, {
      ...base,
      tier: surfaceAt === null ? "brief" : "scheduled",
      status: "pending",
      surfaceAt: surfaceAt === null ? null : Math.max(surfaceAt, now),
      acknowledgedAt: candidate.acknowledged ? now : null,
    });
    return surfaceAt === null ? "queued" : "scheduled";
  }
  const row = insertAttentionItem(ownerId, { ...base, tier, status: "pending", surfaceAt: now, acknowledgedAt: now });
  // Never interleave with the post-connect onboarding questions — deliverDueAttentionItems sends
  // it once the chain has finished.
  if (isPostConnectChainInProgress(ownerId)) return "deferred";
  return deliverItem(ownerId, row, now);
}

export async function deliverDueAttentionItems(ownerId: number): Promise<void> {
  if (isPostConnectChainInProgress(ownerId)) return;
  const now = Date.now();
  const due = listAttentionItems(ownerId, { statuses: ["pending"], dueBefore: now }).filter(
    (r) => r.tier === "interrupt" || r.tier === "scheduled"
  );
  let cappedSent = cappedSentToday(ownerId, now);
  const ready: PreparedItem[] = [];
  for (const item of due) {
    const prepared = prepareItem(ownerId, item, now, cappedSent);
    if (typeof prepared === "string") continue;
    if (!CAP_EXEMPT_CATEGORIES.includes(item.category)) cappedSent++;
    ready.push(prepared);
  }
  if (ready.length) await sendPrepared(ownerId, ready, now);
}

export interface AttentionBundle {
  noted: string[];
  needsAttention: string[];
  upcoming: string[];
  ackIds: number[];
  foldIds: number[];
}

export function isEmptyBundle(b: AttentionBundle): boolean {
  return b.noted.length === 0 && b.needsAttention.length === 0 && b.upcoming.length === 0;
}

function collect(
  ownerId: number,
  now: number,
  opts: { acks: boolean; brief: boolean; upcoming: boolean }
): AttentionBundle {
  const zone = getUserTimezone(ownerId);
  const bundle: AttentionBundle = { noted: [], needsAttention: [], upcoming: [], ackIds: [], foldIds: [] };
  for (const item of listAttentionItems(ownerId, { statuses: ["pending", "held"] })) {
    if (item.status === "held" || (item.tier === "brief" && opts.brief)) {
      bundle.needsAttention.push(briefLine(item.details));
      bundle.foldIds.push(item.id);
      continue;
    }
    // An interrupt held overnight for an early briefing goes into that briefing, not a ping after it.
    if (item.tier === "interrupt" && opts.upcoming && item.surfaceAt !== null && item.surfaceAt <= now + BRIEFING_LOOKAHEAD_MS) {
      bundle.upcoming.push(interruptText(item.category, item.details, false));
      bundle.foldIds.push(item.id);
      continue;
    }
    if (item.tier !== "scheduled" || item.surfaceAt === null) continue;
    if (opts.upcoming && item.surfaceAt <= now + BRIEFING_LOOKAHEAD_MS) {
      bundle.upcoming.push(reminderText(item.category, item.details, zone, now));
      bundle.foldIds.push(item.id);
      if (item.acknowledgedAt === null) bundle.ackIds.push(item.id);
      continue;
    }
    if (opts.acks && item.acknowledgedAt === null) {
      bundle.noted.push(ackLine(item.details, item.surfaceAt, zone, now));
      bundle.ackIds.push(item.id);
    }
  }
  return bundle;
}

export function collectAttentionForBriefing(ownerId: number, now: number): AttentionBundle {
  return collect(ownerId, now, { acks: true, brief: true, upcoming: true });
}

// Held (over-cap) items always ride the digest; acks and brief items only when there's no
// proactive morning briefing to carry them.
export function collectAttentionForDigest(ownerId: number, now: number, includeBriefItems: boolean): AttentionBundle {
  return collect(ownerId, now, { acks: includeBriefItems, brief: includeBriefItems, upcoming: false });
}

// Call only once the briefing/digest carrying `bundle` was actually delivered.
export function commitAttentionBundle(ownerId: number, bundle: AttentionBundle, now: number): void {
  for (const id of bundle.ackIds) updateAttentionItem(ownerId, id, { acknowledgedAt: now });
  for (const id of bundle.foldIds) updateAttentionItem(ownerId, id, { status: "folded" });
}
