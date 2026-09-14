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
import { getWhatsAppHistory } from "../db/store.js";
import { runAssistantChat, MAX_HISTORY_MESSAGES, type ChatMessage } from "../ai/assistant.js";
import { sendAssistantReply } from "./whatsappReply.js";
import { sendWhatsAppMessage } from "../providers/whatsapp.js";

export const SHORT_DEBOUNCE_MS = Number(process.env.WHATSAPP_DEBOUNCE_SHORT_MS ?? 1500);
export const LONG_DEBOUNCE_MS = Number(process.env.WHATSAPP_DEBOUNCE_LONG_MS ?? 5000);

interface BufferedEntry {
  override: string | null;
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
// persisted line is already what the model should see. fastPath is looksComplete(text) for text
// messages, true for location, and looksComplete(caption) (or false with no caption) for media.
export function queueForAssistant(
  ownerId: number,
  from: string,
  messageId: string,
  contentOverride: string | null,
  fastPath: boolean
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
  state.entries.push({ override: contentOverride });
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

  try {
    const history: ChatMessage[] = getWhatsAppHistory(from, MAX_HISTORY_MESSAGES).map((m) => ({
      role: m.role,
      content: m.content,
    }));

    // Splice each buffered message's override into the history position it corresponds to (the
    // last entries.length rows, in the same order they were appended) — a plain-text message with
    // no override leaves the persisted row untouched.
    const start = Math.max(0, history.length - entries.length);
    for (let i = 0; i < entries.length; i++) {
      const { override } = entries[i];
      if (override === null) continue;
      const idx = start + i;
      if (idx < history.length) {
        history[idx] = { role: "user", content: override };
      } else {
        history.push({ role: "user", content: override });
      }
    }

    const reply = await runAssistantChat(ownerId, history, from);
    await sendAssistantReply(ownerId, from, reply, replyToMessageId);
  } catch (err) {
    console.error("whatsapp: batched assistant call failed", err);
    await sendWhatsAppMessage(
      from,
      "Sorry, I hit an error handling that — check the server logs."
    ).catch(() => {});
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
