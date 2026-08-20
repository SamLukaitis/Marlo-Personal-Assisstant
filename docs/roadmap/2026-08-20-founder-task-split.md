# Founder Task Split — 2026-08-20

Working breakdown of the project into deliverables, split by owner. Produced via
a brainstorming session focused on: how data is handled going into the
assistant (read/store/retrieve), UI, breadth of modules/commands, and ensuring
the assistant hardcodes deterministic rules rather than acting as a thin AI
wrapper (for cost, reliability, and hallucination reasons).

Context driving the priority order: current focus is **internal dogfooding**
(you two are the first real users) rather than a launch or fundraising demo,
so the order below optimizes for what actually blocks daily use today.

## Current state (for reference)

A meaningful amount of this already exists — this is a hardening/expansion
pass, not a greenfield build:

- **Ingestion**: WhatsApp media → `ingestWhatsAppMedia()` (`server/src/services/documents.ts`)
  → Claude extraction (title + category + facts via the `name_document` tool)
  → AES-256-GCM encrypted file + SQLite row → REST retrieval. Categories:
  `travel`, `id_legal`, `receipts_bookings`, `other` (+ `null`/"Uncategorized").
- **Tools/modules**: `assistant.ts` already has a tool-calling spine —
  `ALWAYS_ON_TOOLS` vs `CONDITIONAL_TOOLS`, a `TOOL_KEYS`/`ToolKey` enum,
  per-user enable/disable (`user_enabled_tools`), and a `runTool()` dispatcher.
- **Hardcoded-vs-LLM precedent**: `travelDays.ts` already does day-counting
  math deterministically — the LLM only supplies raw facts via the
  `record_travel_movement` tool schema, it doesn't compute the answer. PDF
  text extraction uses `pdf-parse` first, falling back to vision only when
  there's no usable text layer (cost control already in place).

## Owner: Data/Infra (storage, ingestion, retrieval, hardcode-vs-LLM boundary)

### Track 1 — Ingestion & Extraction Hardening (P0, now)

The top pain point: extraction accuracy is inconsistent, some dates have been
hallucinated/misread, only image/PDF input is captured, and there's no
confidence signal when the model is unsure.

- **Deterministic guardrails around the LLM extraction call.** Sanity-check
  extracted dates/facts against known-good context (e.g. message-received
  time, document type) before trusting them, instead of passing the model's
  raw output straight to storage. This is the "hardcode rules, not AI
  wrapper" principle applied directly to the #1 complaint (hallucinated
  dates).
- **Confidence signal + clarification loop.** Extraction should surface a
  confidence indicator (model-reported and/or derived from the deterministic
  checks above). Low confidence → the assistant asks a follow-up question on
  WhatsApp instead of silently storing a guess.
- **Expand input types.** Only image/PDF media is ingested today. Plain
  WhatsApp text messages, voice notes (transcribed), and forwarded links
  aren't captured as data at all yet — each needs its own path into the same
  store.
- *(Stretch, once the above is trusted)* **Structured per-category schema.**
  A travel doc and a receipt currently both collapse into one generic
  extracted-text blob; category-specific structured fields (e.g. flight
  number + dates vs vendor + amount) would make retrieval and downstream
  tooling more reliable. Secondary to correctness — do this after accuracy is
  solid, not instead of it.

### Track 2 — Retrieval Polish (P1, right after)

Described as "fine but needs polish" — real work, not blocking. Candidates:
better cross-referencing across documents/checkins/chat history, search
beyond exact category filtering.

## Owner: Product Surface (UI + tools/modules)

### Track 3 — Tool/Module Expansion (ongoing stream, not a one-time deliverable)

This will always be growing as new use-cases are identified — treat it as a
standing backlog against the existing `ALWAYS_ON_TOOLS`/`CONDITIONAL_TOOLS`
pattern, not a project with a finish line.

**Design rule to apply from the start, per new tool** (so it doesn't need
retrofitting later): hardcode the deterministic logic the way `travelDays.ts`
already does — the LLM supplies/interprets facts via a tool schema, it does
not compute the answer itself. This is the cost/hallucination principle,
applied per-tool as each one is built.

### Track 4 — UI Polish (P2, later)

Explicitly deprioritized for now — current UI is good enough; revisit once
ingestion (Track 1) is solid.

## Cross-cutting principle

"Hardcode rules, not AI wrapper" isn't a separate deliverable — it's a
constraint that threads through Track 1 (extraction validation) and Track 3
(tool logic) differently, and should be applied by default whenever new
LLM-touching code is written in either track.

## Next step

Track 1 (Ingestion & Extraction Hardening) is the piece that's genuinely
under-designed — concrete approaches for the deterministic checks, what
counts as "low confidence," and the WhatsApp clarification flow all need a
real design pass (approaches → spec → implementation plan) before
implementation starts. Revisit via `/superpowers:brainstorming` when ready to
start that track.
