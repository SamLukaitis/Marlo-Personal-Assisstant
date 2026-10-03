import crypto from "node:crypto";

// Joyce's own WhatsApp plumbing. This deliberately duplicates a little of
// providers/whatsapp.ts rather than adding a "which number?" parameter to Marlowe's senders:
// a shared sender is a shared code path, and a shared code path is somewhere a future change can
// accidentally route a family's message out through Marlowe's number or vice versa. Joyce's
// number, token and secrets are separate env vars, read only here.
//
// The token and app secret fall back to Marlowe's because both are *app*-level credentials on
// Meta's side — if Joyce's number sits in the same WhatsApp Business Account, they genuinely are
// the same values. The phone number id never falls back: it is what distinguishes the two
// numbers, and guessing it wrong would send Joyce's replies from Marlowe's number.

const GRAPH_VERSION = "v21.0";

export function joycePhoneNumberId(): string | undefined {
  return process.env.JOYCE_WHATSAPP_PHONE_NUMBER_ID;
}

function token(): string | undefined {
  return process.env.JOYCE_WHATSAPP_TOKEN ?? process.env.WHATSAPP_TOKEN;
}

function appSecret(): string | undefined {
  return process.env.JOYCE_WHATSAPP_APP_SECRET ?? process.env.WHATSAPP_APP_SECRET;
}

export function isJoyceWhatsAppConfigured(): boolean {
  return !!(token() && joycePhoneNumberId() && process.env.JOYCE_WHATSAPP_VERIFY_TOKEN);
}

export function verifyJoyceWebhookChallenge(mode: string, verifyToken: string): boolean {
  const expected = process.env.JOYCE_WHATSAPP_VERIFY_TOKEN;
  return mode === "subscribe" && !!expected && verifyToken === expected;
}

export function verifyJoyceWebhookSignature(rawBody: Buffer, signatureHeader?: string): boolean {
  const secret = appSecret();
  if (!secret || !signatureHeader) return false;
  const expected =
    "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export class JoyceSendError extends Error {
  constructor(message: string, public readonly code?: number) {
    super(message);
    this.name = "JoyceSendError";
  }
}

async function post(body: unknown): Promise<Response> {
  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${joycePhoneNumberId()}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let code: number | undefined;
    try {
      code = JSON.parse(text)?.error?.code;
    } catch {
      // Non-JSON error body — leave code undefined rather than inventing one.
    }
    throw new JoyceSendError(`Joyce WhatsApp send failed (${res.status}): ${text}`, code);
  }
  return res;
}

export async function sendJoyceMessage(to: string, text: string): Promise<void> {
  await post({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text, preview_url: false },
  });
}

export async function sendJoyceTypingIndicator(messageId: string): Promise<void> {
  await post({
    messaging_product: "whatsapp",
    status: "read",
    message_id: messageId,
    typing_indicator: { type: "text" },
  });
}

export interface JoyceInboundMessage {
  /** The number that sent it. */
  from: string;
  /** Meta's id for this message, used for dedupe and the typing indicator. */
  messageId: string;
  text: string;
  /** Which of our numbers it was addressed to — see extractJoyceMessages. */
  toPhoneNumberId: string | undefined;
}

interface WebhookPayload {
  entry?: Array<{
    changes?: Array<{
      value?: {
        metadata?: { phone_number_id?: string };
        messages?: Array<{
          from?: string;
          id?: string;
          type?: string;
          text?: { body?: string };
          interactive?: {
            type?: string;
            button_reply?: { id?: string; title?: string };
            list_reply?: { id?: string; title?: string };
          };
        }>;
      };
    }>;
  }>;
}

/**
 * Pulls inbound messages out of a webhook payload, keeping `metadata.phone_number_id` — the
 * field that says which of our numbers Meta delivered this to.
 *
 * This matters more than it looks. Meta configures a webhook URL per *app*, not per number, so
 * if Joyce's number is added to the same WhatsApp Business Account as Marlowe's, both numbers'
 * messages arrive at both endpoints. Without checking this field, Marlowe would treat a family's
 * message to Joyce as an unrecognised number and start its own signup flow at them, and Joyce
 * would answer people trying to reach Marlowe. Both handlers therefore drop anything not
 * addressed to their own number. See the same guard in routes/whatsappRoutes.ts.
 *
 * Only plain text and button/list replies are extracted for now: the prototype's onboarding and
 * assistant are text-driven, and silently ignoring a photo is better than half-handling it.
 */
export function extractJoyceMessages(payload: WebhookPayload): JoyceInboundMessage[] {
  const out: JoyceInboundMessage[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const toPhoneNumberId = change.value?.metadata?.phone_number_id;
      for (const m of change.value?.messages ?? []) {
        if (!m.from || !m.id) continue;
        if (m.type === "text" && m.text?.body) {
          out.push({ from: m.from, messageId: m.id, text: m.text.body, toPhoneNumberId });
        } else if (m.type === "interactive") {
          const title =
            m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title;
          if (title) out.push({ from: m.from, messageId: m.id, text: title, toPhoneNumberId });
        }
      }
    }
  }
  return out;
}
