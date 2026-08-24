# Proactive memory surfacing

## Problem

Memory today is purely reactive background context: every conversation turn injects the 40 most
recent `memory_notes` rows as a flat bulleted list into the system prompt, and the model only
references one if the user's current message happens to relate to it. Nothing ever gets brought
up unprompted — a fact like "my visa expires in March" just sits there until asked about
directly, even once March arrives.

This is [[2026-08-24-feature-brainstorm-followups]] thread #4, the second of the two independent
design efforts from that brainstorm. Approach A (prompt-only in-conversation change + one small
schema addition for out-of-band pushes, from that document's approaches survey) was the approved
direction over Approach B (a deterministic importance/recency ranking layer — real, but premature
before usage data shows the 40-note window actually failing) and Approach C (embeddings/semantic
search — solves a scale problem this app doesn't have yet, at real new infrastructure cost).

## Design

### Two different kinds of "proactive," two different costs

**In-conversation proactivity** (the assistant volunteers a relevant memory mid-conversation,
unprompted) needs **no new infrastructure at all**. The 40 most recent notes are already in every
system prompt (`server/src/ai/assistant.ts`) — the model already has the information, it has just
never been told it's allowed to volunteer it. This is a pure prompt-wording change.

**Out-of-band proactivity** (the assistant reaches out with no message from the user at all — a
scheduled push, the same shape as the existing real-time email alerts) needs a small, genuinely
new piece: some memories need an attached point in time to know *when* they become worth
mentioning.

### Schema: two new nullable columns on `memory_notes`

Via the same ALTER-and-rebuild migration pattern already used elsewhere in `store.ts` (e.g. the
`travel_checkins` / `alerted_messages` multi-tenant migrations):

```sql
ALTER TABLE memory_notes ADD COLUMN trigger_at INTEGER;       -- ms epoch, nullable
ALTER TABLE memory_notes ADD COLUMN last_surfaced_at INTEGER; -- ms epoch, nullable
CREATE INDEX idx_memory_notes_trigger ON memory_notes (owner_id, trigger_at);
```

Both stay `NULL` for an ordinary fact/preference — nothing changes for the common case.

### `remember` tool: one new optional field

`server/src/ai/assistant.ts`'s existing `remember` tool schema gains `triggerAt`:

```ts
triggerAt: {
  type: "string",
  description:
    "Optional ISO 8601 date/datetime. Set this only if what the user shared has a natural " +
    "future trigger point — a deadline, a recurring commitment, a stated future plan. Leave " +
    "unset for ordinary facts or preferences with no time dimension.",
},
```

`addMemoryNote(ownerId, content, triggerAt?)` in `store.ts` parses and stores it (invalid/
unparseable dates are treated as absent, not an error — same fault-tolerant spirit as
`record_travel_movement`'s handling elsewhere). This is the same tool call already being made
every time the model decides something's worth remembering — no new LLM call, no new cost.

### In-conversation shape: a prompt change, nothing else

The system-prompt framing around the injected memory list (`assistant.ts`, where `memoryList` is
built) shifts from passive reference material to active permission:

> Before: "Things you've learned about the user over past conversations: ..."
>
> After: "Things you remember about the user. You may naturally bring up one of these when it's
> genuinely relevant to what's being discussed — the way someone who was actually paying attention
> would — without forcing it or repeating something you've already brought up this conversation."

Zero API cost delta, zero new code paths. This alone is expected to cover most of the "feels like
talking to a human" ask.

**Known limitation, accepted for now:** at 40 notes this works fine; past roughly 100–200 notes,
recency ordering will eventually bury an old-but-still-relevant note. That failure mode exists
today regardless of this feature — proactive surfacing doesn't make it worse. Fixing it (Approach
B: importance flag + recency decay + keyword overlap, all deterministic) is real future work, not
built here, and the schema above doesn't block it.

### Out-of-band shape: one new scheduled check, following the existing pattern exactly

New file `server/src/services/memoryReminders.ts`, exporting `checkDueMemoryReminders(ownerId)`:
selects `WHERE owner_id = ? AND trigger_at IS NOT NULL AND trigger_at <= ? AND last_surfaced_at IS
NULL` (indexed on `(owner_id, trigger_at)` — a lookup, not a scan, so cost stays proportional to
*due* reminders, not total memory count even at large scale). For each hit, push a WhatsApp
message and stamp `last_surfaced_at`.

Wired into `server/src/services/scheduler.ts` exactly like the two existing per-user checks —
same shape as `runAlertsCheckForUser`, its own try/catch inside `tick()` so one tenant's failure
can't block another's:

```ts
async function runMemoryReminderCheckForUser(ownerId: number): Promise<void> {
  try {
    await checkDueMemoryReminders(ownerId);
  } catch (err) {
    console.error(`scheduler: memory reminder check failed for user ${ownerId}`, err);
  }
}
```

No separate enable/disable setting for v1 (unlike real-time email alerts, which default *off*
via `realtime_alerts_enabled`). Every reminder here only exists because the user explicitly told
the assistant something worth remembering — it's inherently lower-noise than "an email arrived,"
so gating it behind another Setup-page toggle is more surface area than the risk justifies right
now. Worth being explicit that this is a real, deliberate divergence from the alerts precedent
(opt-in there, no opt-out at all here), acceptable at current small-scale dogfooding — revisit
before a wider beta if it turns out to matter. Trivial to add later (same `getSetting`/
`setSetting` pattern already used for alerts).

**Recurring events, scoped down for v1:** no recurrence-rule engine. A triggered reminder is
marked done (`last_surfaced_at` set) and never re-arms itself. If the topic comes up again in
conversation, the assistant just saves a fresh memory note with a new `triggerAt` — the existing
`remember` tool already handles that with no new logic. Building real recurrence parsing ("every
six months," "the first Monday of each quarter") is real complexity nobody's validated the need
for yet.

### Nagging control

A small per-user daily cap inside `checkDueMemoryReminders`, mirroring `alerts.ts`'s
`MAX_ALERTS_PER_CHECK` pattern — if an unusual number of reminders come due at once, send the cap
and note the rest, rather than firing every one of them as separate messages.

### Error handling

- Unparseable/missing `triggerAt` → treated as no trigger set, not an error; the note still saves
  normally as an ordinary memory.
- WhatsApp send failure for a due reminder → logged, `last_surfaced_at` is **not** stamped, so
  it's retried on the next tick rather than silently lost. This is a deliberate deviation from
  `alerts.ts`'s existing precedent: that code's `notify()` helper swallows every send error
  internally and `markAlerted` always runs unconditionally afterward, so a silent WhatsApp
  failure there means that alert is gone for good. Acceptable for "an email arrived" (there'll be
  another); not acceptable for a one-time reminder about something time-sensitive. Because of
  this, `checkDueMemoryReminders` calls `sendWhatsAppMessage` directly per number rather than
  reusing `alerts.ts`'s `notify()` — it needs to see whether the send actually succeeded, which
  that shared helper deliberately doesn't expose.
- Scheduler-tick failure for one user never blocks another (existing pattern, unchanged).

### Testing

- The due-lookup query and the `last_surfaced_at` dedup behavior get real `store.ts`-style tests
  against a test DB (insert notes with various `trigger_at`/`last_surfaced_at` combinations,
  assert exactly the due-and-unsurfaced ones come back).
- `addMemoryNote`'s invalid-date handling (falls back to no trigger, doesn't throw) — a small
  pure-ish unit test.
- Whether the model actually *decides* to set `triggerAt` appropriately, or volunteers a memory
  proactively at the right moment, isn't unit-testable — it's a live model judgment call, same
  category as the existing `remember` tool itself. Verified by using the feature, not by an
  automated suite.

## Out of scope

- Approach B (deterministic importance/recency ranking for the in-conversation window) — real
  future work once usage shows the 40-note window actually missing relevant older notes, not
  built now.
- Approach C (embeddings/semantic search) — not justified at this scale.
- Recurrence rules for repeating reminders — deferred, see above.
- A Setup-page toggle to disable out-of-band reminders — trivial to add later, not built now.
- Editing/browsing due-but-not-yet-surfaced reminders anywhere in the UI.
