import crypto from "node:crypto";

const GRAPH_VERSION = "v21.0";

export function isWhatsAppConfigured(): boolean {
  return !!(
    process.env.WHATSAPP_TOKEN &&
    process.env.WHATSAPP_PHONE_NUMBER_ID &&
    process.env.WHATSAPP_VERIFY_TOKEN
  );
}

export function isWhatsAppSignatureConfigured(): boolean {
  return !!process.env.WHATSAPP_APP_SECRET;
}

export function verifyWebhookChallenge(mode: string, token: string): boolean {
  return mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN;
}

/**
 * Verifies the X-Hub-Signature-256 header Meta sends on every webhook POST, using the raw
 * request body. Without this, anyone who finds the webhook URL could POST a fake payload
 * claiming to be from an allowed number — the phone allowlist alone can't stop a spoofed sender.
 */
export function verifyWebhookSignature(rawBody: Buffer, signatureHeader?: string): boolean {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appSecret || !signatureHeader) return false;
  const expected =
    "sha256=" + crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function sendWhatsAppMessage(to: string, text: string): Promise<void> {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;
  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text },
      }),
    }
  );
  if (!res.ok) {
    throw new Error(`WhatsApp send failed (${res.status}): ${await res.text()}`);
  }
}

// Marks the incoming message read and shows WhatsApp's native "..." typing indicator to the
// user — Meta shows it for up to 25 seconds or until we actually reply, whichever comes first.
// Best-effort by design (callers fire-and-forget this): a full assistant turn with tool calls
// can take several seconds, and without this the user has no sign anything is happening.
export async function sendWhatsAppTypingIndicator(messageId: string): Promise<void> {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;
  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
        typing_indicator: { type: "text" },
      }),
    }
  );
  if (!res.ok) {
    throw new Error(`WhatsApp typing indicator failed (${res.status}): ${await res.text()}`);
  }
}

export interface IncomingTextMessage {
  kind: "text";
  from: string;
  text: string;
  messageId: string;
}

export interface IncomingMediaMessage {
  kind: "media";
  from: string;
  messageId: string;
  mediaId: string;
  mimeType: string;
  filename?: string;
  caption?: string;
}

export type IncomingWhatsAppMessage = IncomingTextMessage | IncomingMediaMessage;

interface WebhookPayload {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: Array<{
          from?: string;
          id?: string;
          type?: string;
          text?: { body?: string };
          image?: { id?: string; mime_type?: string; caption?: string };
          document?: { id?: string; mime_type?: string; filename?: string; caption?: string };
        }>;
      };
    }>;
  }>;
}

export function extractIncomingMessages(payload: WebhookPayload): IncomingWhatsAppMessage[] {
  const messages: IncomingWhatsAppMessage[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const m of change.value?.messages ?? []) {
        if (m.type === "text" && m.from && m.text?.body && m.id) {
          messages.push({ kind: "text", from: m.from, text: m.text.body, messageId: m.id });
        } else if (m.type === "image" && m.from && m.id && m.image?.id && m.image.mime_type) {
          messages.push({
            kind: "media",
            from: m.from,
            messageId: m.id,
            mediaId: m.image.id,
            mimeType: m.image.mime_type,
            caption: m.image.caption,
          });
        } else if (m.type === "document" && m.from && m.id && m.document?.id && m.document.mime_type) {
          messages.push({
            kind: "media",
            from: m.from,
            messageId: m.id,
            mediaId: m.document.id,
            mimeType: m.document.mime_type,
            filename: m.document.filename,
            caption: m.document.caption,
          });
        }
      }
    }
  }
  return messages;
}

interface MediaUrlResponse {
  url?: string;
}

// Meta's media download is two steps: resolve the (short-lived) CDN URL from the media ID,
// then fetch the actual bytes from that URL — both calls need the same bearer token.
export async function downloadWhatsAppMedia(
  mediaId: string
): Promise<{ buffer: Buffer; mimeType: string }> {
  const token = process.env.WHATSAPP_TOKEN;
  const metaRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!metaRes.ok) {
    throw new Error(`WhatsApp media lookup failed (${metaRes.status}): ${await metaRes.text()}`);
  }
  const meta = (await metaRes.json()) as MediaUrlResponse;
  if (!meta.url) throw new Error("WhatsApp media lookup returned no URL");

  const fileRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` } });
  if (!fileRes.ok) {
    throw new Error(`WhatsApp media download failed (${fileRes.status}): ${await fileRes.text()}`);
  }
  const mimeType = fileRes.headers.get("content-type") ?? "application/octet-stream";
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  return { buffer, mimeType };
}
