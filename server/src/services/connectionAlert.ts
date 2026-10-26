// The WhatsApp side of a dead mailbox connection (a revoked or expired token, or Google's 7-day
// refresh-token limit while the OAuth app is in Testing mode). Without it the only sign was a badge
// on the web Settings page, and on WhatsApp Marlo just looked like it had stopped seeing mail.
//
// Unlike a new OAuth scope (asked for only when the user hits the feature that needs it), a dead
// token breaks everything that mailbox feeds — alerts, the briefing, every search — so it's worth
// one unprompted message. hub.ts calls this only on the healthy -> broken transition, and the
// per-day event key stops a connection that flaps from pinging more than once a day.
import { DateTime } from "luxon";
import type { AccountRow } from "../db/store.js";
import { submitAttentionItem } from "./attention.js";
import { CONNECTION_BROKEN_CATEGORY } from "./attentionRules.js";
import { getUserTimezone } from "./userTimezone.js";
import { mailboxLabel } from "./mailboxLabel.js";

export async function alertConnectionBroken(account: AccountRow): Promise<void> {
  if (account.provider !== "google" && account.provider !== "microsoft") return;
  const zone = getUserTimezone(account.ownerId);
  const day = (zone ? DateTime.now().setZone(zone) : DateTime.now()).toISODate() ?? DateTime.now().toISODate();
  // "Reply reconnect" rather than a link in this message: the link's token lasts ten minutes, and
  // this can be held through quiet hours or arrive as a template outside WhatsApp's 24h window,
  // where a button can't go. The reply reopens the window and connect_email sends a fresh link.
  await submitAttentionItem(account.ownerId, {
    source: "connection",
    category: CONNECTION_BROKEN_CATEGORY,
    details: {
      summary:
        `I've lost access to your *${mailboxLabel(account.provider)}* (${account.email}) — the connection has ` +
        `expired, so I can't see new mail or calendar events from it until it's reconnected. Reply ` +
        `*reconnect* and I'll send you a link to fix it.`,
      accountId: account.id,
      needsAction: true,
    },
    fallbackKey: `connection:${account.id}:${day}`,
  });
}
