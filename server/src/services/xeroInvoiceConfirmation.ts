// Holds the one "we spotted a possible invoice, waiting on a yes/no" slot per owner (see
// feature-to-do/xero-receipt-forwarding.md step 8). Deliberately a single slot, not a queue —
// if a second invoice_due email shows up before the first is answered, the older one is just
// left as a plain notification (no CTA) rather than building out multi-item tracking for what's
// a rare case in practice (see [[feedback_avoid_fuzzy_heuristics_prefer_simplicity]] in spirit:
// simple and occasionally-not-offered beats a queue nobody asked for).
import { getSetting, setSetting } from "../db/store.js";

const SETTINGS_KEY = "pending_xero_invoice_confirmation";
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // a "yes" a week later is more likely about something else

export interface PendingInvoiceForward {
  accountId: number;
  messageId: string;
  subject: string;
  setAt: number;
}

export function setPendingInvoiceForward(
  ownerId: number,
  pending: Omit<PendingInvoiceForward, "setAt">
): void {
  setSetting(ownerId, SETTINGS_KEY, JSON.stringify({ ...pending, setAt: Date.now() }));
}

export function getPendingInvoiceForward(ownerId: number): PendingInvoiceForward | null {
  const raw = getSetting(ownerId, SETTINGS_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PendingInvoiceForward;
    if (Date.now() - parsed.setAt > MAX_AGE_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearPendingInvoiceForward(ownerId: number): void {
  setSetting(ownerId, SETTINGS_KEY, "");
}
