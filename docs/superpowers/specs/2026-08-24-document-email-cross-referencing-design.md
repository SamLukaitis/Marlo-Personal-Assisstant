# Document ↔ email cross-referencing

## Problem

Saved documents (`server/src/services/documents.ts`) and email (read live via
`server/src/services/hub.ts`, never stored locally) are two completely disconnected data sources
today. Nothing notices when they refer to the same real-world thing — e.g. a boarding pass saved
via WhatsApp and a later "your flight has changed" email from the airline. The user has to
remember the connection exists and go check both places themselves.

This is [[2026-08-24-feature-brainstorm-followups]] thread #3, picked as the first of two
independent design efforts from that brainstorm. Approach B (schema-constrained extraction at
ingest + deterministic matching, from that document's approaches survey) was the approved
direction over a pure-regex matcher (too brittle — extracting an identifier from prose via regex
misses often) and an LLM-judges-each-pair matcher (non-deterministic, breaks this codebase's
existing "LLM supplies facts, code decides" principle — see `travelDays.ts` /
`travelValidation.ts` for the established precedent).

## A cost asymmetry that shapes this design

Documents already get an LLM extraction call at save time (`extractDocument` /
`extractFactsFromLinkText` in `documents.ts`) — adding a few optional fields to that call is
free. Email has **no equivalent existing extraction step**; it's only ever listed/searched live
against the provider APIs. Running a structured-extraction LLM call on every newly-seen email
would be a brand-new, recurring cost with nothing to piggyback on, unlike the document side. The
design below is built around avoiding that cost rather than assuming it away.

A second asymmetry, discovered while writing this up: `alerts.ts`'s existing poll (`scheduler.ts`,
every 5 minutes) deliberately *excludes* automated senders (`AUTOMATED_SENDER_PATTERN`) — but a
flight-change notice is exactly the kind of automated sender that filter exists to exclude.
Reconciliation needs its own scan over new mail, not a reuse of the alert filter.

## Design

### Extraction: one new optional tool, folded into the existing call

`documents.ts` gains a third tool alongside the existing `name_document` / `record_travel_movement`
pair, passed into the same `messages.create` call (no new API round trip):

```ts
const RECORD_MATCH_KEYS_TOOL: Anthropic.Tool = {
  name: "record_match_keys",
  description:
    "Call this only if the document contains a machine-checkable identifier worth cross-" +
    "referencing against email later — a booking/confirmation/reference code, a flight number, " +
    "or a clear vendor name with a specific date. Skip it entirely if none of these are actually " +
    "present and legible; never guess or invent one.",
  input_schema: {
    type: "object",
    properties: {
      referenceCode: { type: "string", description: "Booking/confirmation/reference code exactly as shown" },
      flightNumber: { type: "string", description: "e.g. DL1234" },
      vendor: { type: "string", description: "Airline/hotel/company name, e.g. Delta, Hilton" },
      eventDate: { type: "string", description: "ISO 8601 date, e.g. 2026-09-12" },
    },
  },
};
```

`parseExtractionResponse` (already factored out — see the link-ingestion work) gains a fourth
return field, `matchKeys: MatchKeys | null`, read the same way `movement` is today. No required
fields — the model supplies whatever subset is actually present, or nothing.

### Storage: one new table, no JSON blobs

Matches this codebase's existing style (flat columns, e.g. `travel_checkins`, `memory_notes`) over
a JSON column:

```sql
CREATE TABLE document_match_keys (
  document_id INTEGER PRIMARY KEY REFERENCES documents(id),
  owner_id INTEGER NOT NULL REFERENCES users(id),
  reference_code TEXT,
  flight_number TEXT,
  vendor TEXT,
  event_date TEXT,
  created_at INTEGER NOT NULL
);
```

New `store.ts` functions: `saveMatchKeys(ownerId, documentId, keys)` (no-op if every field is
null/absent — don't write an empty row) and `listRecentMatchKeys(ownerId, sinceMs)`.

**Dedup reuses the existing generic ledger — no second new table.** `alerted_messages`
(`hasAlerted`/`markAlerted` in `store.ts`) is already a generic `(owner_id, key)` "have we done
this already" ledger, capped at 2000 keys per owner. Reconciliation uses two namespaced key
shapes on that same table rather than inventing new infrastructure:
- `recon-scan:{accountId}:{messageId}` — this email has already been checked against documents.
- `recon-match:{documentId}:{accountId}:{messageId}` — this pair has already been notified.

(This is a simplification over what was verbally approved — that pass assumed a dedicated new
`document_email_matches` table for both data and dedup. Splitting it — one small table for the
extracted keys themselves, the existing ledger reused for dedup — is less code for the same
behavior.)

### Matching: mostly free, LLM fallback only for ambiguous cases

Two tiers are defined, but **only the strong tier ships in v1** (see the scoping note below) —
the weak tier is specified now so the schema and comparison logic don't need reshaping later, not
because it's built today:
- **Strong** (v1): shared `referenceCode` (case-insensitive exact), or shared `flightNumber` +
  same-day `eventDate`.
- **Weak** (v2, not built yet): same `vendor` (case-insensitive) and `eventDate` within ±2 days,
  with no shared identifier.

**Document → email direction** (runs synchronously right after a document saves, in
`ingestWhatsAppMedia`/`ingestWhatsAppLink`): fetch recent mail via `hubListMessages(ownerId, {
limit: 50 })` — the existing function only supports a count limit, not a date range, so this
matches `alerts.ts`'s existing convention exactly rather than inventing a day-based window that
isn't actually available. Check the new document's own keys against each message's subject +
snippet **by substring match — no LLM call on the email side at all**. A reference code or flight
number is short and specific enough that finding it verbatim in a subject/snippet is already a
strong match; nothing further to confirm.

**Email → document direction** (new function in a new `server/src/services/reconciliation.ts`,
called from `scheduler.ts`'s existing 5-minute tick, sibling to `checkForNewImportantMessages`):
this makes its own `hubListMessages(ownerId, { limit: 50 })` call — same shape as `alerts.ts`, but
unfiltered by `AUTOMATED_SENDER_PATTERN`, since the whole point is catching automated airline/
vendor mail — then keeps only messages not yet seen for reconciliation (dedup via the
`recon-scan:` ledger key, marked regardless of match outcome so nothing gets re-checked every
tick). For each of those, check its subject + snippet against `listRecentMatchKeys(ownerId,
sinceMs)` (the local `document_match_keys` table, a real 90-day timestamp window since documents
*are* stored locally) — substring match against stored `referenceCode`/`flightNumber`, **still no
LLM call**. This covers the strong tier completely without ever paying for email-side extraction.

**Scoped out of v1: the weak tier.** Determining weak-tier matches (vendor + date proximity, no
shared identifier) on the email side needs the email's own body text pulled through something
extraction-like, and that's exactly the new recurring cost this design is built to avoid paying
by default. Since the strong tier already covers the highest-value case (an airline emailing
about a trip you have a boarding pass for) at effectively zero marginal cost, v1 ships strong-tier
only. If real usage shows meaningful missed connections, add a small, prefilter-gated extraction
call on candidate email bodies as a v2 addition — the `record_match_keys` schema and the weak-tier
comparison logic above are already the right shape for it, this just isn't built now.

### Notification

Deterministic template only (no LLM-composed wording — with only one tier shipping, there's no
hedging nuance to justify the extra moving part):

> "📎 Heads up — {vendor's message/an email} about {doc title} ({referenceCode or flightNumber},
> {eventDate}) just came in. Worth a look?"

Capped at a handful of notifications per scheduler tick (mirrors `alerts.ts`'s
`MAX_ALERTS_PER_CHECK` pattern) to avoid a burst.

### Error handling

- Model doesn't call `record_match_keys` → `matchKeys` is `null`, nothing stored, document just
  isn't reconciliation-searchable — never blocks saving the document itself (same fault-tolerance
  pattern as the existing optional `record_travel_movement`).
- `hubListMessages` failing (provider API error) → reconciliation for that tick/document is
  skipped and logged, never blocks the surrounding save or the rest of the scheduler loop (matches
  `checkForNewImportantMessages`'s existing `.catch` style elsewhere in this codebase).
- No backfill for documents saved before this ships — they simply have no `document_match_keys`
  row until the feature exists going forward. Same forward-only migration precedent already used
  for encryption-at-rest (see README: pre-existing rows "become encrypted once the token next
  refreshes... or you reconnect").

### Testing

- `matchTier(keysA, keysB): "strong" | null` — pure function, fully unit-testable, same discipline
  as `travelValidation.ts`: exact-identifier-match cases, case-insensitivity, same-day vs.
  off-by-one-day flight dates, no-signal cases. Returns only `"strong" | null` in v1 — extend to
  include `"weak"` when that tier is actually built.
- `saveMatchKeys` no-op-on-empty behavior — unit test against a real (test) DB, same pattern as
  existing `store.ts` coverage.
- The two integration points (document-save hook, scheduler-tick hook) get a manual/live check
  once implemented — same verification style used for the link fetcher (a real save, a real
  scheduler tick, confirm the expected notification fires and the dedup ledger prevents a repeat),
  not heavy automated end-to-end coverage.

## Out of scope

- Weak-tier (vendor + date, no shared identifier) matching — deferred, see above.
- Any UI surface for browsing past matches (this ships as a WhatsApp notification only; the
  matched document is already visible on the existing Files page).
- Retroactive backfill of `document_match_keys` for documents saved before this ships.
- Matching two *documents* against each other (e.g. two receipts for the same trip) — scoped to
  document↔email only, per the original ask.
