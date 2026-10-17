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

/** A message with up to three tappable reply buttons under it. */
export async function sendJoyceButtons(
  to: string,
  text: string,
  buttons: { id: string; title: string }[]
): Promise<void> {
  await post({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text },
      action: {
        buttons: buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })),
      },
    },
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

/** A photo or file attached to an inbound message. The bytes are fetched separately. */
export interface JoyceInboundMedia {
  mediaId: string;
  mimeType: string;
  /** Only documents carry one; WhatsApp photos arrive unnamed. */
  filename?: string;
}

export interface JoyceInboundMessage {
  /** The number that sent it. */
  from: string;
  /** Meta's id for this message, used for dedupe and the typing indicator. */
  messageId: string;
  /** The message text, or a photo/file's caption ("" when it has none). */
  text: string;
  media?: JoyceInboundMedia;
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
          image?: { id?: string; mime_type?: string; caption?: string };
          document?: { id?: string; mime_type?: string; filename?: string; caption?: string };
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
 * Text, button/list replies, photos and documents are extracted. Anything else (voice notes,
 * stickers, locations) is ignored rather than half-handled.
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
        } else if (m.type === "image" && m.image?.id && m.image.mime_type) {
          out.push({
            from: m.from,
            messageId: m.id,
            text: m.image.caption ?? "",
            media: { mediaId: m.image.id, mimeType: m.image.mime_type },
            toPhoneNumberId,
          });
        } else if (m.type === "document" && m.document?.id && m.document.mime_type) {
          out.push({
            from: m.from,
            messageId: m.id,
            text: m.document.caption ?? "",
            media: {
              mediaId: m.document.id,
              mimeType: m.document.mime_type,
              filename: m.document.filename,
            },
            toPhoneNumberId,
          });
        }
      }
    }
  }
  return out;
}

/**
 * Meta's media download is two steps: resolve the short-lived CDN URL from the media id, then
 * fetch the bytes from it. Both calls need the bearer token.
 */
export async function downloadJoyceMedia(mediaId: string): Promise<Buffer> {
  const auth = { Authorization: `Bearer ${token()}` };
  const metaRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`, {
    headers: auth,
  });
  if (!metaRes.ok) {
    throw new Error(`Joyce media lookup failed (${metaRes.status}): ${await metaRes.text()}`);
  }
  const { url } = (await metaRes.json()) as { url?: string };
  if (!url) throw new Error("Joyce media lookup returned no URL");

  const fileRes = await fetch(url, { headers: auth });
  if (!fileRes.ok) {
    throw new Error(`Joyce media download failed (${fileRes.status}): ${await fileRes.text()}`);
  }
  return Buffer.from(await fileRes.arrayBuffer());
}

/**
 * Sends a saved file back. JPEG and PNG go out as an inline photo, the only two image types
 * WhatsApp renders that way; everything else goes as a downloadable document.
 */
export async function sendJoyceMedia(
  to: string,
  buffer: Buffer,
  mimeType: string,
  filename: string
): Promise<void> {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", new Blob([new Uint8Array(buffer)], { type: mimeType }), filename);
  const uploadRes = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${joycePhoneNumberId()}/media`,
    { method: "POST", headers: { Authorization: `Bearer ${token()}` }, body: form }
  );
  if (!uploadRes.ok) {
    throw new JoyceSendError(
      `Joyce media upload failed (${uploadRes.status}): ${await uploadRes.text()}`
    );
  }
  const { id } = (await uploadRes.json()) as { id?: string };
  if (!id) throw new JoyceSendError("Joyce media upload returned no id");

  const asImage = mimeType === "image/jpeg" || mimeType === "image/png";
  await post({
    messaging_product: "whatsapp",
    to,
    type: asImage ? "image" : "document",
    ...(asImage ? { image: { id } } : { document: { id, filename } }),
  });
}
