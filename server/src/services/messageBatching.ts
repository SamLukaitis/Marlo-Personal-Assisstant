// Debounces a burst of WhatsApp messages from the same phone into a single assistant turn,
// instead of the old one-call-per-message flow (see whatsappRoutes.ts's handleIncoming/handleMedia
// and chatDispatch.ts's handleText/handleLocation/handleLink, all of which now call
// queueForAssistant as their last step instead of runAssistantChat/sendAssistantReply directly).
//
// Each arriving message resets a per-phone timer; when it fires, every message buffered since the
// last flush is folded into one runAssistantChat call and one reply, anchored to the last
// message's id. The delay is picked per message via looksComplete below — a message that reads as
// a finished thought gets a short window, one that looks like it's still being typed out gets a
// longer one, and the window keeps sliding on whichever message arrived most recently.
import { getWhatsAppHistory, type WhatsAppMessageRow } from "../db/store.js";
import { runAssistantChat, MAX_HISTORY_MESSAGES, type ChatMessage } from "../ai/assistant.js";
import { sendAssistantReply } from "./whatsappReply.js";
import { sendWhatsAppMessage, sendWhatsAppTypingIndicator } from "../providers/whatsapp.js";

export const SHORT_DEBOUNCE_MS = Number(process.env.WHATSAPP_DEBOUNCE_SHORT_MS ?? 1500);
export const LONG_DEBOUNCE_MS = Number(process.env.WHATSAPP_DEBOUNCE_LONG_MS ?? 5000);

// A reply still not ready this long after the assistant call starts gets one short holding line, so
// a slow tool round trip doesn't read as silence — WhatsApp's "..." indicator vanishes after ~25s.
// Sent with sendWhatsAppMessage directly, never saved to history, so the model never sees it.
export const HOLDING_MESSAGE_MS = Number(process.env.WHATSAPP_HOLDING_MS ?? 10_000);
export const HOLDING_MESSAGES = [
  "One sec, working on it…",
  "On it, give me a moment…",
  "Bear with me, nearly there…",
  "Just a moment, still on it…",
  "Hang tight, working on that now…",
];

interface BufferedEntry {
  // The whatsapp_messages row this message was saved as. Undefined only when a caller had nothing
  // saved to point at (tests with a mocked store) — its override, if any, is then just appended.
  rowId: number | undefined;
  override: string | null;
  // Runs once the reply covering this message has been sent (or the error message, if the call
  // failed) — for a caller that must not send anything else until the user has their answer.
  afterReply?: () => Promise<void>;
}

interface BatchState {
  ownerId: number;
  entries: BufferedEntry[];
  lastMessageId: string;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  moreArrivedWhileRunning: boolean;
  lastFastPath: boolean;
}

const batches = new Map<string, BatchState>();

// Called as the last step by every handler that would otherwise call runAssistantChat directly
// for one message. contentOverride is the richer content the model should see in place of the
// persisted history line (extracted document/link text, a resolved quoted-reply) — null means the
// persisted line is already what the model should see. historyRowId is the id appendWhatsAppMessage
// returned for this message's own row. fastPath is looksComplete(text) for text messages, true for
// location, and looksComplete(caption) (or false with no caption) for media. afterReply: see
// BufferedEntry.
export function queueForAssistant(
  ownerId: number,
  from: string,
  messageId: string,
  historyRowId: number | undefined,
  contentOverride: string | null,
  fastPath: boolean,
  afterReply?: () => Promise<void>
): void {
  let state = batches.get(from);
  if (!state) {
    state = {
      ownerId,
      entries: [],
      lastMessageId: messageId,
      timer: null,
      running: false,
      moreArrivedWhileRunning: false,
      lastFastPath: fastPath,
    };
    batches.set(from, state);
  }
  state.entries.push({ rowId: historyRowId, override: contentOverride, afterReply });
  state.lastMessageId = messageId;
  state.lastFastPath = fastPath;

  if (state.running) {
    // A call for the previous batch is already in flight — don't run a second one concurrently.
    // flush()'s finally block below arms a fresh timer for this message once that call finishes.
    state.moreArrivedWhileRunning = true;
    return;
  }

  if (state.timer) clearTimeout(state.timer);
  const delay = fastPath ? SHORT_DEBOUNCE_MS : LONG_DEBOUNCE_MS;
  state.timer = setTimeout(() => void flush(from), delay);
}

async function flush(from: string): Promise<void> {
  const state = batches.get(from);
  if (!state) return;

  state.timer = null;
  state.running = true;
  const entries = state.entries;
  state.entries = [];
  const replyToMessageId = state.lastMessageId;
  const ownerId = state.ownerId;

  const wait = { done: false };
  const holdingTimer = setTimeout(() => void sendHoldingMessage(from, replyToMessageId, wait), HOLDING_MESSAGE_MS);
  try {
    const history = buildBatchHistory(getWhatsAppHistory(from, MAX_HISTORY_MESSAGES), entries);
    const reply = await runAssistantChat(ownerId, history, from);
    wait.done = true;
    clearTimeout(holdingTimer);
    await sendAssistantReply(ownerId, from, reply, replyToMessageId);
  } catch (err) {
    wait.done = true;
    clearTimeout(holdingTimer);
    console.error("whatsapp: batched assistant call failed", err);
    await sendWhatsAppMessage(
      from,
      "Sorry, I hit an error handling that — check the server logs."
    ).catch(() => {});
  }
  try {
    await runAfterReplyCallbacks(entries);
  } finally {
    state.running = false;
    if (state.moreArrivedWhileRunning) {
      state.moreArrivedWhileRunning = false;
      const delay = state.lastFastPath ? SHORT_DEBOUNCE_MS : LONG_DEBOUNCE_MS;
      state.timer = setTimeout(() => void flush(from), delay);
    } else if (state.entries.length === 0) {
      batches.delete(from);
    }
  }
}

async function sendHoldingMessage(from: string, replyToMessageId: string, wait: { done: boolean }): Promise<void> {
  const line = HOLDING_MESSAGES[Math.floor(Math.random() * HOLDING_MESSAGES.length)];
  try {
    await sendWhatsAppMessage(from, line);
    // Sending a message clears the "..." dots; bring them back for the rest of the wait — unless
    // the real reply landed while this line was in flight.
    if (!wait.done) await sendWhatsAppTypingIndicator(replyToMessageId);
  } catch (err) {
    console.error("whatsapp: holding message failed", err);
  }
}

async function runAfterReplyCallbacks(entries: BufferedEntry[]): Promise<void> {
  for (const entry of entries) {
    if (!entry.afterReply) continue;
    try {
      await entry.afterReply();
    } catch (err) {
      console.error("whatsapp: after-reply callback failed", err);
    }
  }
}

// Finds this batch's own rows by id — never by position. A reply to an earlier batch is saved after
// any message that arrived while it was being generated, and a photo's row is saved before its slow
// extraction lets it queue, so "the last N rows" is routinely the wrong set. Batched messages go
// last (in the order they were saved, with overrides swapped in) so the request always ends on what
// the user is waiting for an answer to; everything else keeps its place.
function buildBatchHistory(rows: WhatsAppMessageRow[], entries: BufferedEntry[]): ChatMessage[] {
  const overrideByRowId = new Map<number, string | null>();
  for (const entry of entries) {
    if (entry.rowId !== undefined) overrideByRowId.set(entry.rowId, entry.override);
  }

  const earlier: ChatMessage[] = [];
  const batch: ChatMessage[] = [];
  for (const row of rows) {
    if (overrideByRowId.has(row.id)) {
      batch.push({ role: "user", content: overrideByRowId.get(row.id) ?? row.content });
    } else {
      earlier.push({ role: row.role, content: row.content });
    }
  }

  // A batched row outside the history window has no saved content to fall back on — only its
  // override (if any) can still be shown.
  const rowIdsInWindow = new Set(rows.map((r) => r.id));
  for (const entry of entries) {
    const inWindow = entry.rowId !== undefined && rowIdsInWindow.has(entry.rowId);
    if (!inWindow && entry.override !== null) batch.push({ role: "user", content: entry.override });
  }

  return [...earlier, ...batch];
}

// Heuristic guess at whether a text message reads as a finished thought or as someone still
// typing it out across multiple bubbles (see queueForAssistant above, which uses this to pick a
// short vs. long debounce delay). Deliberately cheap/local — no model call — since the whole
// point is to reply fast on the common case, not spend extra latency deciding whether to.
const TRAILING_CONJUNCTIONS = ["and", "but", "so", "because", "or", "also"];

// Short standalone replies that are always a complete thought on their own, even though they
// carry no terminal punctuation (nobody types "thanks." on WhatsApp).
const COMPLETE_SHORT_REPLIES = new Set([
  "yes",
  "no",
  "ok",
  "okay",
  "sure",
  "thanks",
  "thank you",
  "done",
  "hi",
  "hello",
  "hey",
  "yep",
  "nope",
  "cool",
  "great",
]);

export function looksComplete(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;

  const normalized = trimmed.toLowerCase().replace(/[!?.]+$/, "");
  if (COMPLETE_SHORT_REPLIES.has(normalized)) return true;

  if (/\.{3}$/.test(trimmed) || trimmed.endsWith("…")) return false;
  if (/[.!?]$/.test(trimmed)) return true;
  if (/[,;:-]$/.test(trimmed)) return false;

  const words = trimmed.split(/\s+/);
  const lastWord = words[words.length - 1]?.toLowerCase().replace(/[^a-z]/g, "");
  if (lastWord && TRAILING_CONJUNCTIONS.includes(lastWord)) return false;

  return false;
}
