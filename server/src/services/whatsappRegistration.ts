// The WhatsApp-native signup flow — lets a brand-new, invited-but-not-yet-registered phone
// number go from "Hi" to a connected Gmail/Outlook account without ever visiting the website
// first (matches the product's own pitch deck, slides 8-9). The one unavoidable browser hop is
// the OAuth consent screen itself — Google/Microsoft don't allow sign-in inside an embedded
// webview, so a one-time link is sent instead (see authRoutes.ts's "whatsapp_register" intent).
//
// v1 is plain conversational text throughout. One explicit future upgrade, not built here: Meta
// WhatsApp Flows (native in-chat forms) for the name/email capture — would reduce typing further,
// not required for the flow to work.
//
// Everything past OAuth (briefing content, optional tools like Teams/travel tracking) is
// deliberately NOT a scripted step here — it's handled by the real, tool-calling assistant
// (assistant.ts's set_briefing_preferences / set_tool_enabled tools) once the person has a
// working hub. See docs/superpowers/specs/2026-08-20-whatsapp-onboarding-expansion-design.md.
import {
  getPendingRegistration,
  upsertPendingRegistration,
  setPendingRegistrationToken,
  completePendingRegistration,
  deletePendingRegistration,
  isEmailInvited,
  getUserByEmail,
  type PendingRegistrationRow,
} from "../db/store.js";
import { sendWhatsAppMessage } from "../providers/whatsapp.js";
import { hubListMessages, hubListEvents } from "./hub.js";
import { SERVER_URL } from "../config.js";
import type { IncomingWhatsAppMessage } from "../providers/whatsapp.js";

const IDLE_RESET_MS = 24 * 60 * 60 * 1000; // a week-old half-finished conversation starts over
const RESEND_COOLDOWN_MS = 60 * 1000; // advisory UX throttle, not the security boundary
const lastTokenIssuedAt = new Map<string, number>();

function withinCooldown(phone: string): boolean {
  const last = lastTokenIssuedAt.get(phone);
  return last !== undefined && Date.now() - last < RESEND_COOLDOWN_MS;
}

async function reply(phone: string, text: string): Promise<void> {
  await sendWhatsAppMessage(phone, text);
}

async function sendLinks(row: PendingRegistrationRow): Promise<void> {
  if (withinCooldown(row.phone)) {
    await reply(row.phone, "Still working on it — give it a few seconds and try again if the link doesn't work.");
    return;
  }
  const token = setPendingRegistrationToken(row.phone);
  lastTokenIssuedAt.set(row.phone, Date.now());
  const googleLink = `${SERVER_URL}/auth/google/register?token=${token}`;
  const microsoftLink = `${SERVER_URL}/auth/microsoft/register?token=${token}`;
  await reply(
    row.phone,
    `Tap here to let me in — Google will ask if I can read your mail and write drafts, I can never send anything:\n\n` +
      `If you use Gmail: ${googleLink}\n\nIf you use Outlook/Hotmail: ${microsoftLink}\n\n` +
      `This link works for ten minutes.`
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
// to the real assistant (runAssistantChat), not back into handlePendingRegistration.
export async function sendFirstValueAndBriefingPrompt(ownerId: number, phone: string): Promise<void> {
  let fact = "";
  try {
    const [messages, events] = await Promise.all([
      hubListMessages(ownerId, { limit: 20 }).catch(() => []),
      hubListEvents(ownerId, 1).catch(() => []),
    ]);
    const unread = messages.filter((m) => m.unread).length;
    const parts: string[] = [];
    if (unread > 0) parts.push(`${unread} unread email${unread === 1 ? "" : "s"}`);
    if (events.length > 0) parts.push(`${events.length} thing${events.length === 1 ? "" : "s"} on today's calendar`);
    fact = parts.length ? ` I can already see ${parts.join(" and ")}.` : "";
  } catch {
    // best-effort — a missing first-value fact shouldn't block the confirmation message itself
  }

  await reply(phone, `Connected — I can see your inbox and your calendar.${fact}`);
  await reply(
    phone,
    "Each morning I'll send you an update on your email, calendar, and anything that looks like " +
      "it needs a reply. Want me to also include news, business headlines, or weather?"
  );
  completePendingRegistration(phone);
}

async function handleAwaitingName(row: PendingRegistrationRow, text: string): Promise<void> {
  const name = text.trim().slice(0, 60);
  upsertPendingRegistration(row.phone, { step: "awaiting_email", name });
  await reply(row.phone, `Nice to meet you, ${name}. Which email do you use?`);
}

async function handleAwaitingEmail(row: PendingRegistrationRow, text: string): Promise<void> {
  const email = text.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    await reply(row.phone, "That doesn't look like an email address — what's the one you use for Gmail or Outlook?");
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
  if (existingUser) {
    await reply(
      row.phone,
      "That email's already connected to a Marlowe account. Add this WhatsApp number from Settings on the website instead of starting again here."
    );
    return; // deliberately stop advancing — do not silently rebind an existing account's phone
  }

  const updated = upsertPendingRegistration(row.phone, { typedEmail: email });
  await sendLinks(updated);
}

async function handleAwaitingLinkTap(row: PendingRegistrationRow, text: string): Promise<void> {
  if (/resend|new link|link again/i.test(text)) {
    await sendLinks(row);
    return;
  }
  await reply(row.phone, "Tap the link above to connect your email — I'll message you the moment it's done. Reply \"resend\" if it expired.");
}

// The entry point whatsappRoutes.ts calls when resolveOwnerByPhone finds no owner for an
// incoming text message. Media messages during registration get a short redirect instead —
// ingestWhatsAppMedia requires a resolved ownerId, which doesn't exist yet at this point.
export async function handlePendingRegistration(message: IncomingWhatsAppMessage): Promise<void> {
  if (message.kind !== "text") {
    await reply(message.from, "Let's finish setting you up first — what should I call you?").catch(() => {});
    return;
  }

  const phone = message.from;
  let row = getPendingRegistration(phone);

  if (row && row.step !== "completed" && Date.now() - row.updatedAt > IDLE_RESET_MS) {
    deletePendingRegistration(phone);
    row = null;
  }

  if (!row) {
    row = upsertPendingRegistration(phone, { step: "awaiting_name" });
    await reply(
      phone,
      "Hello — I'm Marlowe. I help with email, appointments and paperwork, all from here. What should I call you?"
    );
    return;
  }

  switch (row.step) {
    case "awaiting_name":
      await handleAwaitingName(row, message.text);
      return;
    case "awaiting_email":
      await handleAwaitingEmail(row, message.text);
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
