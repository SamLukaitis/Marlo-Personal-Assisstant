// The one-tap "connect your mailbox" link: token issuance + WhatsApp CTA send. Shared by two
// callers that must never drift into two different versions of this message —
// whatsappRegistration.ts's sendProviderLink (mid pre-connect registration) and the assistant's
// connect_email tool (assistant.ts — a registered, mailbox-less user asking to connect a mailbox
// later, Task 8). Pulled out into its own module, rather than exported from either caller, so
// assistant.ts doesn't need to import whatsappRegistration.ts (which itself imports assistant.ts
// for getRegistrationAssistReply) — that would make the two modules circularly dependent on each
// other for no reason beyond this one shared function.
import { setPendingRegistrationToken, type RegistrationProvider } from "../db/store.js";
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

const PROVIDER_LABEL: Record<RegistrationProvider, string> = {
  google: "Gmail",
  microsoft: "Outlook",
};

// Does NOT touch pending_whatsapp_registrations' `step` — that's each caller's own decision.
// whatsappRegistration.ts's sendProviderLink advances it to awaiting_link_tap; the connect_email
// tool must NOT move a completed row back into the registration state machine (see
// handlePendingRegistration's routing in whatsappRegistration.ts) so it deliberately leaves it
// alone.
export async function sendConnectLink(phone: string, provider: RegistrationProvider): Promise<void> {
  if (withinCooldown(phone)) {
    await sendWhatsAppMessage(phone, "Still working on it — give it a few seconds and try again if the link doesn't work.");
    return;
  }
  const token = setPendingRegistrationToken(phone);
  lastTokenIssuedAt.set(phone, Date.now());
  const path = provider === "google" ? "/auth/google/register" : "/auth/microsoft/register";
  const link = `${SERVER_URL}${path}?token=${token}`;
  await sendWhatsAppCtaUrl(
    phone,
    `Almost there — tap below to connect *${PROVIDER_LABEL[provider]}*. I'll be able to read your mail and draft replies, but I can never send anything without you approving it first. This link works for ten minutes.`,
    `Connect ${PROVIDER_LABEL[provider]}`,
    link
  );
}
