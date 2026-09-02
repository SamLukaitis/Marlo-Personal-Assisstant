# Searchable WhatsApp conversation history

Date: 2026-09-02

## Problem

The assistant's WhatsApp context is bounded: the last `MAX_HISTORY_MESSAGES`
(24) raw messages (`assistant.ts:93`), plus a rolling AI summary of whatever
fell out of that window (`services/conversationSummary.ts`,
`whatsapp_conversation_summaries` table). Anything older than the summary
covers, or a specific fact the summary compressed away, is unreachable — the
model either says "I don't have that" or guesses. `search_memory` solves the
equivalent problem for `remember`-tool notes; there's no equivalent for the
raw conversation transcript itself.

## Design

**Data layer.** A new `whatsapp_messages_fts` FTS5 virtual table over
`whatsapp_messages` (external-content, `content_rowid=id`), synced by
insert/delete triggers — identical pattern to the existing
`memory_notes_fts` (`store.ts:694-710`) — plus a one-time backfill `INSERT`
for messages already in the table. No schema change to `whatsapp_messages`
itself, no new migration risk beyond the FTS index build.

**Store function.** `searchWhatsAppHistory(ownerId, phone, query, limit=20)`:
same tokenize-and-`MATCH` approach as `searchMemoryNotes` (`store.ts:1040`),
filtered by both `phone` and `owner_id` (defense in depth, matching that
function's convention), ordered by FTS rank.

**New tool.** `search_conversation_history` (WhatsApp-only, gated on `phone`
like `send_document`): input `{query, limit?}`. A system-prompt rule tells
the model to call it when the user references something earlier that isn't
in the visible recent window or the rolling summary — names, decisions,
dates, specific facts — rather than saying "I don't have that" or guessing.
This is additive: the existing 24-message raw window + rolling AI summary
stay exactly as they are for ambient context; this tool is for explicit
"what did I say about X" lookups reaching further back.

**Error handling.** Read-only and fully reversible, so no confirm-gate
needed (unlike `send_email`); empty results just return `[]`, same as
`search_memory`.

**Testing.** Store-level tests (hit/miss/owner-scoping, mirroring
`searchMemoryNotes`'s test suite), a `runTool` dispatch test, and a
web-chat-omits-phone error-path test (mirroring `send_document`'s).
