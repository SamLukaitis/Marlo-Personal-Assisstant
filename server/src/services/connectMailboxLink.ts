// The one-tap "connect your mailbox" link: token issuance + WhatsApp CTA send. Shared by two
// callers that must never drift into two different versions of this message —
// whatsappRegistration.ts's sendProviderLink (mid pre-connect registration) and the assistant's
// connect_email tool (assistant.ts — a registered, mailbox-less user asking to connect a mailbox
// later, Task 8). Pulled out into its own module, rather than exported from either caller, so
// assistant.ts doesn't need to import whatsappRegistration.ts (which itself imports assistant.ts
// for getRegistrationAssistReply) — that would make the two modules circularly dependent on each
// other for no reason beyond this one shared function.
import { setPendingRegistrationToken, getPendingRegistration, type RegistrationProvider } from "../db/store.js";
import { sendWhatsAppMessage, sendWhatsAppCtaUrl } from "../providers/whatsapp.js";
import { SERVER_URL } from "../config.js";

// Advisory UX throttle (stops someone mashing "resend"/re-asking within the same minute from
// generating a fresh token every time), not a security boundary — the token itself is what's
// actually checked. Shared across both callers, keyed by phone, since it's the same underlying
// spam concern either way.
const RESEND_COOLDOWN_MS = 60 * 1000;
const lastTokenIssuedAt = new Map<string, number>();

function withinCooldown(phone: string): boolean {
  const last = lastTokenIssuedAt.get(phone);
  return last !== undefined && Date.now() - last < RESEND_COOLDOWN_MS;
}

// Prunes on every write instead of a timer — this Map is now shared by two callers (this file's
// own header comment) and has no other expiry, so left alone it grows by one entry forever for
// every phone that has ever asked for a connect link. A scan bounded by the last minute's worth
// of callers, on the already-infrequent "issue a token" path, is cheap enough not to need a
// background interval.
function recordTokenIssued(phone: string): void {
  const now = Date.now();
  for (const [key, issuedAt] of lastTokenIssuedAt) {
    if (now - issuedAt >= RESEND_COOLDOWN_MS) lastTokenIssuedAt.delete(key);
  }
  lastTokenIssuedAt.set(phone, now);
}

const PROVIDER_LABEL: Record<RegistrationProvider, string> = {
  google: "Gmail",
  microsoft: "Outlook",
};

// "sent" — a real link went out. "throttled" — the cooldown swallowed it, and the "still working
// on it" reply went out instead; a caller that already told the user a link is coming must not
// report success here, or a provider switch within the cooldown window (e.g. "actually, Outlook")
// silently produces no Outlook link at all. "no_pending_row" — see the check below.
export type ConnectLinkResult = "sent" | "throttled" | "no_pending_row";

// Does NOT touch pending_whatsapp_registrations' `step` — that's each caller's own decision.
// whatsappRegistration.ts's sendProviderLink advances it to awaiting_link_tap; the connect_email
// tool must NOT move a completed row back into the registration state machine (see
// handlePendingRegistration's routing in whatsappRegistration.ts) so it deliberately leaves it
// alone.
export async function sendConnectLink(phone: string, provider: RegistrationProvider): Promise<ConnectLinkResult> {
  if (withinCooldown(phone)) {
    await sendWhatsAppMessage(phone, "Still working on it — give it a few seconds and try again if the link doesn't work.");
    return "throttled";
  }
  // setPendingRegistrationToken (store.ts) is `UPDATE ... WHERE phone = ?` — with no matching row
  // it still hands back a fresh random token that can never be redeemed (nothing's token_hash was
  // actually set, so peekPendingRegistrationByToken/consumePendingRegistrationToken find no row to
  // match it against). Two real populations can reach this with no row: an admin's
  // replay-onboarding action (adminRoutes.ts) deletes it while keeping the account, and a
  // web-registered user who added this number in Settings then disconnected their mailbox never
  // had one at all. Check first rather than send a CTA that's silently dead on arrival — the
  // person would tap it, land on `/auth/.../register?error=expired`, and get no explanation and no
  // way to retry into something that works.
  if (!getPendingRegistration(phone)) {
    return "no_pending_row";
  }
  const token = setPendingRegistrationToken(phone);
  recordTokenIssued(phone);
  const path = provider === "google" ? "/auth/google/register" : "/auth/microsoft/register";
  const link = `${SERVER_URL}${path}?token=${token}`;
  await sendWhatsAppCtaUrl(
    phone,
    `Almost there — tap below to connect *${PROVIDER_LABEL[provider]}*. I'll be able to read your mail and draft replies, but I can never send anything without you approving it first. This link works for ten minutes.`,
    `Connect ${PROVIDER_LABEL[provider]}`,
    link
  );
  return "sent";
}
