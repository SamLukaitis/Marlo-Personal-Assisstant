# 2026-08-24 — Generic entities & links layer (Phases A–C)

One-line version: Marlowe now has a generic way to turn any document into typed, structured,
connected facts — travel check-ins migrated onto it, and expenses + bookings are extracted for
the first time — without adding a single extra AI call per document.

Built by Jake with Claude Code. Test count went from 133 → 171, all passing throughout; every
step was verified with `npm test` before moving to the next.

---

## The idea (context for anyone reading cold)

We already had one "structured thing derived from a document" — `travel_checkins` — but it was
hardcoded: its own table, its own save/list functions, its own foreign key to `documents`.
Adding a second kind of thing (expenses) would have meant building all that plumbing again.

This work replaces that pattern with two generic tables:

- **`entities`** — one row per typed fact (`travel_checkin`, `expense`, `booking`, later `trip`),
  with the type-specific fields in a JSON `data` column, so a new type is a code change, never a
  schema change.
- **`links`** — one row per connection between two records (entity or document on either side),
  with a labelled relation (`extracted_from`, later `belongs_to`). This replaces per-type foreign
  keys and is what will let one `trip` own many documents/expenses/check-ins (the delay-repay
  feature's foundation).

`documents` itself is untouched and deliberately stays outside this system: documents are the
frozen source evidence; entities are the derived, re-computable claims about the world.

## Phase A — Foundation

- `entities` and `links` tables added in `server/src/db/store.ts`, following the existing
  migration idiom (`CREATE TABLE IF NOT EXISTS`, owner-scoped, raw better-sqlite3).
- Generic store functions: `saveEntity`, `getEntity`, `listEntities`, `updateEntity`,
  `linkRecords`, `getLinksFrom`, `getLinksTo`, `getRelatedEntities` — with row-mappers that
  JSON-encode/decode the `data` column. (`server/src/db/store.ts`, tests in
  `server/src/db/entities.test.ts`.)
- Type registry scaffold (`server/src/services/entityTypes.ts`): each entity type declares its
  validator in one place via `registerEntityType`.

## Phase B — travel_checkins migrated onto the generic layer

- One-time migration copies every `travel_checkins` row into `entities` as
  `type='travel_checkin'`, with an `extracted_from` link where a source document existed.
- `saveCheckin` / `listCheckins` / `listAllCheckinsAscending` keep their exact names and return
  shapes but now read/write `entities` under the hood — so `travelDays.ts` (Schengen day
  counting), `checkinRoutes.ts`, `scheduler.ts`, and the assistant tools all work unchanged.
- Regression test (`server/src/services/travelDays.test.ts`) proves the day count is correct
  through the new path.
- The old `travel_checkins` table is left in place, frozen, purely as a rollback point — it no
  longer receives reads or writes. Removing it later is tracked in `JAKES_TODO.md`.

## Document category rename: `receipts_bookings` → `receipts`

- Flight/hotel booking confirmations now file under `travel` (they're travel documents); the
  `receipts` category is purely financial (receipts, invoices).
- Changed across server (`store.ts`, `documents.ts` extraction prompt), client
  (`client/src/api/client.ts` — label is now "Receipts"), and tests, with a one-line idempotent
  data migration relabelling any existing rows.

## Phase C — expenses and bookings extracted from documents

Design decision (Jake, this session): what entities a document produces is decided by its
**content**, never by its filing category — a hotel confirmation files under `travel` but shows
both a reservation *and* money paid, so it produces both a `booking` and an `expense`.

- Two new tools, `record_purchase` and `record_booking`, added to the **same single extraction
  call** every document already gets — API cost per document is unchanged. The model only
  transcribes what's printed (amount as a string, exactly as shown); it is never asked to compute.
- `server/src/services/entityValidation.ts` — the fully deterministic (zero-API) guard layer:
  - amount parsing in code: `"18,50"`, `"1.234,56"`, `"£1,234.56"` → integer minor units
    (pence/cents), with zero-decimal currency handling (JPY, ISK);
  - a ~30-code ISO currency whitelist — a hallucinated code ("EURO") drops the expense;
  - strict calendar checks (Feb 30 is rejected, not rolled over to March 2);
  - graduated date-plausibility vs. upload time, same approach as travel validation;
  - booking checks: `kind` must be `flight|hotel`, checkout-before-checkin rejected.
- Validation outcome mapping: ok → stored `active`; doubtful-but-plausible → stored
  **`needs_review`** (this status is now actually used for the first time); impossible → dropped
  with a logged reason. Decision table lives in `buildDerivedEntities` (`documents.ts`), which is
  pure and unit-tested offline.
- Every stored entity gets an `extracted_from` link to its source document.
- New assistant tools `list_expenses` and `list_bookings` (always-on, pure DB reads) in
  `server/src/ai/assistant.ts` — "what have I spent?", "when is my flight?" now answerable.

## Fixes found along the way

- **`deleteUserCompletely` was not purging the new tables** — a deleted user's entities/links
  would have silently survived account deletion. Fixed (two DELETEs added to the purge
  transaction in `store.ts`).

## Reference material

- `docs/data-map.html` — a visual map of the three tables: every column, the values each can
  take, and the trip-graph picture this is building toward. Solid = built, dashed = planned.
  Kept up to date as phases land (also published as a Claude artifact).

## What's next (not started)

- **Phase D — the `trip` entity and `belongs_to` links**: the grouping anchor that unlocks
  delay-repay. Open design question: how a new expense/booking finds its trip (hardcoded
  date-window overlap vs. something smarter).
- Open tensions tracked in `docs/data-map.html` §Open-questions and the (untracked) planning
  docs: the travel_checkin validator validates the pre-storage movement rather than the stored
  shape; `links` has no uniqueness constraint (re-ingesting could duplicate); no dedup for the
  same document sent twice.

---

## Brainstorm: candidate columns for next session

Not built — ideas to react to. Also a good lens on the documents/entities split: **document
columns describe the file; entity columns describe the fact.**

### `documents` (facts about the artifact)
| Candidate | Why it might earn its place |
|---|---|
| `content_hash` | SHA-256 of the file bytes — detect the same receipt sent twice (dedup is a known gap) |
| `source` | How it arrived: `whatsapp_media` / `whatsapp_link` / future: `email_attachment` — input types are about to multiply |
| `extraction_model`, `extracted_at` | Which model read it, when — lets a future better model re-extract old documents and know which ones predate it |
| `size_bytes`, `page_count` | Cheap file metadata for the Files page |

### `entities` (facts about the world)
| Candidate | Why it might earn its place |
|---|---|
| `occurred_at` | Promote "when did this fact happen" out of the JSON into a real column — every type has one (check-in moment, expense date, booking start) and Phase D trip-matching will want to query by time window in SQL |
| `review_reason` | The validator's issues text is currently discarded after deciding `needs_review` — storing it lets the UI say *why* something is flagged |
| `source` | Who asserted this: `extraction` / `phone` / `manual` — a hand-corrected expense shouldn't look identical to a model guess |
| `superseded_by` | Corrections as new rows pointing back, instead of edits that destroy the audit trail |

### `links`
| Candidate | Why it might earn its place |
|---|---|
| Uniqueness constraint | `UNIQUE(owner_id, relation, from…, to…)` — stops re-ingestion creating duplicate links (known gap) |
| `confidence` | Phase D trip-matching will sometimes be a guess ("this expense is *probably* the Faro trip") — a link that knows it's a guess can be shown differently |
| `note` | Free-text qualifier on a connection ("the delayed flight this claim is about") |
