# "Save this for later" photo capture

A car they like, a t-shirt, anything with no time to add context. Someone sends a photo with no
caption and wants to be able to ask about it again later ("what was that car I sent you"). Unlike
receipts/bookings, there's usually nothing legible to extract deterministically — just visual
attributes (category, color, style) and whatever's legible in frame (logos, tags, badges).

Plan discussed (2026-08-24):

- New `saved_item` entity type, same pattern as `trip`/`expense` in
  `docs/entities-and-links-guide.md` — category, visual description, brand-if-legible, confidence,
  `needs_review` when genuinely uncertain (same `ok/warn/reject` shape as `entityValidation.ts`).
- Capture cheap, enrich lazily: don't eagerly identify every photo (wastes tokens on
  memes/screenshots) — just store + a rough extraction pass at ingest, then do real identification
  (web search) only when the user actually asks about it later.
- The app has no `web_search` tool wired in anywhere yet (checked `server/src/` on 2026-08-24) —
  needed for "what car/product is this" to search on Claude's own description of distinctive
  features rather than guessing from pixels alone (exact make/model/trim is unreliable from a
  photo without a legible badge).
- Free win already in place: if the person forwards a product page link instead of/alongside the
  photo, the existing link-ingestion pipeline (`server/src/services/safeLinkFetcher.ts`,
  `docs/roadmap/...` founder-task-split work) gives a much better source than image inference —
  worth nudging toward in the assistant's phrasing.
