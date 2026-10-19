// Picks which model answers a chat message. "Fast-first" routing (on for admins by default — see
// FAST_FIRST_MODE) sends most messages to the cheap fast model and steps up to the strong model
// when:
//   1. the message is an obvious heavy task (drafting, planning, judgement — HEAVY_PATTERNS);
//   2. the fast model calls escalate_to_stronger_model itself (handled in assistant.ts);
//   3. the user pushes back on a reply the fast model gave (PUSHBACK_PATTERNS);
//   4. the fast model refuses (handled in assistant.ts).
// After 2–4 the conversation stays on the strong model for a few messages ("sticky"), so it
// doesn't bounce back to the model the user just complained about, and so the strong model's
// prompt cache (caches are per model) gets reused rather than thrown away.
//
// The per-owner state (last model, sticky window) is in memory: a restart just means the next
// message routes fresh, which is harmless.
import { isAdmin } from "../db/store.js";

export const MODEL_FAST = process.env.ASSISTANT_MODEL_FAST ?? "claude-haiku-5-5";
export const MODEL_STRONG = process.env.ASSISTANT_MODEL_COMPLEX ?? "claude-sonnet-5-5";
// Legacy cheap tier, used when fast-first routing is off for this owner.
const MODEL_LEGACY_SIMPLE = process.env.ASSISTANT_MODEL_SIMPLE ?? "claude-haiku-4-5";

// "off" = legacy keyword routing for everyone, "admins" = fast-first for admin accounts only (the
// default while it's being tried out), "all" = fast-first for everyone.
type FastFirstMode = "off" | "admins" | "all";
function fastFirstMode(): FastFirstMode {
  const v = process.env.ASSISTANT_FAST_FIRST;
  return v === "off" || v === "all" ? v : "admins";
}

export function isFastFirstEnabled(ownerId: number): boolean {
  const mode = fastFirstMode();
  return mode === "all" || (mode === "admins" && isAdmin(ownerId));
}

const HEAVY_PATTERNS = [
  /\bdraft\b/i, /\bwrite\b/i, /\bcompose\b/i, /\breply to\b/i, /\brespond to\b/i,
  /\bplan\b/i, /\banaly[sz]e\b/i, /\bcompare\b/i, /\bshould i\b/i, /\bwhy\b/i,
  /\bdecide\b/i, /\bstrategy\b/i, /\bnegotiate\b/i, /\bin depth\b/i, /\bdetailed\b/i,
  /\brecommend\b/i, /\bthink about\b/i, /\bhow many days\b/i,
];
// Only used by legacy routing: fast-first sends everything that isn't heavy to the fast model.
const LEGACY_SIMPLE_PATTERNS = [
  /\bsummari[sz]e\b/i, /\bwhat'?s (new|on|unread|upcoming)\b/i, /\bany new\b/i,
  /\blist\b/i, /\bshow me\b/i, /\bwhat (is|are)\b/i, /\bcheck\b/i, /\bfind\b/i,
  /\bsearch\b/i, /\bwhen is\b/i, /\bunread\b/i, /\btoday'?s\b/i, /\barchive\b/i,
];

// The user saying the last answer wasn't good enough. Kept specific on purpose: "no thanks" or
// "no, that's fine" must not count, but a bare "no", "no, I meant…" or "that's wrong" should.
const PUSHBACK_PATTERNS = [
  /^\s*no[\s.!?]*$/i,
  /^\s*no,?\s+(i|you|that|it|the)\b(?!.*\b(fine|thanks|thank you|worries|problem|need)\b)/i,
  /^\s*\?+\s*$/,
  /\b(that'?s|this is|that is|it'?s|you'?re|you are)\s+(wrong|incorrect|not right|not correct|useless|rubbish|not helpful|unhelpful)\b/i,
  /\bnot what i (asked|meant|wanted|said)\b/i,
  /\b(you )?(misunderstood|misread)\b/i,
  /\byou (didn'?t|did not|don'?t) (understand|get it|answer|listen|read)\b/i,
  /\b(i (already )?(said|told you|asked))\b/i,
  /\b(try again|do better|wrong answer|makes no sense|doesn'?t make sense|that'?s not it)\b/i,
  /\b(more detail|be more specific|more specific|go deeper|not enough)\b/i,
];

export function looksLikePushback(message: string): boolean {
  return PUSHBACK_PATTERNS.some((p) => p.test(message));
}

export type RouteReason = "legacy" | "fast" | "heavy-task" | "pushback" | "sticky";

const STICKY_MESSAGES = 4;
const STICKY_MS = 30 * 60 * 1000;
const lastModelByOwner = new Map<number, string>();
const stickyByOwner = new Map<number, { messagesLeft: number; until: number }>();

// Called once per incoming user message, before the first API call.
export function routeModel(ownerId: number, latestUserMessage: string, now = Date.now()): { model: string; reason: RouteReason } {
  if (!isFastFirstEnabled(ownerId)) {
    if (HEAVY_PATTERNS.some((p) => p.test(latestUserMessage))) return { model: MODEL_STRONG, reason: "legacy" };
    if (LEGACY_SIMPLE_PATTERNS.some((p) => p.test(latestUserMessage))) return { model: MODEL_LEGACY_SIMPLE, reason: "legacy" };
    return { model: MODEL_STRONG, reason: "legacy" }; // unmatched phrasing defaults to the safer tier
  }
  const sticky = stickyByOwner.get(ownerId);
  if (sticky && sticky.messagesLeft > 0 && now < sticky.until) {
    sticky.messagesLeft--;
    return { model: MODEL_STRONG, reason: "sticky" };
  }
  stickyByOwner.delete(ownerId);
  if (HEAVY_PATTERNS.some((p) => p.test(latestUserMessage))) return { model: MODEL_STRONG, reason: "heavy-task" };
  if (lastModelByOwner.get(ownerId) === MODEL_FAST && looksLikePushback(latestUserMessage)) {
    startSticky(ownerId, now);
    return { model: MODEL_STRONG, reason: "pushback" };
  }
  return { model: MODEL_FAST, reason: "fast" };
}

// The fast model escalated or refused mid-reply: keep the next few messages on the strong model.
export function startSticky(ownerId: number, now = Date.now()): void {
  stickyByOwner.set(ownerId, { messagesLeft: STICKY_MESSAGES, until: now + STICKY_MS });
}

// Which model actually wrote the reply the user is now reacting to.
export function recordReplyModel(ownerId: number, model: string): void {
  lastModelByOwner.set(ownerId, model);
}

// web_search_20260209 filters results before they reach the model (far fewer input tokens), but
// only Opus/Sonnet support it; Haiku keeps the basic version.
export function supportsDynamicWebSearch(model: string): boolean {
  return !model.startsWith("claude-haiku");
}

export function __resetRoutingStateForTests(): void {
  lastModelByOwner.clear();
  stickyByOwner.clear();
}
