// The WhatsApp-native signup flow — lets a brand-new, invited-but-not-yet-registered phone
// number go from "Hi" to a connected Gmail/Outlook account without ever visiting the website
// first (matches the product's own pitch deck, slides 8-9). The one unavoidable browser hop is
// the OAuth consent screen itself — Google/Microsoft don't allow sign-in inside an embedded
// webview, so a one-time link is sent instead (see authRoutes.ts's "whatsapp_register" intent).
//
// Name/email capture stays plain conversational text. Provider is inferred from the typed
// email's domain (detectProviderFromEmail) whenever it's unambiguous, so most people are never
// asked at all; only a custom/work domain falls back to the explicit question, shown as tappable
// buttons instead of two links in one message, since WhatsApp only allows one URL button per
// message — see sendWhatsAppReplyButtons/sendWhatsAppCtaUrl in providers/whatsapp.ts.
// One explicit future upgrade, not built here: Meta WhatsApp Flows (native in-chat forms) for the
// name/email capture too.
//
// Everything past OAuth (first-task check, briefing + content, Teams) is handled by
// services/postConnectSetup.ts's own chain, which forwards real requests to the assistant
// (assistant.ts's set_briefing_preferences / set_tool_enabled / send_feedback_to_admin tools)
// along the way. See docs/superpowers/specs/2026-08-28-whatsapp-onboarding-redesign-design.md.
import {
  getPendingRegistration,
  upsertPendingRegistration,
  setPendingRegistrationToken,
  completePendingRegistration,
  deletePendingRegistration,
  isEmailInvited,
  getUserByEmail,
  listPhoneNumbersForUser,
  type PendingRegistrationRow,
  type RegistrationProvider,
} from "../db/store.js";
import { sendWhatsAppMessage, sendWhatsAppReplyButtons, sendWhatsAppCtaUrl } from "../providers/whatsapp.js";
import { startPostConnectSetup } from "./postConnectSetup.js";
import { SERVER_URL } from "../config.js";
import { getRegistrationAssistReply } from "../ai/assistant.js";
import type { IncomingWhatsAppMessage } from "../providers/whatsapp.js";

const IDLE_RESET_MS = 24 * 60 * 60 * 1000; // a week-old half-finished conversation starts over
const RESEND_COOLDOWN_MS = 60 * 1000; // advisory UX throttle, not the security boundary
const lastTokenIssuedAt = new Map<string, number>();

// Short, plain-language rundown aimed at someone who isn't very tech-savvy — this doubles as
// both the very first message a new number ever sees and the answer to "help"/"menu" at any
// point later (pre- or post-registration), so there's exactly one copy of it to keep accurate.
export const MARLOWE_HELP_TEXT =
  "👋 *Welcome to the Marlowe testing beta!* I'm Marlowe, your personal assistant. Here's what I do:\n\n" +
  "• Read your email & calendar, help you reply and schedule\n" +
  "• Send a morning update each day\n" +
  "• Answer questions like \"what's on today?\"\n" +
  "• Save photos of tickets/receipts/documents\n" +
  "• Text \"help\" anytime for this list again\n\n" +
  "What should I call you?";

const HELP_TRIGGERS = new Set(["help", "menu", "what can you do"]);
export function isHelpTrigger(text: string): boolean {
  return HELP_TRIGGERS.has(text.trim().toLowerCase());
}

const PROVIDER_BUTTON_IDS: Record<RegistrationProvider, string> = {
  google: "register_google",
  microsoft: "register_microsoft",
};

const PROVIDER_LABEL: Record<RegistrationProvider, string> = {
  google: "Gmail",
  microsoft: "Outlook",
};

// Most people's email address already says which provider they're on — asking anyway feels like
// a redundant extra step right after they just typed it. Only the ambiguous case (a custom/work
// domain that could be either Google Workspace or Microsoft 365) still gets the explicit question.
const PROVIDER_EMAIL_DOMAINS: Record<RegistrationProvider, string[]> = {
  google: ["gmail.com", "googlemail.com"],
  microsoft: ["outlook.com", "hotmail.com", "live.com", "msn.com"],
};

function detectProviderFromEmail(email: string): RegistrationProvider | null {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return null;
  for (const provider of Object.keys(PROVIDER_EMAIL_DOMAINS) as RegistrationProvider[]) {
    if (PROVIDER_EMAIL_DOMAINS[provider].includes(domain)) return provider;
  }
  return null;
}

// What to say again after a help interruption, so the person lands back where they were
// instead of getting stuck. `awaiting_name` reuses the tail of the first-contact message since
// that's the only place the name question is asked.
function currentStepPrompt(row: PendingRegistrationRow): string {
  switch (row.step) {
    case "awaiting_name":
      return "What should I call you?";
    case "awaiting_email":
      return "What's your email address?";
    case "awaiting_provider":
      return "Do you use Gmail or Outlook/Hotmail? Tap one of the buttons above.";
    case "awaiting_link_tap":
      return "Tap the link above to connect your email — I'll message you the moment it's done. Reply \"resend\" if it expired.";
    case "completed":
      return "";
  }
}

function withinCooldown(phone: string): boolean {
  const last = lastTokenIssuedAt.get(phone);
  return last !== undefined && Date.now() - last < RESEND_COOLDOWN_MS;
}

async function reply(phone: string, text: string): Promise<void> {
  await sendWhatsAppMessage(phone, text);
}

async function askProvider(row: PendingRegistrationRow): Promise<void> {
  await sendWhatsAppReplyButtons(row.phone, "Do you use Gmail or Outlook/Hotmail?", [
    { id: PROVIDER_BUTTON_IDS.google, title: "Gmail" },
    { id: PROVIDER_BUTTON_IDS.microsoft, title: "Outlook" },
  ]);
  upsertPendingRegistration(row.phone, { step: "awaiting_provider" });
}

async function sendProviderLink(row: PendingRegistrationRow): Promise<void> {
  const provider = row.provider;
  if (!provider) {
    // Shouldn't happen — awaiting_link_tap is only reached via sendProviderLink itself, always
    // called right after provider is set. Guard anyway rather than sending a broken link.
    await askProvider(row);
    return;
  }
  if (withinCooldown(row.phone)) {
    await reply(row.phone, "Still working on it — give it a few seconds and try again if the link doesn't work.");
    return;
  }
  const token = setPendingRegistrationToken(row.phone);
  lastTokenIssuedAt.set(row.phone, Date.now());
  const path = provider === "google" ? "/auth/google/register" : "/auth/microsoft/register";
  const link = `${SERVER_URL}${path}?token=${token}`;
  await sendWhatsAppCtaUrl(
    row.phone,
    `Almost there — tap below to connect *${PROVIDER_LABEL[provider]}*. I'll be able to read your mail and draft replies, but I can never send anything without you approving it first. This link works for ten minutes.`,
    `Connect ${PROVIDER_LABEL[provider]}`,
    link
  );
  upsertPendingRegistration(row.phone, { step: "awaiting_link_tap" });
}

// Called from the OAuth callback (authRoutes.ts) once the mailbox is actually connected — this
// is a proactive, server-initiated WhatsApp push, not a reply to an inbound webhook, since the
// event it's reacting to (finishing OAuth in a browser) happens outside any webhook.
//
// Marks the pending-registration row completed right away: there's nothing left to await
// server-side. The user's reply is their first ordinary chat message — addPhoneNumberForUser
// already ran before this is called, so resolveOwnerByPhone resolves it and it's routed straight
// to the real assistant (runAssistantChat), not back into handlePendingRegistration. Hands off
// immediately to postConnectSetup's own button chain (daily briefing, Teams, Schengen tracking).
export async function sendFirstValueAndBriefingPrompt(ownerId: number, phone: string): Promise<void> {
  completePendingRegistration(phone);
  await startPostConnectSetup(ownerId, phone);
}

async function handleAwaitingName(row: PendingRegistrationRow, text: string): Promise<void> {
  const name = text.trim().slice(0, 60);
  upsertPendingRegistration(row.phone, { step: "awaiting_email", name });
  await reply(
    row.phone,
    `Nice to meet you, ${name}! Let's connect your email so I can help with your inbox, calendar, and more — what's your email address?`
  );
}

async function handleAwaitingEmail(row: PendingRegistrationRow, text: string): Promise<void> {
  const email = text.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    // Not a help trigger either (already intercepted earlier) — this is genuinely confused or
    // open-ended free text ("I have two, which one?"), so hand it to the assistant for a real
    // reply instead of repeating the same canned rejection. The assistant only converses here;
    // it has no say in whether an email is ultimately accepted (see the isEmailInvited check
    // below, unchanged and still 100% code).
    const helpReply = await getRegistrationAssistReply(text, "email");
    await reply(row.phone, helpReply);
    return;
  }

  // UX-only fast reject — comment deliberately loud: the AUTHORITATIVE check is the OAuth
  // callback's isEmailInvited(auth.email) against the real provider-returned email, exactly
  // matching how the "login" intent already works. Never trust this typed value for the actual
  // security decision, only for giving a faster, friendlier no here.
  if (!isEmailInvited(email)) {
    upsertPendingRegistration(row.phone, { typedEmail: email });
    await reply(row.phone, "That email isn't on our early-access list yet — try a different one, or check back later.");
    return;
  }

  const existingUser = getUserByEmail(email);
  if (existingUser && listPhoneNumbersForUser(existingUser.id).length > 0) {
    await reply(
      row.phone,
      "That email's already connected to a Marlowe account. Add this WhatsApp number from Settings on the website instead of starting again here."
    );
    return; // deliberately stop advancing — do not silently rebind an existing account's phone
  }
  // existingUser with zero phones bound means the account was deliberately disconnected via
  // Settings > "replay onboarding" (resetOnboardingConnectionState) to re-test this exact flow
  // without losing data — fall through and let it reconnect. Still safe against a stranger typing
  // someone else's email: OAuth re-verifies the real address (isEmailInvited(auth.email) in
  // authRoutes.ts) before anything is bound, same as the brand-new-account path below.

  const updated = upsertPendingRegistration(row.phone, { typedEmail: email });

  const detectedProvider = detectProviderFromEmail(email);
  if (detectedProvider) {
    const withProvider = upsertPendingRegistration(row.phone, { provider: detectedProvider });
    await sendProviderLink(withProvider);
    return;
  }

  await askProvider(updated);
}

// buttonId comes straight from an IncomingInteractiveMessage tap on the buttons askProvider sent.
async function handleAwaitingProviderTap(row: PendingRegistrationRow, buttonId: string): Promise<void> {
  const provider: RegistrationProvider | null =
    buttonId === PROVIDER_BUTTON_IDS.google
      ? "google"
      : buttonId === PROVIDER_BUTTON_IDS.microsoft
        ? "microsoft"
        : null;
  if (!provider) {
    // Stray/unexpected button id — re-show the choice rather than silently drop it.
    await askProvider(row);
    return;
  }
  const updated = upsertPendingRegistration(row.phone, { provider });
  await sendProviderLink(updated);
}

// Fallback for someone who types "gmail"/"outlook" instead of tapping a button.
async function handleAwaitingProviderText(row: PendingRegistrationRow, text: string): Promise<void> {
  const normalized = text.trim().toLowerCase();
  const provider: RegistrationProvider | null = /gmail|google/.test(normalized)
    ? "google"
    : /outlook|hotmail|microsoft/.test(normalized)
      ? "microsoft"
      : null;
  if (!provider) {
    const helpReply = await getRegistrationAssistReply(text, "provider");
    await reply(row.phone, helpReply);
    return;
  }
  const updated = upsertPendingRegistration(row.phone, { provider });
  await sendProviderLink(updated);
}

async function handleAwaitingLinkTap(row: PendingRegistrationRow, text: string): Promise<void> {
  if (/resend|new link|link again/i.test(text)) {
    await sendProviderLink(row);
    return;
  }
  // Anything else (a question, "did it work?", confusion) gets a real conversational reply
  // instead of the same static reminder every time — same treatment as the email step above.
  const helpReply = await getRegistrationAssistReply(text, "link");
  await reply(row.phone, helpReply);
}

// The redirect a mistimed message (a button tap or media that doesn't match the current step)
// gets — kept as one copy since it's used from a couple of places below.
async function redirectToSetup(phone: string): Promise<void> {
  await reply(phone, "Let's finish setting you up first — what should I call you?").catch(() => {});
}

// The entry point whatsappRoutes.ts calls when resolveOwnerByPhone finds no owner for an
// incoming message. Media messages during registration get a short redirect — ingestWhatsAppMedia
// requires a resolved ownerId, which doesn't exist yet at this point. Interactive (button tap)
// messages are only meaningful at the awaiting_provider step; anywhere else they get the same
// redirect as a mistimed media message. Unsupported types (location, voice, sticker, ...) get the
// same redirect too — there's no registration state to advance from one of these either.
export async function handlePendingRegistration(message: IncomingWhatsAppMessage): Promise<void> {
  const phone = message.from;
  let row = getPendingRegistration(phone);

  if (row && row.step !== "completed" && Date.now() - row.updatedAt > IDLE_RESET_MS) {
    deletePendingRegistration(phone);
    row = null;
  }

  if (message.kind === "interactive") {
    if (row && row.step === "awaiting_provider") {
      await handleAwaitingProviderTap(row, message.buttonId);
      return;
    }
    await redirectToSetup(phone);
    return;
  }

  // Media, location pins, unsupported types (voice, sticker, ...), and reactions all get the
  // same redirect — there's no registration state to advance from any of these, and nobody's
  // registered yet for a reaction to even mean anything.
  if (
    message.kind === "media" ||
    message.kind === "unsupported" ||
    message.kind === "reaction" ||
    message.kind === "location"
  ) {
    await redirectToSetup(phone);
    return;
  }

  if (!row) {
    row = upsertPendingRegistration(phone, { step: "awaiting_name" });
    await reply(phone, MARLOWE_HELP_TEXT);
    return;
  }

  if (row.step !== "completed" && isHelpTrigger(message.text)) {
    await reply(phone, MARLOWE_HELP_TEXT);
    await reply(phone, currentStepPrompt(row));
    return;
  }

  switch (row.step) {
    case "awaiting_name":
      await handleAwaitingName(row, message.text);
      return;
    case "awaiting_email":
      await handleAwaitingEmail(row, message.text);
      return;
    case "awaiting_provider":
      await handleAwaitingProviderText(row, message.text);
      return;
    case "awaiting_link_tap":
      await handleAwaitingLinkTap(row, message.text);
      return;
    case "completed":
      // Unreachable in practice — once addPhoneNumberForUser ran, resolveOwnerByPhone already
      // resolves this number and whatsappRoutes.ts never reaches this function again. Kept as a
      // harmless fallback rather than throwing if it somehow is.
      return;
  }
}
