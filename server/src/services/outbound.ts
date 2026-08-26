// Chooses free-form text vs. a pre-approved template for every *proactive* WhatsApp push (a
// briefing, an alert — anything not sent as a direct reply to an inbound message). WhatsApp only
// allows free-form sends within 24h of the user's last message to us (the "customer service
// window"); past that, Meta rejects a free-form send with error 131047 and only a template goes
// through. See docs/superpowers/specs/2026-08-26-whatsapp-template-fallback-design.md.
import {
  sendWhatsAppMessage,
  sendWhatsAppTemplate,
  WhatsAppSendError,
  type WhatsAppTemplateName,
} from "../providers/whatsapp.js";
import { getLastInboundAt } from "../db/store.js";

const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
const WINDOW_CLOSED_ERROR_CODE = 131047;

// Every proactive push site is one of these two shapes: a short single-event line (an alert), or
// the one multi-paragraph LLM-synthesized briefing (the digest) — see the design doc for why two
// templates rather than one-per-feature or one-for-everything.
export type ProactiveMessageKind = "alert" | "digest";

const TEMPLATE_BY_KIND: Record<ProactiveMessageKind, WhatsAppTemplateName> = {
  alert: "marlowe_alert",
  digest: "marlowe_digest",
};

// Meta caps a template's body component at 1024 chars *including* the substituted variable
// values. The static lead-in text ("Update from Marlowe:\n" / "Your Marlowe briefing:\n") is
// short, so a flat 1000-char budget for the variable leaves a safe margin without having to
// track each template's exact prefix length here.
const MAX_TEMPLATE_PARAM_LENGTH = 1000;

// Only appends `continuation` when truncation actually happened — a message that already fits
// goes through untouched.
export function truncateForTemplate(text: string, continuation?: string): string {
  if (text.length <= MAX_TEMPLATE_PARAM_LENGTH) return text;
  const budget = MAX_TEMPLATE_PARAM_LENGTH - (continuation?.length ?? 0);
  return text.slice(0, Math.max(0, budget)).trimEnd() + (continuation ?? "");
}

function isWithinCustomerServiceWindow(phone: string): boolean {
  const lastInboundAt = getLastInboundAt(phone);
  // No recorded inbound message (never messaged us, or predates last_inbound_at) is treated as
  // outside the window — the safe default, since the alternative is a free-form send that risks
  // failing outright.
  return lastInboundAt !== null && Date.now() - lastInboundAt < CUSTOMER_SERVICE_WINDOW_MS;
}

// Drop-in replacement for providers/whatsapp.ts's sendWhatsAppMessage at every proactive push
// site — same (to, text) shape those call sites already use, plus which template to fall back to
// if free-form isn't available. Still throws on failure, so each caller's existing try/catch (and
// whatever it does with success/failure — mark-alerted, retry-eligibility, etc.) works unchanged.
export async function sendProactiveMessage(
  phone: string,
  text: string,
  kind: ProactiveMessageKind
): Promise<void> {
  const templateName = TEMPLATE_BY_KIND[kind];
  // Only the digest is routinely long enough to actually get truncated — the alert template's
  // {{1}} is already a short line in practice, so it never needs the "open the app" pointer.
  const continuation = kind === "digest" ? "\n…open the app for the rest." : undefined;
  const templateParam = truncateForTemplate(text, continuation);

  if (isWithinCustomerServiceWindow(phone)) {
    try {
      await sendWhatsAppMessage(phone, text);
      return;
    } catch (err) {
      // Self-heals clock drift or a stale last_inbound_at: our own bookkeeping said the window
      // was open, Meta disagrees — retry once as a template rather than surfacing the failure.
      if (err instanceof WhatsAppSendError && err.code === WINDOW_CLOSED_ERROR_CODE) {
        await sendWhatsAppTemplate(phone, templateName, templateParam);
        return;
      }
      throw err;
    }
  }

  await sendWhatsAppTemplate(phone, templateName, templateParam);
}
