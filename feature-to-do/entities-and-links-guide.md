# Generalising to Entities & Links — a build guide for Marlowe

A reference for turning the one hardcoded "entity + link" we already have (`travel_checkins` and
its `document_id`) into a generic pattern where adding a new kind of thing is *data you add*, not
*plumbing you build*. Pairs with `docs/superpowers/specs/2026-08-24-ingestion-extraction-hardening-design.md`
(that one is about extraction *accuracy*; this one is about *structure* — making new types cheap).

Its companion `entities-and-links-todo.md` is the ordered checklist for actually building this;
each step there points back to a section here.

---

## 1. The core idea

We already built an entity and a link — just hardcoded for one case. `travel_checkins` is an
**entity** (a structured, typed thing derived from a document). `travel_checkins.document_id` is a
**link** (it points the check-in back at the document it came from). Generalising means promoting
those two hardcoded shapes into two generic tables, so a new type (expense, trip, subscription)
lives in the same tables and only needs a little type-specific code around it.

Guiding constraints — keep these true throughout (they're how the rest of `store.ts` already
works):

- Everything is scoped by `owner_id` (multi-tenant).
- Migrations follow the existing idiom: `CREATE TABLE IF NOT EXISTS` + a `PRAGMA table_info`
  guarded `ALTER`/rebuild, the same pattern used for `documents.title` and `travel_checkins.source`.
- No ORM. Raw `better-sqlite3` prepared statements, with row-mapper functions (like
  `toAccountRow`).
- Type-specific fields go in a JSON `data` column, so adding a type needs no schema change.
- Deterministic validators in the `validateTravelMovement` mould (`ok | warn | reject` +
  confidence), not trust-the-model.
- Reuse the shared field vocabulary (§9) for cross-cutting concepts (a date, a money amount, a
  reference code, ...) instead of inventing a synonym per type.

## 2. The two tables

New tables, added alongside `documents` — nothing existing is removed.

```sql
CREATE TABLE entities (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id   INTEGER NOT NULL REFERENCES users(id),
  type       TEXT NOT NULL,             -- 'travel_checkin' | 'expense' | 'trip' | ...
  status     TEXT NOT NULL DEFAULT 'active',  -- active | needs_review | archived
  data       TEXT NOT NULL,             -- JSON: the fields specific to this type
  confidence REAL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_entities_owner_type ON entities(owner_id, type);

CREATE TABLE links (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id   INTEGER NOT NULL REFERENCES users(id),
  relation   TEXT NOT NULL,             -- 'extracted_from' | 'belongs_to' | 'relates_to'
  from_type  TEXT NOT NULL,             -- 'entity' | 'document'
  from_id    INTEGER NOT NULL,
  to_type    TEXT NOT NULL,             -- 'entity' | 'document'
  to_id      INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_links_from ON links(owner_id, from_type, from_id);
CREATE INDEX idx_links_to   ON links(owner_id, to_type, to_id);
```

The **JSON `data` column** is the whole trick. A travel check-in stores `{country, city,
checkedInAt}`; an expense stores `{vendor, amountPence, currency, date}`; a trip stores `{label,
startDate, endDate}` — all in one table, no per-type schema change. `links` references either an
`entity` or a `document` by id (documents stay the "source" record they already are).

## 3. The generic store functions

These replace the per-type functions (`saveCheckin`, `listCheckins`, …) with a small generic set,
written in the existing owner-scoped style, with row-mappers that `JSON.parse` the `data` column.

```ts
export interface EntityRow<T = unknown> {
  id: number;
  type: string;
  status: 'active' | 'needs_review' | 'archived';
  data: T;                 // parsed from the JSON column
  confidence: number | null;
  createdAt: number;
  updatedAt: number;
}

saveEntity(ownerId, { type, data, confidence?, status? }): EntityRow;
getEntity(ownerId, id): EntityRow | null;
listEntities(ownerId, { type?, status? }): EntityRow[];
updateEntity(ownerId, id, patch): EntityRow;

linkRecords(ownerId, { relation, from: {type, id}, to: {type, id} }): LinkRow;
getLinksFrom(ownerId, fromType, fromId): LinkRow[];
getLinksTo(ownerId, toType, toId): LinkRow[];
getRelatedEntities(ownerId, { type, id }): EntityRow[]; // walk links from a document or entity
```

`saveEntity` does `JSON.stringify(data)` on the way in; the row-mapper does `JSON.parse` on the way
out — the same shape as the existing column-alias mappers, just with one JSON field.

## 4. The "define a type once" registry

A tiny in-code registry so each entity type declares itself in one place. Each type provides the
type-specific pieces; the generic tables and store functions handle the rest.

```ts
interface EntityTypeDef<T> {
  type: string;
  validate(data: unknown, ctx: { uploadedAt: Date }): ValidationResult; // ok|warn|reject + confidence
  tools: AssistantTool[];   // read tools exposed to the assistant, e.g. list_expenses
}

registerEntityType(travelCheckinDef);
registerEntityType(expenseDef);
```

- `validate` is the generalisation of `validateTravelMovement` — same `ValidationResult` shape
  (`server/src/services/travelValidation.ts`). Reuse the shared date-sanity helper the Track 1 doc
  proposes factoring out.
- `tools` is how a type plugs into the assistant's existing `ALWAYS_ON_TOOLS` / `runTool` spine
  (`server/src/ai/assistant.ts`), so registering a type automatically gives the assistant a way to
  read it.

## 5. Adding a new type (worked example: expenses)

With the above in place, adding **expenses** is three small steps and touches none of the core:

1. **Define the shape + validator.** An `ExpenseData` type (`{vendor, amountPence, currency,
   date}`) and a `validateExpense(data, ctx)` — a small arithmetic guardrail like travel's (amount
   parses and is positive, currency is a known ISO code, date is sane vs `uploadedAt`).
2. **Register it.** `registerEntityType({ type: 'expense', validate: validateExpense, tools:
   [listExpensesTool] })`.
3. **Emit it during extraction.** In `documents.ts`, when `category === 'receipts_bookings'`, call
   `saveEntity({type:'expense', data, confidence})` and `linkRecords(entity --extracted_from-->
   document)`.

No new tables, no new store plumbing, no new assistant wiring. That's the payoff of the generic
layer.

## 6. Links and grouping (the delay-repay unlock)

Links are what let one journey own several documents. A `trip` entity — whose `data` is the
**spatiotemporal ID** from `JAKES_TODO.md` (a place + time label for the journey) — becomes the
thing you attach a boarding pass, a delay notice, and a receipt to:

```
expense        --belongs_to--> trip
travel_checkin --belongs_to--> trip
document(pass) --relates_to--> trip
```

Then "everything for the London trip" is one link walk — `getRelatedEntities(ownerId, {type:'trip',
id})` — with no searching. That grouping entity is exactly what the delay-repay to-do was reaching
for: pull the right documents, labelled, linked to one journey id.

## 7. Sequencing & migration strategy

Introduce this **additively** — don't rip anything out.

1. **Foundation first:** add the two tables + generic store functions, with tests, while nothing
   uses them yet. Zero risk to the running app.
2. **Prove it by migrating the one type you already have:** move `travel_checkins` into
   `entities` (`type = 'travel_checkin'`), with a thin compatibility read so `travelDays.ts` keeps
   working unchanged. Migrating your only existing entity is the cheapest possible proof the generic
   shape actually holds — before you build a second type on it. Keep a regression test that the
   Schengen day-count is identical before and after.
3. **Then add the second type (expense)** via §5 — the real test that adding a type is now cheap.
4. **Then grouping (`trip`)** via §6 — which sets up delay-repay.

This pairs with, and doesn't compete with, the Track 1 accuracy work: Track 1 makes each extraction
*trustworthy*; this makes each new *kind* of thing *cheap to add*. Do them in either order, or
interleave — they touch mostly different code.

## 8. What NOT to do (yet)

- Don't move `documents` itself into `entities` — documents are your "source" record and work well
  as they are. Entities are the *derived, typed* things; documents remain what they're derived from.
- Don't add semantic/vector search here — that's a separate retrieval concern (Track 2).
- Don't build every entity type up front. The value is that you *can* add them one at a time, when a
  feature needs one.

## 9. Shared field vocabulary (avoid inventing synonyms)

The `data` JSON column means a new type never *needs* a migration to gain a field — which is
exactly what makes it easy to accidentally end up with `vendor` on `expense` and `merchant` on
some future `subscription` type meaning the same thing, or `date` vs `occurredAt` vs `eventDate`
for "the one date this thing happened on." That drift makes cross-type querying and grouping
(§6) harder, not easier. The fix isn't pre-building fields nobody needs yet — it's a small,
reused vocabulary for the handful of concepts that recur across *any* real-world record. When a
new type needs one of these concepts, reuse the name; don't rename it because it "sounds better."

| Concept | Field name(s) | Shape | Used by |
|---|---|---|---|
| A single date something happened/occurred on | `date` | `YYYY-MM-DD` | `expense` |
| A date range (start required, end optional/ongoing) | `startDate`, `endDate` | `YYYY-MM-DD`, `YYYY-MM-DD \| null` | `booking`, `trip` |
| A money amount | `amountPence`, `currency` | integer minor units, ISO 4217 | `expense` |
| The counterparty / who this was with or from | `vendor` | string | `expense` |
| A human-readable identifier/title for the record | `label` (grouping entities) or `name` (concrete records) | string | `trip` uses `label`; `booking` uses `name` |
| An external confirmation/reference code | `reference` | string \| null | `booking` |
| A sub-kind within a type | `kind` | string union | `booking` (`flight` \| `hotel`) |

When a new type (receipt analyser, subscription, whatever ships tomorrow) needs "the date," "the
amount," "who it's with," or "a reference code," pull the name from this table instead of
choosing fresh. If a genuinely new cross-cutting concept shows up twice, add it to the table
*then* — that's the signal it's real, not speculative.
