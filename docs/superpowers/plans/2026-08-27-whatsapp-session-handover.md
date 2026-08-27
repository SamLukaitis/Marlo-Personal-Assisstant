# WhatsApp Session Handover — 2026-08-27

**For:** a new session picking up WhatsApp assistant work.
**Branch:** `feat/whatsapp-pending-actions` (tracks `origin/feat/whatsapp-pending-actions`).
**Last commit pushed:** `0ac9d81` — "feat: durable webhook dedupe, unsupported-type replies, rolling WhatsApp memory".
**Verify state:** `cd server && npx vitest run` (460/460 passing) and `npx tsc -p tsconfig.json --noEmit` (clean) as of this commit.

## Context

This session started from a review of an earlier "mega plan" (8-phase WhatsApp feature roadmap: templates, read receipts, `pending_actions`/`ask_user_choice`, location check-ins, CTA onboarding, voice transcription, reactions/contacts/status webhooks). Phases 1–3 and the hard part of Phase 5 were already done in prior sessions (see `docs/superpowers/plans/2026-08-27-whatsapp-pending-actions.md` and git history). This session:

1. Audited the actual codebase against that plan (not the graph — `graphify-out/graph.json` was stale, built 2026-08-20, before the `pending_actions` work landed; don't trust it for WhatsApp code without rebuilding).
2. Root-caused three behaviors the user found in manual testing.
3. Implemented Phase 0 (skipping Phases 4 and 6 at the user's request) and a memory/pushback fix.

## What shipped this session (commit `0ac9d81`)

**Phase 0 — foundations**
- `seen_wamids` table (`db/store.ts`) replaces the in-memory, 500-entry, restart-losing `Set` that used to live in `whatsappRoutes.ts` for webhook dedupe. `markWamidSeenIfNew()` is atomic (`INSERT OR IGNORE`), swept via `deleteExpiredSeenWamids()` each scheduler tick (8-day retention — Meta retries webhooks for 7).
- Inbound message types with no real handler (location, audio/voice, sticker, contacts, reaction, video, …) get an explicit `"unsupported"` branch (new `IncomingUnsupportedMessage` in `providers/whatsapp.ts`) instead of being silently dropped: logs the raw type, replies "I can't read that message type yet — text me instead," and redirects to setup if it arrives pre-registration (`whatsappRegistration.ts`).

**Rolling conversation memory** (fixes two of the three bugs below)
- `MAX_HISTORY_MESSAGES` 12 → 24 (`ai/assistant.ts`).
- New `whatsapp_conversation_summaries` table + `services/conversationSummary.ts`: once ≥8 messages fall out of the raw window, merges them into a rolling summary (Haiku call) folded into the system prompt as "Earlier in this conversation…". Regenerated in batches (not every turn), merges forward indefinitely rather than covering a fixed 40-message ceiling — the design goal the user asked for ("24 raw + summary so effective memory is like 40") is met and actually extends further than that over a long conversation.
- Wired into every WhatsApp `runAssistantChat` call site (text/media/link/pending-action resume) via a new optional `phone` param; web chat and eval callers are unaffected.

## Root-cause findings (from this session's debugging pass)

Three behaviors the user found in manual testing:

1. **Swipe-to-reply (quoted messages) unreadable — NOT FIXED, see below.**
2. **"You said that ~10 messages back" fails to recall — FIXED** by the memory work above. Root cause was `MAX_HISTORY_MESSAGES = 12` being a hard, unsummarized truncation (the old code comment said so outright) — anything older was never sent to the model at all, not misremembered.
3. **Pushback/correction handling fails — FIXED, same root cause as #2**, plus a secondary factor: `chooseModel()`'s `SIMPLE_PATTERNS` in `ai/assistant.ts` includes `/\bcheck\b/` and `/\bfind\b/`, so a pushback phrased "no, check again" can route to Haiku with extended thinking disabled — worth keeping an eye on if pushback still misfires after this fix; the summary work doesn't address this secondary factor.

## What's still open

### 1. Quoted-reply (swipe-to-reply) support — designed, not built

Root cause (confirmed by reading `providers/whatsapp.ts` and the `whatsapp_messages` schema):
- WhatsApp sends `context: { message_id: "<wamid>" }` on a quoted reply. `extractIncomingMessages` never reads it — dropped along with everything outside the four handled shapes.
- Even if captured, there's nowhere to resolve it: `whatsapp_messages` (`db/store.ts`) has no wamid column at all (`id INTEGER PRIMARY KEY AUTOINCREMENT, phone, role, content, created_at` — internal `id` only, never Meta's wamid).

Two-part fix needed:
- **Store wamids.** Add a nullable `wamid TEXT` column to `whatsapp_messages`. Populate it on every insert: `appendWhatsAppMessage` needs the inbound wamid (already available at every call site via `message.messageId`) and outbound sends need their wamid back from the Graph API response (`sendWhatsAppMessage`/`sendAssistantReply` currently discard the response body — check what Meta actually returns before assuming this is free; it may require a second field from the existing POST response, not a new call).
- **Resolve on quote.** Add `context?: { message_id?: string }` to `providers/whatsapp.ts`'s `WebhookPayload` and to `IncomingTextMessage`/`IncomingMediaMessage` (quoted replies aren't interactive-only — any message kind can quote). In `whatsappRoutes.ts`, when `context.message_id` is present, look up that wamid in `whatsapp_messages`, and prefix the quoted content into what's sent to the model (similar to how `handleMedia`/`handleLink` already splice extracted content into the last history entry) — something like `[Replying to: "<quoted content>"]\n<new message>`.

Suggested next step: run this through `superpowers:writing-plans` for a proper task breakdown before implementing — it touches the outbound send path (need to confirm what Meta's API actually returns for a sent message's wamid) in a way this session didn't verify.

### 2. Original mega-plan phases not covered

- **Phase 4 (location pins → travel tracker)** — explicitly skipped this session at the user's request, not started.
- **Phase 6 (voice transcription)** — explicitly skipped this session at the user's request, not started.
- **Phase 7 (reactions, contact cards, quoting via `context.message_id`, status webhook observability)** — not started. Note quoted-reply (#1 above) is effectively pulling forward one piece of Phase 7 ahead of the rest.

## Useful pointers

- Prior planning doc for the `pending_actions` engine (Phases 1–3, already shipped): `docs/superpowers/plans/2026-08-27-whatsapp-pending-actions.md` + its design spec.
- Test conventions: real in-memory-ish SQLite via `db/store.ts` for store-level tests (see `db/pendingActions.test.ts`, `db/conversationSummary.test.ts`); `vi.mock` for route/service tests (see `routes/whatsappRoutes.test.ts`). No precedent anywhere in this repo for mocking the `@anthropic-ai/sdk` client directly — LLM-calling functions (e.g. `classifyImportantEmails`, `maybeUpdateConversationSummary`) are split into a tested pure prompt-builder/parser plus an untested (manually verified) orchestration function that makes the actual call.
- `graphify-out/graph.json` is stale (2026-08-20) relative to all of this — rebuild (`/graphify`) before trusting it for anything WhatsApp-related.
