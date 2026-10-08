import crypto from "node:crypto";
import { recordSimMessage } from "./whatsappSimTranscript.js";

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

// --- WhatsApp Simulator support ------------------------------------------------------------
// The in-app WhatsApp Simulator (routes/whatsappSimRoutes.ts) drives a typed message through the
// real inbound pipeline (handleIncoming in whatsappRoutes.ts) so Sam/Jake can exercise
// registration, debouncing, choice buttons, etc. from a browser instead of a real phone. Every
// send function below checks for a simulated target first and returns without calling Meta's
// Graph API — this is what stops a simulated conversation from erroring against a fake number or,
// worse, actually texting a real one — and records what it would have sent in the simulator's
// transcript (whatsappSimTranscript.ts) so the page can show it. "999" is unassigned as an ITU
// country code, so nothing under it can collide with a genuine WhatsApp number.
//
// Two ranges under it: 999000<ownerId> is an admin's own account ("chat as me"), and
// 999100<6 random digits> is a throwaway test user that goes through signup from scratch.
const SIMULATED_PHONE_PREFIX = "999";
const SIMULATED_OWNER_PREFIX = "999000";
const SIMULATED_TEST_USER_PREFIX = "999100";
function digitsOf(phone: string): string {
  return phone.replace(/[^0-9]/g, "");
}
export function simulatedPhoneForOwner(ownerId: number): string {
  return `${SIMULATED_OWNER_PREFIX}${ownerId}`;
}
export function newSimulatedTestUserPhone(): string {
  return `${SIMULATED_TEST_USER_PREFIX}${crypto.randomInt(0, 1_000_000).toString().padStart(6, "0")}`;
}
export function isSimulatedPhone(phone: string): boolean {
  return digitsOf(phone).startsWith(SIMULATED_PHONE_PREFIX);
}
export function isSimulatedTestUserPhone(phone: string): boolean {
  const digits = digitsOf(phone);
  return digits.startsWith(SIMULATED_TEST_USER_PREFIX) && digits.length === SIMULATED_TEST_USER_PREFIX.length + 6;
}
function isSimulatedMessageId(messageId: string): boolean {
  return messageId.startsWith("sim-");
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

// Thrown by any Graph send call below. `code` is Meta's own error.code (e.g. 131047 — "outside
// the 24h customer service window") when the response body parses as their standard error
// shape; undefined if it doesn't, so callers checking a specific code can't mistake a malformed
// or unrelated failure for that one.
export class WhatsAppSendError extends Error {
  constructor(message: string, public readonly code?: number) {
    super(message);
    this.name = "WhatsAppSendError";
  }
}

async function buildSendError(prefix: string, res: Response): Promise<WhatsAppSendError> {
  const bodyText = await res.text();
  let code: number | undefined;
  try {
    code = (JSON.parse(bodyText) as { error?: { code?: number } })?.error?.code;
  } catch {
    // non-JSON body — leave code undefined, message still carries the raw text below
  }
  return new WhatsAppSendError(`${prefix} (${res.status}): ${bodyText}`, code);
}

// Pulls the sent message's wamid out of a successful send response — Meta's Cloud API returns
// `{ messages: [{ id: "wamid...." }] }` on every successful send. Used so a later swipe-to-reply
// to something Marlowe sent can be resolved (see db/store.ts's whatsapp_message_wamids). Reads via
// res.text() + JSON.parse rather than res.json(), same as buildSendError above, and never throws —
// an unparseable/unexpected body just means the reply can't be resolved later, not a failed send.
async function extractSentWamid(res: Response): Promise<string | undefined> {
  try {
    const body = JSON.parse(await res.text()) as { messages?: Array<{ id?: string }> };
    return body.messages?.[0]?.id;
  } catch {
    return undefined;
  }
}

export async function sendWhatsAppMessage(to: string, text: string): Promise<string | undefined> {
  if (isSimulatedPhone(to)) {
    recordSimMessage(to, { role: "assistant", text });
    return `sim-wamid-${crypto.randomUUID()}`;
  }
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
    throw await buildSendError("WhatsApp send failed", res);
  }
  return extractSentWamid(res);
}

// Up to 3 tappable quick-reply buttons under a text prompt — used for closed-set questions
// (provider choice, yes/no preference questions) instead of asking the person to type a reply.
// Each button's title is capped at 20 characters by WhatsApp; longer titles are silently
// truncated by Meta, so keep them short. A tap comes back as an IncomingInteractiveMessage
// (extractIncomingMessages above) carrying the same id given here.
export async function sendWhatsAppReplyButtons(
  to: string,
  bodyText: string,
  buttons: { id: string; title: string }[]
): Promise<string | undefined> {
  if (isSimulatedPhone(to)) {
    recordSimMessage(to, { role: "assistant", text: bodyText, choices: buttons.map(({ id, title }) => ({ id, title })) });
    return `sim-wamid-${crypto.randomUUID()}`;
  }
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
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: bodyText },
          action: {
            buttons: buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })),
          },
        },
      }),
    }
  );
  if (!res.ok) {
    throw await buildSendError("WhatsApp reply-buttons send failed", res);
  }
  return extractSentWamid(res);
}

// A "Send location" button under a short prompt. Tapping it opens WhatsApp's own share-location
// screen; the pin comes back as an ordinary inbound location message (IncomingLocationMessage),
// which chatDispatch.handleLocation already turns into a new assistant turn. Like every
// interactive message it can only be sent within 24h of the user's last message — it's only ever
// sent as a reply, so that always holds.
export async function sendWhatsAppLocationRequest(to: string, bodyText: string): Promise<string | undefined> {
  if (isSimulatedPhone(to)) {
    recordSimMessage(to, { role: "assistant", text: bodyText, locationRequest: true });
    return `sim-wamid-${crypto.randomUUID()}`;
  }
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
        recipient_type: "individual",
        to,
        type: "interactive",
        interactive: {
          type: "location_request_message",
          body: { text: bodyText },
          action: { name: "send_location" },
        },
      }),
    }
  );
  if (!res.ok) {
    throw await buildSendError("WhatsApp location-request send failed", res);
  }
  return extractSentWamid(res);
}

// A single tappable link button under a text prompt — used instead of a plain "here's a link"
// message. Unlike a reply button, tapping this opens the URL directly and never produces an
// inbound webhook event of its own.
export async function sendWhatsAppCtaUrl(
  to: string,
  bodyText: string,
  buttonText: string,
  url: string
): Promise<string | undefined> {
  if (isSimulatedPhone(to)) {
    recordSimMessage(to, { role: "assistant", text: bodyText, link: { label: buttonText, url } });
    return `sim-wamid-${crypto.randomUUID()}`;
  }
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
        type: "interactive",
        interactive: {
          type: "cta_url",
          body: { text: bodyText },
          action: {
            name: "cta_url",
            parameters: { display_text: buttonText, url },
          },
        },
      }),
    }
  );
  if (!res.ok) {
    throw await buildSendError("WhatsApp CTA-url send failed", res);
  }
  return extractSentWamid(res);
}

// A tappable menu of up to 10 rows in one section — used for closed-set questions with more
// options than fit as buttons (WhatsApp caps buttons at 3). A tap comes back as an
// IncomingInteractiveMessage (extractIncomingMessages below) carrying the row's id, exactly like
// a button tap does.
export async function sendWhatsAppListMessage(
  to: string,
  bodyText: string,
  buttonLabel: string,
  rows: { id: string; title: string; description?: string }[]
): Promise<string | undefined> {
  if (isSimulatedPhone(to)) {
    recordSimMessage(to, { role: "assistant", text: bodyText, choices: rows.map(({ id, title }) => ({ id, title })) });
    return `sim-wamid-${crypto.randomUUID()}`;
  }
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
        type: "interactive",
        interactive: {
          type: "list",
          body: { text: bodyText },
          action: {
            button: buttonLabel,
            sections: [
              {
                rows: rows.map((r) => ({
                  id: r.id,
                  title: r.title,
                  ...(r.description ? { description: r.description } : {}),
                })),
              },
            ],
          },
        },
      }),
    }
  );
  if (!res.ok) {
    throw await buildSendError("WhatsApp list-message send failed", res);
  }
  return extractSentWamid(res);
}

// Meta's hard limits for interactive messages — anything over these is rejected outright, not
// truncated. Choice labels and questions come from the model (ask_user_choice), so they're
// enforced here rather than trusted.
const MAX_INTERACTIVE_BODY = 1024;
const MAX_TEXT_BODY = 4096;
const MAX_BUTTONS = 3;
const MAX_BUTTON_TITLE = 20;
const MAX_LIST_ROWS = 10;
const MAX_LIST_ROW_TITLE = 24;
const MAX_LIST_ROW_DESCRIPTION = 72;
const FALLBACK_CHOICE_PROMPT = "What would you like to do?";

function truncateLabel(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

// Splits text into plain-message-sized pieces, preferring to break at a newline.
function splitForTextMessages(text: string): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > MAX_TEXT_BODY) {
    const breakAt = rest.lastIndexOf("\n", MAX_TEXT_BODY);
    const cut = breakAt > 0 ? breakAt : MAX_TEXT_BODY;
    pieces.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest.trim()) pieces.push(rest);
  return pieces;
}

// Picks buttons (WhatsApp caps these at 3) or a list (up to 10) based on how many choices there
// are — callers building a closed-set question use this instead of choosing between
// sendWhatsAppReplyButtons and sendWhatsAppListMessage themselves.
//
// A question too long for an interactive body (e.g. a full email draft) goes out as a plain
// message first, with the buttons following under its last paragraph (usually the actual
// question, "Ready to send this?"). Labels that don't fit a button use a list instead, where the
// full label can go in the row description.
//
// Returns the wamid and text of every message it sent (plain pieces, then the buttons/list), so
// the caller can record them and a swipe-reply on any part resolves to that part.
export async function sendChoiceMessage(
  to: string,
  bodyText: string,
  choices: { id: string; title: string }[]
): Promise<{ wamid: string; text: string }[]> {
  const parts: { wamid: string; text: string }[] = [];
  const keep = (wamid: string | undefined, text: string) => {
    if (wamid) parts.push({ wamid, text });
  };

  let prompt = bodyText;
  if (bodyText.length > MAX_INTERACTIVE_BODY) {
    for (const piece of splitForTextMessages(bodyText)) {
      keep(await sendWhatsAppMessage(to, piece), piece);
    }
    const lastParagraph = bodyText.trim().split(/\n\s*\n/).pop()?.trim() ?? "";
    prompt = lastParagraph && lastParagraph.length <= MAX_INTERACTIVE_BODY ? lastParagraph : FALLBACK_CHOICE_PROMPT;
  }

  const labelsFitButtons = choices.every((c) => c.title.length <= MAX_BUTTON_TITLE);
  if (choices.length <= MAX_BUTTONS && labelsFitButtons) {
    keep(await sendWhatsAppReplyButtons(to, prompt, choices), prompt);
    return parts;
  }

  const rows = choices.slice(0, MAX_LIST_ROWS).map((c) =>
    c.title.length <= MAX_LIST_ROW_TITLE
      ? c
      : {
          id: c.id,
          title: truncateLabel(c.title, MAX_LIST_ROW_TITLE),
          description: truncateLabel(c.title, MAX_LIST_ROW_DESCRIPTION),
        }
  );
  keep(await sendWhatsAppListMessage(to, prompt, "Choose", rows), prompt);
  return parts;
}

// Uploads raw bytes to Meta so they can be referenced by media id in a subsequent send call —
// Meta doesn't accept inline bytes on the /messages endpoint itself, media has to be uploaded
// first and then referenced by the id this returns.
async function uploadWhatsAppMedia(buffer: Buffer, mimeType: string, filename: string): Promise<string> {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", new Blob([new Uint8Array(buffer)], { type: mimeType }), filename);
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) {
    throw await buildSendError("WhatsApp media upload failed", res);
  }
  const data = (await res.json()) as { id?: string };
  if (!data.id) throw new Error("WhatsApp media upload returned no id");
  return data.id;
}

// Sends the original bytes of a saved document/photo back to the user — e.g. "send me that
// photo" after Marlowe has already described what's in it. Real photos (jpeg/png — the two types
// WhatsApp's Cloud API will render as an inline image) go out as `type: "image"`; everything else
// (pdf, gif/webp, plain text) goes out as `type: "document"` with a filename, which WhatsApp
// renders as a downloadable file instead.
export async function sendWhatsAppMediaFromBuffer(
  to: string,
  buffer: Buffer,
  mimeType: string,
  filename: string
): Promise<string | undefined> {
  const asImage = mimeType === "image/jpeg" || mimeType === "image/png";
  if (isSimulatedPhone(to)) {
    recordSimMessage(to, { role: "assistant", text: `[${asImage ? "photo" : "document"}: ${filename}]` });
    return `sim-wamid-${crypto.randomUUID()}`;
  }
  const mediaId = await uploadWhatsAppMedia(buffer, mimeType, filename);
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
        type: asImage ? "image" : "document",
        ...(asImage
          ? { image: { id: mediaId } }
          : { document: { id: mediaId, filename } }),
      }),
    }
  );
  if (!res.ok) {
    throw await buildSendError("WhatsApp media message send failed", res);
  }
  return extractSentWamid(res);
}

// The two pre-approved utility templates outbound.ts falls back to once the 24h customer-service
// window has closed (see recordInboundMessage/getLastInboundAt in db/store.ts) — Meta rejects a
// free-form send past that window with error 131047, but a template always goes through.
// `marlowe_alert` body: "Update from Marlowe: {{update_text}} Reply to this chat with any
// questions." — covers every short, single-event push (Schengen warnings, important-email/
// memory/reconciliation/Xero notifications).
// `marlowe_digest` body: "Your Marlowe briefing: {{briefing_text}} Tap below to see the full
// details." plus a static URL button — the one multi-paragraph push (the daily briefing).
// Both must exist and be approved in the Meta Business dashboard with this exact body text
// (Meta now requires named variables, not positional {{1}}) before this will work in production.
export type WhatsAppTemplateName = "marlowe_alert" | "marlowe_digest";

// Each template's body variable is named, not positional — the send call has to reference it by
// this exact name (`parameter_name`) or Meta rejects the send even though the template is approved.
const TEMPLATE_PARAM_NAME: Record<WhatsAppTemplateName, string> = {
  marlowe_alert: "update_text",
  marlowe_digest: "briefing_text",
};

// Every approved template here uses this language code — change it here (and when re-creating
// the templates) if that ever needs to differ.
const TEMPLATE_LANGUAGE_CODE = "en_US";

export async function sendWhatsAppTemplate(
  to: string,
  templateName: WhatsAppTemplateName,
  bodyParam: string
): Promise<string | undefined> {
  if (isSimulatedPhone(to)) {
    recordSimMessage(to, { role: "assistant", text: `[template ${templateName}] ${bodyParam}` });
    return `sim-wamid-${crypto.randomUUID()}`;
  }
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
        type: "template",
        template: {
          name: templateName,
          language: { code: TEMPLATE_LANGUAGE_CODE },
          components: [
            {
              type: "body",
              parameters: [
                {
                  type: "text",
                  parameter_name: TEMPLATE_PARAM_NAME[templateName],
                  text: bodyParam,
                },
              ],
            },
          ],
        },
      }),
    }
  );
  if (!res.ok) {
    throw await buildSendError("WhatsApp template send failed", res);
  }
  return extractSentWamid(res);
}

// Reacts to a message with a single emoji instead of sending a text reply — used when a full
// reply isn't warranted (see assistant.ts's react_to_message tool). `emoji: ""` removes a
// reaction previously sent to this message id; not used by any caller yet, but free to support
// since it's the same Graph call shape.
export async function sendWhatsAppReaction(to: string, messageId: string, emoji: string): Promise<void> {
  if (isSimulatedPhone(to)) {
    recordSimMessage(to, { role: "assistant", text: emoji ? `[reacted ${emoji}]` : "[removed reaction]" });
    return;
  }
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
        type: "reaction",
        reaction: { message_id: messageId, emoji },
      }),
    }
  );
  if (!res.ok) {
    throw await buildSendError("WhatsApp reaction send failed", res);
  }
}

// Marks the incoming message read and shows WhatsApp's native "..." typing indicator to the
// user — Meta shows it for up to 25 seconds or until we actually reply, whichever comes first.
// Best-effort by design (callers fire-and-forget this): a full assistant turn with tool calls
// can take several seconds, and without this the user has no sign anything is happening.
export async function sendWhatsAppTypingIndicator(messageId: string): Promise<void> {
  if (isSimulatedMessageId(messageId)) return;
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

// quotedMessageId/forwarded both come from Meta's `context` field on the inbound message.
// quotedMessageId is the wamid of the message a swipe-to-reply targeted — set only when the user
// replied to a specific earlier message (theirs, or one Marlowe sent), and resolvable via
// db/store.ts's getWhatsAppMessageByWamid/getDocumentByWamid no matter how long ago it was sent.
// forwarded means the message arrived via WhatsApp's "Forward" action; Meta does not expose the
// original chat/message it came from (only this boolean), so there's nothing to look up for a
// forward — the forwarded content itself just arrives as this message's own text/media.
export interface IncomingTextMessage {
  kind: "text";
  from: string;
  text: string;
  messageId: string;
  quotedMessageId?: string;
  forwarded?: boolean;
}

export interface IncomingMediaMessage {
  kind: "media";
  from: string;
  messageId: string;
  mediaId: string;
  mimeType: string;
  filename?: string;
  caption?: string;
  quotedMessageId?: string;
  forwarded?: boolean;
}

// A tap on a reply-button message sent by sendWhatsAppReplyButtons — buttonId is whatever id we
// gave that button when sending it (e.g. "briefing_yes"). WhatsApp's "cta_url" button (used by
// sendWhatsAppCtaUrl) is a plain link tap, not a webhook event, so it never produces one of these.
export interface IncomingInteractiveMessage {
  kind: "interactive";
  from: string;
  messageId: string;
  buttonId: string;
}

// A tap/removal of an emoji reaction on a message we sent — emoji is "" when the person removed
// a reaction they'd previously left, not a malformed payload, so it's parsed the same as a
// present reaction rather than dropped. reactedToMessageId is the original message's wamid, not
// this event's own id (messageId, below).
export interface IncomingReactionMessage {
  kind: "reaction";
  from: string;
  messageId: string;
  reactedToMessageId: string;
  emoji: string;
}

// A location the user dropped as a pin (or picked from a saved/named place). WhatsApp always
// sends latitude/longitude; name/address are only present when the user picked a named place
// rather than dropping a raw pin.
export interface IncomingLocationMessage {
  kind: "location";
  from: string;
  messageId: string;
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
}

// Any inbound message type we don't have a real handler for yet (audio/voice, sticker, contacts,
// video, ...). `type` is Meta's raw type string, kept so the caller can log what actually came in
// rather than a generic "something unsupported".
export interface IncomingUnsupportedMessage {
  kind: "unsupported";
  from: string;
  messageId: string;
  type: string;
}

export type IncomingWhatsAppMessage =
  | IncomingTextMessage
  | IncomingMediaMessage
  | IncomingInteractiveMessage
  | IncomingReactionMessage
  | IncomingLocationMessage
  | IncomingUnsupportedMessage;

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
          reaction?: { message_id?: string; emoji?: string };
          location?: { latitude?: number; longitude?: number; name?: string; address?: string };
          context?: { id?: string; forwarded?: boolean };
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

const HANDLED_TYPES = new Set(["text", "image", "document", "interactive", "reaction", "location"]);

export function extractIncomingMessages(payload: WebhookPayload): IncomingWhatsAppMessage[] {
  const messages: IncomingWhatsAppMessage[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const m of change.value?.messages ?? []) {
        // Present on any inbound message type whose sender swipe-replied to (context.id) or
        // forwarded (context.forwarded) it — spread in below so a message with no context keeps
        // exactly its old shape (no stray `undefined`-valued keys).
        const quoteFields = {
          ...(m.context?.id ? { quotedMessageId: m.context.id } : {}),
          ...(m.context?.forwarded ? { forwarded: true as const } : {}),
        };

        if (m.type === "text" && m.from && m.text?.body && m.id) {
          messages.push({ kind: "text", from: m.from, text: m.text.body, messageId: m.id, ...quoteFields });
        } else if (m.type === "image" && m.from && m.id && m.image?.id && m.image.mime_type) {
          messages.push({
            kind: "media",
            from: m.from,
            messageId: m.id,
            mediaId: m.image.id,
            mimeType: m.image.mime_type,
            caption: m.image.caption,
            ...quoteFields,
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
            ...quoteFields,
          });
        } else if (
          m.type === "location" &&
          m.from &&
          m.id &&
          m.location?.latitude !== undefined &&
          m.location.longitude !== undefined
        ) {
          messages.push({
            kind: "location",
            from: m.from,
            messageId: m.id,
            latitude: m.location.latitude,
            longitude: m.location.longitude,
            name: m.location.name,
            address: m.location.address,
          });
        } else if (
          m.type === "interactive" &&
          m.from &&
          m.id &&
          m.interactive?.type === "button_reply" &&
          m.interactive.button_reply?.id
        ) {
          messages.push({
            kind: "interactive",
            from: m.from,
            messageId: m.id,
            buttonId: m.interactive.button_reply.id,
          });
        } else if (
          m.type === "interactive" &&
          m.from &&
          m.id &&
          m.interactive?.type === "list_reply" &&
          m.interactive.list_reply?.id
        ) {
          messages.push({
            kind: "interactive",
            from: m.from,
            messageId: m.id,
            buttonId: m.interactive.list_reply.id,
          });
        } else if (
          m.type === "reaction" &&
          m.from &&
          m.id &&
          m.reaction?.message_id &&
          m.reaction.emoji !== undefined
        ) {
          // emoji === "" means the person removed a reaction they'd left earlier — a real event,
          // not a malformed payload, so it's parsed the same as a present emoji rather than
          // falling through to the unsupported branch below.
          messages.push({
            kind: "reaction",
            from: m.from,
            messageId: m.id,
            reactedToMessageId: m.reaction.message_id,
            emoji: m.reaction.emoji,
          });
        } else if (m.from && m.id && !HANDLED_TYPES.has(m.type ?? "")) {
          // A genuinely different message type we don't have a real handler for (audio/voice,
          // sticker, contacts, video, ...) — routed somewhere rather than silently dropped, as
          // long as we at least know who to reply to. See handleIncoming's "unsupported" branch.
          // Deliberately excludes text/image/document/interactive: a
          // malformed payload of a type we DO handle (missing a required nested field) stays
          // silently dropped rather than surfacing a confusing "can't read that" reply for what's
          // really a corrupt button tap or the like.
          messages.push({ kind: "unsupported", from: m.from, messageId: m.id, type: m.type ?? "unknown" });
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
