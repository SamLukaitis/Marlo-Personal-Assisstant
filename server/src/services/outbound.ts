// Chooses free-form text vs. a pre-approved template for every *proactive* WhatsApp push (a
// briefing, an alert — anything not sent as a direct reply to an inbound message). WhatsApp only
// allows free-form sends within 24h of the user's last message to us (the "customer service
// window"); past that, Meta rejects a free-form send with error 131047 and only a template goes
// through. See docs/superpowers/specs/2026-08-26-whatsapp-template-fallback-design.md.
import {
  sendWhatsAppMessage,
  sendWhatsAppTemplate,
  sendChoiceMessage,
  WhatsAppSendError,
  type WhatsAppTemplateName,
} from "../providers/whatsapp.js";
import { getLastInboundAt, resolveOwnerByPhone, appendWhatsAppMessage, type SentPart } from "../db/store.js";

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

// Unlike a free-form send, a template *parameter* value is rejected by Meta outright if it
// contains a newline, a tab, or a run of more than one space — callers (attentionRules.ts's message builders
// et al.) format their text assuming a normal chat bubble, so this is the one place that has to
// flatten it back down before it can go in a template. Collapses any run of newlines/tabs to a
// single space first (so "a\n\nb" doesn't become "a  b"), then collapses any remaining multi-space
// run — including ones that were already there, e.g. in a raw email snippet.
function sanitizeForTemplateParam(text: string): string {
  return text.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
}

// Only appends `continuation` when truncation actually happened — a message that already fits
// goes through untouched (aside from the same sanitizing every template param gets).
export function truncateForTemplate(text: string, continuation?: string): string {
  const sanitized = sanitizeForTemplateParam(text);
  if (sanitized.length <= MAX_TEMPLATE_PARAM_LENGTH) return sanitized;
  const budget = MAX_TEMPLATE_PARAM_LENGTH - (continuation?.length ?? 0);
  const truncated = sanitized.slice(0, Math.max(0, budget)).trimEnd() + (continuation ?? "");
  return sanitizeForTemplateParam(truncated);
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
  kind: ProactiveMessageKind,
  // Stored with the message in chat history but never sent — e.g. the ids of the email an alert
  // is about, so a later "reply yes" can act on it.
  historyNote?: string
): Promise<void> {
  const wamid = await sendProactive(phone, text, kind);
  recordProactiveInHistory(phone, historyNote ? `${text}\n\n${historyNote}` : text, wamid);
}

// Like sendProactiveMessage, but with tappable buttons under the text. Buttons are only possible
// inside the 24h window — a template can't carry them — so outside it (or if Meta disagrees about
// the window being open) `fallbackText`, which should ask for a typed reply instead, goes out as
// the template. `text` is the button prompt; a tap comes back as a button reply carrying an id.
export async function sendProactiveMessageWithButtons(
  phone: string,
  text: string,
  buttons: { id: string; title: string }[],
  kind: ProactiveMessageKind,
  historyNote?: string,
  fallbackText: string = text
): Promise<void> {
  if (isWithinCustomerServiceWindow(phone)) {
    try {
      const parts = await sendChoiceMessage(phone, text, buttons);
      recordProactiveInHistory(phone, historyNote ? `${text}\n\n${historyNote}` : text, parts);
      return;
    } catch (err) {
      if (!(err instanceof WhatsAppSendError && err.code === WINDOW_CLOSED_ERROR_CODE)) throw err;
    }
  }
  const wamid = await sendWhatsAppTemplate(phone, TEMPLATE_BY_KIND[kind], truncateForTemplate(fallbackText));
  recordProactiveInHistory(phone, historyNote ? `${fallbackText}\n\n${historyNote}` : fallbackText, wamid);
}

// A proactive push goes into chat history and its wamid is recorded, exactly like a normal reply
// (whatsappReply.ts) — otherwise a swipe-reply to an alert can't be resolved and a bare "reply
// yes" has no idea an alert was just sent. Never throws: the message has already been delivered,
// and callers treat a throw as "not delivered" and retry, which would send the alert twice.
// A choice message can go out as several parts (see sendChoiceMessage); each is kept with its own
// text so a swipe on one part resolves to that part.
function recordProactiveInHistory(phone: string, text: string, sent: string | SentPart[] | undefined): void {
  try {
    const ownerId = resolveOwnerByPhone(phone);
    if (ownerId === null) return;
    const wamids = typeof sent === "string" ? [sent] : sent?.length ? sent : undefined;
    appendWhatsAppMessage(ownerId, phone, "assistant", text, wamids);
  } catch (err) {
    console.error("outbound: failed to record proactive message in history", err);
  }
}

async function sendProactive(
  phone: string,
  text: string,
  kind: ProactiveMessageKind
): Promise<string | undefined> {
  const templateName = TEMPLATE_BY_KIND[kind];
  // Only the digest is routinely long enough to actually get truncated — the alert template's
  // {{1}} is already a short line in practice, so it never needs the "open the app" pointer.
  const continuation = kind === "digest" ? " …open the app for the rest." : undefined;
  const templateParam = truncateForTemplate(text, continuation);

  if (isWithinCustomerServiceWindow(phone)) {
    try {
      return await sendWhatsAppMessage(phone, text);
    } catch (err) {
      // Self-heals clock drift or a stale last_inbound_at: our own bookkeeping said the window
      // was open, Meta disagrees — retry once as a template rather than surfacing the failure.
      if (err instanceof WhatsAppSendError && err.code === WINDOW_CLOSED_ERROR_CODE) {
        return sendWhatsAppTemplate(phone, templateName, templateParam);
      }
      throw err;
    }
  }

  return sendWhatsAppTemplate(phone, templateName, templateParam);
}
