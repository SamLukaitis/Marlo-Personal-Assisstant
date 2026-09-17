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
  isPhoneInvited,
  recordWaitlistRequest,
  getUserByEmail,
  listPhoneNumbersForUser,
  setSetting,
  type PendingRegistrationRow,
  type RegistrationProvider,
} from "../db/store.js";
import { sendWhatsAppMessage, sendWhatsAppReplyButtons, sendWhatsAppCtaUrl } from "../providers/whatsapp.js";
import { startPostConnectSetup } from "./postConnectSetup.js";
import { isPlausibleName } from "./plausibleName.js";
import { SERVER_URL } from "../config.js";
import { getRegistrationAssistReply } from "../ai/assistant.js";
import type { IncomingWhatsAppMessage } from "../providers/whatsapp.js";

const IDLE_RESET_MS = 24 * 60 * 60 * 1000; // a week-old half-finished conversation starts over
const RESEND_COOLDOWN_MS = 60 * 1000; // advisory UX throttle, not the security boundary
const lastTokenIssuedAt = new Map<string, number>();

// Used as the very first message a brand-new number ever sees, and as the answer to "help"/"menu"
// while registration is still in progress — both cases end with the name question because that's
// the actual next step for someone who isn't registered yet. See MARLOWE_HELP_TEXT below for the
// separate post-registration version (chatDispatch.ts) — the two used to be one shared constant,
// which meant an already-registered user asking "help" got asked their name again.
export const MARLOWE_FIRST_CONTACT_TEXT =
  "Hi, I'm Marlowe, your personal assistant. What would you like me to call you?";

// What an uninvited number gets on its first message. Deliberately warm and final-sounding: the
// person on the other end did nothing wrong, and there's no action they can take to speed it up.
// The "we'll let you know" promise is kept by adminRoutes.ts, which messages them when an admin
// approves the number from the Waitlist section.
export const MARLOWE_WAITLIST_TEXT =
  "👋 Thank you for your interest in *Marlowe*!\n\n" +
  "We're still in beta testing, so access is invite-only for now. Your request has been sent " +
  "to the developers and you're on the waitlist — we'll message you here as soon as you can " +
  "get started.";

// Every message after the first from the same uninvited number. Short on purpose: they've
// already had the full explanation, and re-sending it reads as a broken bot.
export const MARLOWE_WAITLIST_REMINDER_TEXT =
  "You're still on the waitlist — we'll message you the moment you're in. Thanks for your patience!";

// What a waitlisted number is sent when an admin approves them (adminRoutes.ts). Kept to one
// short line because it may go out as a template parameter if their 24h window has closed — see
// services/outbound.ts.
export const MARLOWE_WAITLIST_APPROVED_TEXT =
  "You're in! Message me whenever you're ready and I'll get you set up.";

// The "help"/"menu" reply for an already-registered user (chatDispatch.ts's handleText) — same
// capabilities rundown, but asks what they need instead of re-asking their name, since they're
// long past that step.
export const MARLOWE_HELP_TEXT =
  "👋 Here's what I can do:\n\n" +
  "• Read your email & calendar, help you reply and schedule\n" +
  "• Send a morning update each day\n" +
  "• Answer questions like \"what's on today?\"\n" +
  "• Save photos of tickets/receipts/documents\n" +
  "• Text \"help\" anytime for this list again\n\n" +
  "What do you need?";

const HELP_TRIGGERS = new Set(["help", "menu", "what can you do"]);
export function isHelpTrigger(text: string): boolean {
  return HELP_TRIGGERS.has(text.trim().toLowerCase());
}

const EMAIL_CONFIRM_BUTTON_IDS = { yes: "email_confirm_yes", no: "email_confirm_no" };

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
    case "awaiting_email_confirm":
      return "Want to connect your email? Tap Yes or No above, or just send me your email address.";
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
  // Carry the name captured earlier in this same registration (handleAwaitingName below) forward
  // into the durable user_name setting, so postConnectSetup's own chain doesn't ask "what should
  // I call you?" a second time — see the comment on that check in startPostConnectSetup for the
  // bug this prevents.
  const pending = getPendingRegistration(phone);
  if (pending?.name && isPlausibleName(pending.name)) {
    setSetting(ownerId, "user_name", pending.name);
  }
  completePendingRegistration(phone);
  await startPostConnectSetup(ownerId, phone);
}

async function askEmailConfirm(row: PendingRegistrationRow): Promise<void> {
  await sendWhatsAppReplyButtons(
    row.phone,
    "Connecting your email will allow me to help draft responses, add events to your calendar, and flag important emails. Would you like to start here?",
    [
      { id: EMAIL_CONFIRM_BUTTON_IDS.yes, title: "Yes" },
      { id: EMAIL_CONFIRM_BUTTON_IDS.no, title: "No" },
    ]
  );
  upsertPendingRegistration(row.phone, { step: "awaiting_email_confirm" });
}

async function handleAwaitingName(row: PendingRegistrationRow, text: string): Promise<void> {
  const typed = text.trim().slice(0, 60);
  // A sentence-shaped reply isn't a real name (see plausibleName.ts) — greet generically and
  // store nothing, rather than embedding it verbatim here and later as the permanent display
  // name via sendFirstValueAndBriefingPrompt above.
  const name = isPlausibleName(typed) ? typed : null;
  const updated = upsertPendingRegistration(row.phone, { step: "awaiting_email_confirm", name: name ?? "" });
  const greeting = name ? `Hi ${name}.` : "Hi there.";
  // Sent as separate WhatsApp messages (not joined with \n\n) to match a real conversational
  // back-and-forth rather than one long wall of text.
  await reply(row.phone, `${greeting} I hope to be helpful with anything you could need, so please, ask me anything.`);
  await reply(
    row.phone,
    "My developers are always adding features, so if you give me a request I cannot meet, I'll send this over to them to build ASAP."
  );
  await reply(
    row.phone,
    "Most people ask me to help plan their calendar and travel plans, organise their inboxes, and remind them of important information and events."
  );
  await askEmailConfirm(updated);
}

// buttonId comes from an IncomingInteractiveMessage tap on the buttons askEmailConfirm sent.
async function handleEmailConfirmTap(row: PendingRegistrationRow, buttonId: string): Promise<void> {
  if (buttonId === EMAIL_CONFIRM_BUTTON_IDS.yes) {
    upsertPendingRegistration(row.phone, { step: "awaiting_email" });
    await reply(row.phone, "Great, what email would you like to connect");
    return;
  }
  if (buttonId === EMAIL_CONFIRM_BUTTON_IDS.no) {
    // Not a real skip — there's no way to create an account without a connected mailbox (see
    // feature-to-do/email-less-accounts.md), so the step deliberately stays at
    // awaiting_email_confirm rather than advancing or completing. Whatever they send next just
    // continues from here instead of restarting the whole conversation.
    await reply(
      row.phone,
      "No worries, let me know later if you'd like to connect an inbox. Let me know how I can help!"
    );
    return;
  }
  // Stray/unexpected button id — re-show the choice rather than silently drop it.
  await askEmailConfirm(row);
}

// Fallback for someone who types instead of tapping a button. Also lets someone skip the
// confirmation entirely by just sending their email address straight away.
async function handleAwaitingEmailConfirmText(row: PendingRegistrationRow, text: string): Promise<void> {
  const trimmed = text.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    const updated = upsertPendingRegistration(row.phone, { step: "awaiting_email" });
    await handleAwaitingEmail(updated, trimmed);
    return;
  }
  if (/^y(es)?$/i.test(trimmed)) {
    await handleEmailConfirmTap(row, EMAIL_CONFIRM_BUTTON_IDS.yes);
    return;
  }
  if (/^no?( thanks)?$/i.test(trimmed)) {
    await handleEmailConfirmTap(row, EMAIL_CONFIRM_BUTTON_IDS.no);
    return;
  }
  const helpReply = await getRegistrationAssistReply(text, "email");
  await reply(row.phone, helpReply);
}

async function handleAwaitingEmail(row: PendingRegistrationRow, text: string): Promise<void> {
  const email = text.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    // Not a help trigger either (already intercepted earlier) — this is genuinely confused or
    // open-ended free text ("I have two, which one?"), so hand it to the assistant for a real
    // reply instead of repeating the same canned rejection. The assistant only converses here;
    // it has no say in whether an email is ultimately accepted.
    const helpReply = await getRegistrationAssistReply(text, "email");
    await reply(row.phone, helpReply);
    return;
  }

  // No invite check here anymore — access is gated by phone number at first contact (see
  // handlePendingRegistration below), so by the time someone reaches this step their number has
  // already been authorized and any email they connect is fine.
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
  // without losing data — fall through and let it reconnect.

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
    if (row && row.step === "awaiting_email_confirm") {
      await handleEmailConfirmTap(row, message.buttonId);
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
    // The invite gate: a brand-new number only gets past this point if it's on the
    // invited-numbers list (see db/store.ts's isPhoneInvited/addInvitedPhone) — no pending
    // registration row is created for an uninvited number, so it can start over cleanly the
    // moment it's actually invited rather than being stuck mid-flow. This is the fast, UX-facing
    // check; authRoutes.ts's OAuth callback re-checks the same thing authoritatively right before
    // an account is actually created, in case the invite was revoked mid-conversation.
    if (!isPhoneInvited(phone)) {
      // Log the request so admins can see who asked (Settings → Waitlist) rather than the
      // attempt vanishing. Recording grants nothing — invited_phones is still the only gate.
      // First contact gets the full explanation; anything after that gets the short nudge, so
      // someone who keeps messaging isn't re-sent the same paragraph every time but also never
      // hits silence and assumes Marlowe is broken.
      const { isNewRequest } = recordWaitlistRequest(phone);
      await reply(
        phone,
        isNewRequest ? MARLOWE_WAITLIST_TEXT : MARLOWE_WAITLIST_REMINDER_TEXT
      ).catch(() => {});
      return;
    }
    row = upsertPendingRegistration(phone, { step: "awaiting_name" });
    await reply(phone, MARLOWE_FIRST_CONTACT_TEXT);
    return;
  }

  if (row.step !== "completed" && isHelpTrigger(message.text)) {
    await reply(phone, MARLOWE_FIRST_CONTACT_TEXT);
    await reply(phone, currentStepPrompt(row));
    return;
  }

  switch (row.step) {
    case "awaiting_name":
      await handleAwaitingName(row, message.text);
      return;
    case "awaiting_email_confirm":
      await handleAwaitingEmailConfirmText(row, message.text);
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
