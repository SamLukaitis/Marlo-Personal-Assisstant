# To-Do: build the Entities & Links layer (for Claude Code)

An ordered checklist to hand to Claude Code, one item at a time. Each step says what to tell Claude
and which section of `entities-and-links-guide.md` to point it at. Do them in order — later steps
assume earlier ones.

## How to use this

1. Open the repo in VS Code with Claude Code.
2. Give Claude both files: `entities-and-links-guide.md` (the reference) and this list.
3. Work **one numbered item at a time** — ask Claude to do just that item, then run `npm test` in
   `server/` before moving on. Don't batch several steps into one prompt; small diffs are easier to
   check.
4. Repeat these constraints to Claude on each step (they're in guide §1): scope everything by
   `owner_id`, follow the existing migration idiom in `store.ts`, no ORM (raw `better-sqlite3`),
   type-specific fields go in the JSON `data` column, validators follow the `validateTravelMovement`
   shape, reuse the shared field vocabulary in guide §9 instead of inventing synonyms.

---

## Phase A — Foundation (safe; nothing uses it yet)

- [x] **1. Create the `entities` table.** Tell Claude: add an `entities` table in `server/src/db/store.ts`
  using the existing `CREATE TABLE IF NOT EXISTS` + migration-guard pattern, with the columns and
  index from the guide. *Context: guide §2 (schema) and §1 (constraints).*

- [x] **2. Create the `links` table.** Same, for the `links` table and its two indexes.
  *Context: guide §2.*

- [x] **3. Add the generic store functions + row types.** Tell Claude: add `EntityRow` / `LinkRow`
  types and the functions `saveEntity`, `getEntity`, `listEntities`, `updateEntity`, `linkRecords`,
  `getLinksFrom`, `getLinksTo`, `getRelatedEntities` — owner-scoped, with row-mappers that
  `JSON.parse` the `data` column (mirror the existing `toAccountRow` style). *Context: guide §3.*

- [x] **4. Unit-test the foundation.** Tell Claude: add a test (alongside `store.smoke.test.ts`)
  that saves an entity, links it to a document, and reads it back via `getRelatedEntities`.
  Run `npm test`. *Context: guide §7 step 1.*

## Phase B — Prove it by migrating travel (the existing type)

- [x] **5. Add the type registry scaffold.** Tell Claude: create the `registerEntityType` registry
  and the `EntityTypeDef` interface, and register a `travel_checkin` type whose `validate` wraps the
  existing `validateTravelMovement`. *Context: guide §4.*

- [x] **6. Migrate `travel_checkins` into `entities`.** Tell Claude: write a one-time migration
  (existing rebuild idiom) copying `travel_checkins` rows into `entities` as `type='travel_checkin'`
  with `data = {country, city, checkedInAt, latitude, longitude, source}`, and a link to their
  `document_id` where present. Add a compatibility read (e.g. `listCheckins` now reads from
  `entities`) so `travelDays.ts` keeps working **unchanged**. *Context: guide §7 step 2.*

- [x] **7. Regression-test the day count.** Tell Claude: add/confirm a test that the Schengen-style
  day count is identical before and after the migration. This is the proof the generic shape holds.
  *Context: guide §7 step 2.*

## Phase C — Add the second type: expenses (the real payoff)

> **Decision (2026-08-24):** the document category `receipts_bookings` was renamed to `receipts`
> (already done — see `server/src/db/store.ts`, `documents.ts`, `client/src/api/client.ts`).
> Flight/hotel booking confirmations now classify under `travel`, not `receipts`. Jake also wants
> an umbrella "booking confirmations" grouping with flight/hotel underneath — not a real folder
> (the flat category list stays simple on purpose), but a second entity type: `type: 'booking'`
> with `data: { kind: 'flight' | 'hotel', ... }`. That's a sibling to the `expense` type below, not
> a replacement — both still need building. Add a `Booking4Data`/`validateBooking` +
> `registerEntityType('booking', ...)` step alongside items 8-11 when picking this back up.

- [x] **8. Define expense shape + validator.** Tell Claude: add `ExpenseData` (`{vendor,
  amountPence, currency, date}`) and `validateExpense(data, ctx)` in the `validateTravelMovement`
  mould (amount parses & positive, currency is a known ISO code, date sane vs `uploadedAt`).
  *Context: guide §5 step 1 and §4.*

- [x] **9. Register expense + its read tool.** Tell Claude: `registerEntityType` for `expense`, and
  add a `list_expenses` tool into the assistant's `ALWAYS_ON_TOOLS` / `runTool` spine in
  `server/src/ai/assistant.ts`. *Context: guide §5 step 2 and §4.*

- [x] **10. Emit expenses during extraction.** Tell Claude: in `server/src/services/documents.ts`,
  when `category === 'receipts'`, `saveEntity({type:'expense', ...})` and
  `linkRecords(entity --extracted_from--> document)`. *Context: guide §5 step 3.*

- [x] **11. Test the expense path.** Tell Claude: unit-test `validateExpense`, plus an
  ingest→entity→link test for a receipt. Run `npm test`. *Context: guide §5, §7.*

- [x] **12. Define + register the `booking` type.** Tell Claude: add `BookingData` (`{kind:
  'flight' | 'hotel', ...}`) and a validator, `registerEntityType('booking', ...)`, and emit it
  during extraction when a document is a flight/hotel booking confirmation (`category ===
  'travel'`, distinguished from a plain itinerary/boarding pass by what the extraction prompt
  found). Files page / assistant can then group by `data.kind` for the umbrella-with-subgroups
  view Jake wants, with no schema change needed for the nesting itself.

## Phase D — Grouping (sets up delay-repay)

- [x] **12. Add a `trip` entity type.** Tell Claude: register a `trip` type whose `data` is the
  spatiotemporal id/label (place + time window). *Context: guide §6.*

- [x] **13. Link things to a trip + add a read view.** Tell Claude: allow linking
  `travel_checkin` / `expense` / `document` `--belongs_to--> trip`, and add a
  `get_trip_contents` tool that returns `getRelatedEntities(trip)`. *Context: guide §6.*

---

## Notes

- Stop after **Phase B** if you just want the generic layer proven; Phases C–D are the first real
  uses and can wait.
- The extraction-accuracy work (`docs/superpowers/specs/2026-08-24-ingestion-extraction-hardening-design.md`)
  is a separate track — it can be done before, after, or interleaved with this. They touch mostly
  different files.
- Whenever Claude proposes touching `documents`, `travelDays.ts`, or anything outside the new
  tables + the specific files named above, pause and check — the design is deliberately additive
  (guide §8).
