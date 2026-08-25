# Cross-turn tool-result grounding

## Problem

Triggered by a real incident: asked about email/bookings, Marlowe correctly found a Hostelworld
booking via `search_messages`. Next user message ("add anything that needs to be added to my
calendar"), it asserted the booking didn't exist, then reversed itself when challenged. Its own
explanation: "I didn't actually re-verify with a real search either time — I just second-guessed
based on nothing... rather than trusting my own memory of an earlier answer."

That's an accurate diagnosis of the architecture, not just the model's judgment. `ChatMessage`
(`server/src/ai/assistant.ts:789-792`) is `{ role, content: string }` — plain text only. Inside one
`runAssistantChat` call, the agentic loop (`assistant.ts:882-928`) keeps real `tool_use`/
`tool_result` content blocks in its local `messages` array across up to 8 turns, but only the
final text block is ever returned and persisted (`whatsapp_messages` table, `store.ts:53`; the
web route resends whatever `client.ts` has accumulated). The next user message reconstructs
history from that persisted string list — the model sees its own prose summary of what it found,
never the actual tool JSON.

So every new message is a re-derivation from paraphrase, not from ground truth. Fine when the
model just needs conversational continuity; the failure mode is when a later turn asks it to
confirm, act on, or double-check something a prior turn already established — the only "memory"
available is text the model wrote itself, which it can undermine with in-context doubt (exactly
what happened here) with nothing to check that doubt against.

As of [[2026-08-25-anti-hallucination-prompt-rule]] (`assistant.ts:797`), there's now a prompt
rule forbidding assertions of absence without a fresh tool call in the same turn. That's a real
mitigation but not a structural fix — it depends on the model choosing to comply every time.

## Approaches surveyed

**A. Persist real content blocks, not flattened text.** Store `Anthropic.MessageParam[]`-shaped
history (JSON) instead of flat strings; replay actual `tool_use`/`tool_result` blocks into the
next call's `messages` array, same as within a single agentic loop today. Most correct — the model
is grounded in real prior tool output every turn, no paraphrase step at all.
Cost: schema change (`whatsapp_messages.content` TEXT → JSON, or a new column), rewrite of both
history-loading sites (`whatsappRoutes.ts:79,120,147`, `assistantRoutes.ts:8`) and the two
`history[history.length - 1] = ...` doc-context splices, migration for existing rows. Token cost
goes up — raw tool JSON (email lists, calendar events) gets resent every subsequent turn instead
of once, which the `MAX_HISTORY_MESSAGES = 12` cap doesn't currently have to account for at that
size. Would need either a shorter turn cap or truncating old tool_result payloads specifically
(keep the text, drop the JSON, after N turns).

**B. Short-lived per-conversation fact cache.** Keep flat-text history as is, but after each tool
call, write a small structured summary (e.g. `{tool, query, result_ids, timestamp}`) to a
conversation-scoped table, and inject the last few as a "verified this session" block in the
system prompt. Cheaper than A (small, bounded size, no raw JSON replay) but still net-new storage,
and it's a second source of truth to keep in sync with the actual tool_result — solves the
paraphrase problem without fully closing it (a bad summary can drift too, just less often).

**C. Prompt-only (current state).** No new storage. Cheapest, already shipped. Ceiling is model
compliance — an instruction, not a guarantee. Reasonable as a first line of defense, not
sufficient alone if this recurs.

**D. Deterministic pre-fetch for high-risk phrasing.** For messages matching patterns like "add to
calendar", "is there a X on file", "double check" — code-level (not model-chosen) re-run of the
relevant read tool before the model answers, same spirit as `count_travel_days` being deterministic
rather than model-computed. Narrower than A/B (only covers anticipated phrasings) but zero
ambiguity for the cases it does cover, and no schema change. Could combine with C as a cheap
belt-and-suspenders layer while deciding on A vs. B.

## Recommendation (not yet decided — brainstorm before building)

A is the real fix if this keeps happening across more scenarios than "did I check email" — it
removes the failure mode structurally instead of instructing around it. B is a cheaper
intermediate step if A's token/schema cost looks too high once sized properly. D is worth doing
regardless of A/B, cheaply, for the specific "add to calendar" / "is X on file" phrasings that
already caused a real incident.

Next step if picked up: measure how often this actually recurs with the Section [[current
prompt rule]] in place before committing to A's cost — the incident that prompted this was one
data point, and C may hold up fine in practice.
