# WhatsApp pending-actions engine (Phase 3)

Date: 2026-08-27

## Problem

Today every WhatsApp interaction that needs a yes/no or a pick-one-of-several
goes through free-text prose: the assistant asks in words, the user types a
reply, and the model has to correctly parse that reply as consent/choice
before acting. This is unreliable for destructive actions (a misread "yeah
I guess" as "no", or vice versa) and costs a full LLM round trip even when
the answer is a simple tap.

Two concrete pain points drove this:
- `archive_messages` and `delete_calendar_event` currently execute the moment
  the model decides to call them — there is no confirmation step at all.
- `search_contacts` can return multiple people for an ambiguous name, and the
  model has no structured way to ask "which one?" other than prose.

## Scope

Building the general `pending_actions` infrastructure plus two consumption
modes:

- **`confirm`** — render Yes/No buttons; a Yes tap runs a specific,
  pre-decided tool call with zero further LLM involvement; a No tap cancels.
  Generalizes "confirm before archiving" to any tool the model wants gated.
- **`resume`** — render up to 10 options (buttons if ≤3, a list message
  otherwise); a tap injects a synthetic user message and re-runs the normal
  assistant turn with that context.

**Explicitly deferred** (lower value without more usage data, or dependent on
work not yet done): static quick-reply menus appended to proactive
briefing/alert pushes, `mute_sender`, template-baked static buttons for
outside-the-customer-service-window pushes, reaction-based confirmation
(needs Phase 7's inbound-reaction handling).

## Data model

```sql
CREATE TABLE IF NOT EXISTS pending_actions (
  id TEXT PRIMARY KEY,                 -- crypto.randomUUID()
  owner_id INTEGER NOT NULL REFERENCES users(id),
  mode TEXT NOT NULL,                  -- 'confirm' | 'resume'
  question TEXT NOT NULL,              -- original question, for debugging/logging only
  context_json TEXT NOT NULL,          -- confirm: {tool, input}; resume: {options: string[]}
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,         -- created_at + 24h
  consumed_at INTEGER                  -- NULL until tapped
);
```

Tap IDs embed the action: `pa:<uuid>:<key>` — `key` is `"yes"`/`"no"` for
confirm, or the option's array index (as a string) for resume. WhatsApp
button/list reply IDs have no required charset and a 256-char cap, so this
comfortably fits.

Consuming is one atomic statement:
```sql
UPDATE pending_actions SET consumed_at = ?
WHERE id = ? AND owner_id = ? AND consumed_at IS NULL
```
checked via `changes` — covers double-taps and Meta's webhook retries. A row
that doesn't update (already consumed, wrong owner, or never existed) and a
row that exists but is past `expires_at` are both reported to the user the
same way: "That option has expired — just ask me again."

A periodic sweep (piggybacking on `scheduler.ts`'s existing 5-minute tick,
once per tick rather than per-user) deletes rows past `expires_at` — hygiene
only, not required for correctness since expiry is also checked at consume
time.

## The `ask_user_choice` tool

Added to `assistant.ts`'s tool list:

```
ask_user_choice({
  question: string,
  mode: "confirm" | "resume",
  options?: [{ label: string }],   // required for resume, 2-10 items; ignored for confirm
  confirm_tool?: string,           // required for confirm: exact tool name to run if the user taps Yes
  confirm_input?: object,          // required for confirm: exact input for that tool call
})
```

The model proposes the exact tool + arguments to run if confirmed — it never
executes the tool itself. This is a deliberate human-in-the-loop gate: the
model has already decided what it *would* do, but the actual `runTool` call
only happens after a real tap, off the model's turn entirely.

### Loop integration

`runAssistantChat`'s per-turn loop currently: get a response, if there are
tool uses run them all and feed results back, else return the text block.
It now special-cases `ask_user_choice`: if the model's tool calls for that
turn include `ask_user_choice`, the loop stops immediately (any other
tool_use blocks in that same turn are ignored — the system prompt tells the
model to call it alone, after it already has whatever information it needs)
and a `pending_actions` row is written.

To avoid changing the on-the-wire contract for the two other callers (the
web chat route, the eval harness), `runAssistantChat`'s return type changes
from `Promise<string>` to:

```ts
interface AssistantReply {
  text: string;                 // always a sensible plain-language fallback
  choice?: {
    actionId: string;
    mode: "confirm" | "resume";
    buttons: { key: string; label: string }[]; // server-computed: Yes/No for confirm, index-keyed for resume
  };
}
```

`text` for a choice-carrying reply reads like "Archive 14 emails from Nike?
Reply yes or no." — so a caller that ignores `.choice` (web chat, eval)
behaves exactly as it does today, just without tappable buttons. Only
`assistantRoutes.ts`, `eval/grounding.eval.ts`, and the three WhatsApp call
sites need updating to read `.text` (mechanical), and WhatsApp additionally
branches on `.choice`.

## WhatsApp wiring

- `providers/whatsapp.ts` gains `sendWhatsAppListMessage` (interactive list,
  ≤10 rows, single section) alongside the existing `sendWhatsAppReplyButtons`.
  A new `sendChoiceMessage(phone, question, buttons)` picks buttons (≤3) or a
  list (4-10) automatically.
- `extractIncomingMessages` gains `interactive.list_reply.id` parsing
  (currently only `button_reply.id`) — both map to the same
  `IncomingInteractiveMessage.buttonId` field.
- New `services/actionHandlers.ts`: `handlePendingActionReply(ownerId,
  message): Promise<boolean>`, called from `handleIncoming` immediately after
  the existing `handlePostConnectSetupReply` check (identical shape: returns
  `false` to fall through to normal handling for anything not addressed to
  it).
  - `confirm` + Yes → `runTool(ownerId, tool, input)` directly, then a short
    canned confirmation line (a small per-tool label map: `archive_messages`
    → "✓ Archived N messages.", `delete_calendar_event` → "✓ Deleted.",
    fallback "✓ Done."). Zero LLM calls.
  - `confirm` + No → "Cancelled."
  - `resume` → append `(User selected: <label>)` as a synthetic user message
    to WhatsApp history, re-run `runAssistantChat`, send the result via the
    same `sendAssistantReply` helper (so a resume reply that itself needs
    another `ask_user_choice` works recursively for free).
- Extract `sendAssistantReply(ownerId, phone, reply: AssistantReply)` in
  `whatsappRoutes.ts` — sends `.text` normally, or renders `.choice` via
  `sendChoiceMessage` when present. `handleText`, `handleMedia`, `handleLink`,
  and the new resume path all call this instead of duplicating the
  send-and-persist logic three times over.
- System prompt addition: use `ask_user_choice(mode="confirm")` before
  `archive_messages` or `delete_calendar_event` instead of asking in prose;
  use `mode="resume"` when a lookup (e.g. `search_contacts`) returns more
  than one plausible match and intent is ambiguous.

## Error handling

- Unknown/expired/already-consumed tap → generic "expired, ask again" reply,
  no error surfaced.
- `runTool` throwing during a confirmed action → logged server-side, user
  gets "Sorry, that didn't go through — check the server logs." (matches the
  existing catch-all pattern in `handleIncoming`).
- A stray interactive tap that isn't a `pa:`-prefixed ID and doesn't match
  post-connect-setup falls through to the existing "unexpected interactive
  message" log-and-ignore branch, unchanged.

## Testing

- `db/store.test.ts` (or a new `pendingActions.test.ts`): create/consume
  idempotency (second consume of the same ID is a no-op), expiry, owner
  mismatch is rejected.
- `providers/whatsapp.test.ts`: `sendWhatsAppListMessage` payload shape,
  `extractIncomingMessages` parsing `list_reply`.
- `whatsappRoutes.test.ts`: signed-webhook simulation of a button tap and a
  list tap routing into `actionHandlers`, including a duplicate/retry tap.
- `assistant.test.ts` (new or extended): `ask_user_choice` ends the turn
  without a further model round-trip; confirms `runTool` is not called
  directly from the loop for that tool name.
