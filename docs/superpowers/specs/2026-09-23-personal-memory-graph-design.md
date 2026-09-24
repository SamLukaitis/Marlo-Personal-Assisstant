# Personal memory graph: automatic extraction, core profile, per-message retrieval

Date: 2026-09-23
Builds on: `2026-09-02-remember-entities-design.md` (merged, PRs #43–#45)

## Problem

A personal assistant's most important asset is knowing the person. Marlowe's memory today:

- **Writes only happen when the model calls `remember`.** Nothing extracts facts from
  conversations. A fact the model didn't save is gone once it scrolls out of the 24-message
  raw window (the rolling conversation summary keeps only a lossy paraphrase).
- **The prompt injects the 30 newest notes, not the relevant ones**
  (`listRecentMemoryNotes`, `store.ts`). After months of use, identity-level facts ("my wife
  is Anna") fall out of the prompt and only come back if the model thinks to call
  `search_memory`.
- **Entities/links are opt-in and on-demand only.** `remember` can file onto an entity and
  `recall_entity` can read it back, but nothing surfaces entity knowledge unprompted.
- **No correction or staleness handling.** "Lives in Paris" and "moved to London" coexist
  forever.
- **Cost:** the note list lives inside the cached system block, so every new note forces a
  2×-priced rewrite of that block.

## Goals

1. Marlowe learns durable facts about the user and their world from WhatsApp conversations
   without being told to.
2. A small, stable core profile is always in the prompt; everything else relevant to the
   current message is retrieved and injected, regardless of age.
3. Corrections supersede old facts; the user can view, correct, and forget via chat.
4. The cached system block changes rarely; the history prefix stays cacheable across turns.

## Non-goals (this spec)

- Email/calendar extraction — phase 2, its own spec.
- Web-chat extraction — web chat history is client-side only, never stored server-side;
  web chat keeps relying on `remember`.
- Embeddings/vector search — FTS5 + entity-name matching first; revisit only if recall
  proves weak.
- Moving the rolling conversation summary out of the system block (it's the other
  system-block churn source) — separate follow-up.
- Any new UI.

## §1 Data model

### `memory_notes` stays the fact store

It already has FTS5 (`memory_notes_fts`), the Setup-page vault (`memoryRoutes.ts`), and
`remember` writing to it. New columns, added via the existing `PRAGMA table_info` +
`ALTER TABLE ADD COLUMN` migration pattern:

| column | type | meaning |
|---|---|---|
| `entity_id` | INTEGER NULL | the remembered entity this fact is about; NULL = about the user. **No `REFERENCES` clause** — avoids adding another FK-ordering hazard to `deleteUserCompletely` (both tables are owner-scoped and deleted by owner anyway). |
| `kind` | TEXT NOT NULL DEFAULT `'fact'` | `core` \| `fact` \| `preference` |
| `source` | TEXT NOT NULL DEFAULT `'told'` | `told` (user said it / `remember`) \| `extracted` (background job) |
| `superseded_at` | INTEGER NULL | set when a newer fact replaces this one |
| `superseded_by` | INTEGER NULL | id of the replacing fact |
| `forgotten_at` | INTEGER NULL | set by `forget_memory`; soft delete |

**Active fact** = `superseded_at IS NULL AND forgotten_at IS NULL`. Every read path used by
the assistant (profile, retrieval, `search_memory`, `recall_entity`) and the Setup-page list
returns active facts only. The Setup page's delete stays a hard delete (`removeMemoryNote`).

Existing rows migrate with defaults (`kind='fact'`, `source='told'`). Reminder columns
(`trigger_at`, `last_surfaced_at`, `gave_up_at`) are untouched.

New store functions: `addFact(ownerId, { content, kind, source, entityId?, supersedesId? })`
(inserts, and if `supersedesId` is an active fact of this owner, sets its
`superseded_at`/`superseded_by` in the same transaction); `forgetFacts(ownerId, ids)`;
`listCoreProfile(ownerId, limit = 40)`; `listActiveFactsForEntity(ownerId, entityId, limit)`.
`addMemoryNote` stays as a thin wrapper (`kind='fact'`, `source='told'`) for existing callers.

### Remembered entities

`entities.data` for remembered entities becomes `{ name: string, aliases: string[] }`.

- `data.notes[]` is migrated out: each `{ text, at }` becomes a `memory_notes` row
  (`content=text`, `created_at=at`, `entity_id`, `source='told'`, `kind='fact'`) and `notes`
  is removed from `data`. Idempotent: guarded by "entity data still has a `notes` array", so
  re-running is a no-op. Runs in one transaction at startup with the other migrations.
- `isRememberedEntity` switches its discriminator from `notes` to `aliases` (an array of
  strings — no document-extracted entity type has `aliases`). `findOrCreateEntity` creates
  `{ name, aliases: [] }`.
- `findEntityByName` also matches aliases (case-insensitive, trimmed). New
  `addEntityAlias(ownerId, entityId, alias)` (dedupes, ignores an alias equal to the name).
- `appendEntityNote` is deleted; `remember` with `entity_name` now calls `addFact` with the
  entity's id.
- New `listRememberedEntities(ownerId)` → `{ id, type, name, aliases }[]` for extraction
  candidates and retrieval name-matching.

### Links

Unchanged table. Remembered entity→entity links get a free-text relation (`works_at`,
`sister_of`, `lives_in`, ...) instead of always `relates_to`. The user is not an entity.
Existing `relates_to` links stay valid. Link creation dedupes on
(from, relation, to) as `remember`'s `relates_to` already does — factored into
`linkEntitiesOnce(ownerId, fromId, relation, toId)` and reused by both.

### Extraction cursor

New table `memory_extraction_cursors (phone TEXT PRIMARY KEY, extracted_through_id INTEGER
NOT NULL, updated_at INTEGER NOT NULL)` — keyed by phone like
`whatsapp_conversation_summaries`, and cleared in `deleteUserCompletely` alongside it (same
`phone IN (...)` pattern).

## §2 Extraction (`server/src/services/memoryExtraction.ts`)

**Trigger:** `maybeExtractMemory(phone)`, called fire-and-forget from `whatsappRoutes.ts`
right next to `maybeUpdateConversationSummary` (with the same `.catch` logging). Resolves the
owner via `resolveOwnerByPhone`; no owner → return.

**Batching:** `EXTRACTION_BATCH_SIZE = 8`. Load `whatsapp_messages` for the phone with
`id > extracted_through_id`, ascending. Fewer than 8 → return (the no-op common case: one
indexed SELECT). This works on *fresh* messages, not messages leaving the raw window, so facts
are structured within ~8 messages; nothing is lost meanwhile because they're still in the raw
history. Also load up to 2 messages before the batch as context (marked as context-only in the
prompt).

**Candidates** passed to the model so it can dedupe, supersede, and reuse entities:
- active facts matching the batch text via the OR/BM25 FTS search from §3 (top 30),
- the core profile (§3),
- `listRememberedEntities` (names, aliases, types; most recently updated 50).
Each fact is shown with its id.

**Call:** Haiku (`ASSISTANT_MODEL_SIMPLE ?? "claude-haiku-4-5"`, same as the summary),
`max_tokens` 1024, a single forced tool (`tool_choice: { type: "tool", name:
"record_memory" }`) whose input is `{ operations: Operation[] }`:

```ts
type Operation =
  | { op: "add_fact"; content: string; kind: "core" | "fact" | "preference";
      entity?: { name: string; type: string }; supersedes_id?: number }
  | { op: "link"; from: string; relation: string; to: string }   // entity names
  | { op: "alias"; entity: string; alias: string };
```

**Prompt rules:**
- Save only durable things: facts about the user and the people, places, organisations and
  projects in their life; routines; preferences; standing instructions. Not one-off task
  requests, chit-chat, or anything only true for today.
- Assistant statements count only if the user confirmed them.
- Never save secrets: passwords, card/account numbers, one-time codes, security answers.
- `core` = identity-level only: name, partner/children/close family, home city, job/employer,
  strong standing preferences. Everything else is `fact`/`preference`.
- If a candidate fact already says it, emit nothing. If the batch changes a candidate fact,
  emit `add_fact` with `supersedes_id`.
- One clear third-person sentence per fact, self-contained ("Sarah Jones is the user's
  accountant at Acme").
- Reuse an existing entity name/alias rather than inventing a variant.
- Zero operations is a normal, expected answer.

**Validation and apply** (one transaction):
- `supersedes_id` must be one of the candidate ids shown; otherwise the op is applied without
  it (the fact is still added).
- `content` must be non-empty and ≤ 500 chars; `kind` must be valid; otherwise skip the op.
- Entities are resolved with `findOrCreateEntity` (which matches aliases); `link` and `alias`
  only act on entities that exist after this batch's `add_fact`s — never create an entity from
  a link/alias op alone.
- All facts get `source='extracted'`.
- Advance the cursor to the batch's last id.

**Failure handling:** never throws. API/network error → cursor not advanced, retried on the
next inbound message. Any successful response → cursor advances even if every op was
rejected, so one bad batch can't wedge the pipeline. A per-phone in-process guard
(`Set<string>` of in-flight phones) prevents two overlapping runs on the same batch when
messages arrive quickly.

**Usage:** `recordApiUsage(owner, "whatsapp", model, "memory_extraction", ...)`. Estimated
~2.5k input + ~300 output tokens per 8 messages (~$0.003).

`remember` remains the explicit, immediate path (`source='told'`).

## §3 Retrieval and prompt assembly

### Core profile (system block, cached)

`buildSystemPrompt` replaces the "Things you remember about the user" section with:

```
What you know about the user (core profile). You may bring one of these up naturally when
genuinely relevant, without forcing it:
- <active core facts, oldest first, max 40>
```

Oldest-first ordering means a new core fact appends and the block only changes when a core
fact is added/superseded/forgotten. When there are no core facts: `(nothing known yet)`.
`listRecentMemoryNotes` has no other callers and is removed.

### Per-message retrieval

`retrieveRelevantMemory(ownerId, text): string | null` in a new
`server/src/ai/memoryRetrieval.ts`, pure SQLite, no LLM call. `text` = the latest user
message plus the previous user message (so "and what about her?" still retrieves).

1. **Entity match:** for each remembered entity, test its name and aliases as whole words
   (Unicode word boundaries, case-insensitive) against `text`. For up to 3 matched entities
   (longest name first): its newest 5 active facts, plus 1-hop linked remembered entities
   rendered as `Sarah —works_at→ Acme`.
2. **FTS:** new `searchActiveFacts(ownerId, query, { mode: "any", limit: 8, excludeCore: true })`
   — terms extracted as in `searchMemoryNotes`, stopwords (small English list) and terms < 2
   chars dropped, ORed, ranked by `bm25`, active only, `kind != 'core'` (core is already in
   the system block).
3. Dedupe by fact id; cap at 12 facts and ~1,500 chars total. Nothing matched → `null`.

Format (each fact tagged with its id so the model can correct/forget it):

```
Relevant things you remember (not said by the user in this message — use only if relevant):
- [#123] Sarah Jones is the user's accountant at Acme.
- Sarah —works_at→ Acme
```

### Injection point

`runAssistantChat` computes the block once, before the loop, and prepends it as a separate
text block to the **latest user message's** content for this request only. It is never
written to `whatsapp_messages` or returned in history.

### Cache breakpoints (4 — Anthropic's maximum)

1. last tool (unchanged, `buildToolsForOwner`),
2. system block (unchanged),
3. **new:** the last content block of the message immediately before the latest user message
   (when one exists) — the history prefix is byte-identical across turns, so it's a cache read
   even though the injected block changes every turn,
4. last content block of the last message (unchanged, `withMessagesCacheBreakpoint`) — covers
   the tool-loop turns within one reply.

The latest-user-message index is fixed before the loop, so tool-loop appends don't move
breakpoint 3. `withMessagesCacheBreakpoint` is extended to take that index; the "exactly one
messages breakpoint" invariant becomes "at most two".

### Existing tools

- `search_memory`: active facts only; returns `{ id, content, kind, entity? }`; empty/absent
  `query` returns the core profile plus the newest 20 non-core active facts (for "what do you
  know about me?"). Keeps AND semantics for non-empty queries (precise lookup), falling back
  to OR/BM25 when AND returns nothing.
- `recall_entity`: returns `{ entity: { id, type, name, aliases }, facts:
  listActiveFactsForEntity(...), related: [{ relation, entity }] }`.

## §4 Chat controls

- **`forget_memory { ids: number[] }`** — new always-on tool (no `ToolKey` gate, same tier as
  `remember`). Calls `forgetFacts` (owner-scoped; unknown ids ignored), returns
  `{ forgotten: number[] }`. Soft delete, so it is not routed through the irreversible-action
  confirm gate.
- **`remember` gains `replaces_id?: number`** — the new note supersedes that fact
  (`addFact` with `supersedesId`). Also gains `kind?: "core" | "fact" | "preference"`
  (default `fact`). `relates_to` stays; new optional `relation?: string` (default
  `relates_to`) applies to its links.
- **Rules added to `buildRules`:**
  - When the user corrects or updates something you remember, call `remember` with
    `replaces_id` rather than adding a second, conflicting fact.
  - When the user says something you remember is wrong or asks you to forget it, call
    `forget_memory` and confirm what you forgot.
  - For "what do you know about me", use `search_memory` with no query; for a named person or
    thing, `recall_entity`.
  - Don't list back remembered facts unprompted; just use them.
- The existing `remember` rule is updated to mention `kind: "core"` for identity-level facts.

## §5 Testing

- **Store (`server/src/db/*.test.ts`):** column migration on an existing DB; the
  `data.notes[]` → `memory_notes` migration moves every note with its timestamp and
  `entity_id`, strips `notes`, and is idempotent; `isRememberedEntity` discriminates on
  `aliases`; `findEntityByName` matches aliases; `addFact` supersede sets both columns
  atomically and refuses another owner's id; superseded and forgotten facts are excluded from
  profile, retrieval, `search_memory`, `recall_entity`, and `memoryRoutes` list;
  `listCoreProfile` order and cap; `deleteUserCompletely` clears
  `memory_extraction_cursors`.
- **Retrieval (`memoryRetrieval.test.ts`):** whole-word entity/alias matching (no "Sam" inside
  "Samsung"); link rendering; OR/BM25 FTS with stopwords dropped; core excluded; caps; owner
  scoping; `null` when nothing matches.
- **Extraction (`memoryExtraction.test.ts`, Anthropic SDK mocked as in
  `assistant.cacheBreakpoint.test.ts`):** no-op below batch size; `supersedes_id` outside the
  candidates is dropped but the fact is added; entity reuse via alias; link/alias ops never
  create entities; cursor unchanged on API error and advanced on a response with all-invalid
  ops; in-flight guard prevents a concurrent duplicate run; prompt contains the secrets and
  durability rules; usage recorded as `memory_extraction`.
- **Prompt/cache (`assistant.cacheBreakpoint.test.ts`, updated):** exactly 4 breakpoints in
  the positions above; with two consecutive turns, the request prefix up to breakpoint 3 is
  byte-identical while the injected block differs; the injected block is absent from history
  passed on the next turn; the core profile replaces the old list.
- **Tools (`assistant.test.ts`):** `forget_memory`; `remember` with `replaces_id`, `kind`,
  `relation`; `recall_entity` returns `facts` after migration; `search_memory` empty-query
  behaviour. Existing `remember`/`recall_entity` tests updated for the new shapes.
