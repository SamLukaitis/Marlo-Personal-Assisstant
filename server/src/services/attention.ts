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
} from "./attentionRules.js";

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

// Sends one due item now, if quiet hours and the day's cap allow. Leaves it pending on a send
// failure so the next tick retries it; it only counts against the cap once actually delivered.
async function deliverItem(ownerId: number, item: AttentionItemRow, now: number): Promise<SubmitOutcome> {
  const zone = getUserTimezone(ownerId);
  if (inQuietHours(now, zone) && !QUIET_HOURS_EXEMPT_CATEGORIES.includes(item.category)) {
    updateAttentionItem(ownerId, item.id, { surfaceAt: nextAllowedTime(now, zone, briefingTimeFor(ownerId)) });
    return "deferred";
  }
  if (
    !CAP_EXEMPT_CATEGORIES.includes(item.category) &&
    countCappedAttentionSentSince(ownerId, localDayStart(now, zone), CAP_EXEMPT_CATEGORIES) >= DAILY_CAP
  ) {
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

  const numbers = reachableNumbers(ownerId);
  if (numbers.length === 0) return "failed";
  const delivered = await sendToAllNumbers(
    ownerId,
    `attention:${item.id}:${item.tier}:${item.surfaceAt ?? 0}`,
    numbers,
    text,
    "alert",
    "attention",
    historyNoteFor(item.details)
  );
  if (!delivered) return "failed";
  updateAttentionItem(ownerId, item.id, { status: "sent", sentAt: now });
  if (offer) setPendingInvoiceForward(ownerId, offer);
  return "sent";
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
    // Same event and the same kind of news: a repeat, not something new to say.
    if (tier !== "interrupt" || candidate.category === existing.category) return "merged";
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
  for (const item of due) await deliverItem(ownerId, item, now);
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
