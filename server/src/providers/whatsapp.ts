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

export interface IncomingWhatsAppMessage {
  from: string;
  text: string;
  messageId: string;
}

interface WebhookPayload {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: Array<{
          from?: string;
          id?: string;
          type?: string;
          text?: { body?: string };
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
          messages.push({ from: m.from, text: m.text.body, messageId: m.id });
        }
      }
    }
  }
  return messages;
}
