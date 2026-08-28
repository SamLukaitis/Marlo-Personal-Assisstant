# Instinct Competitive-Analysis Upgrades — Session Handover — 2026-08-28

**For:** a new session picking up this work (previous session ran low on context/usage).
**Branch:** `feat/whatsapp-pending-actions` (existing branch, not created for this work — see note under "Open questions" below).
**Last commit:** `7831406` — "feat: on-demand memory search + enforced confirm gate for irreversible tools". Not pushed.
**Verify state:** `cd server && npx vitest run` (524/524 passing) and `npx tsc --noEmit` (clean) as of this commit.

## Context

The user is on Instinct AI's beta (a viral competitor — SMS/WhatsApp personal assistant with full browser control, $2.5B valuation as of Aug 26 2026, founded by ex-Sierra researcher Noah Shinn). We did a competitive-analysis pass grounded in public reporting (TechCrunch, Forbes; see conversation for full source list), then translated findings into concrete upgrades for this codebase ("Marlowe"). Three independent sub-projects came out of that, scoped via `superpowers:brainstorming` and worked in order:

1. **Two-tier memory** (bounded — done)
2. **Structural risk-tiering for tool execution** (bounded — done)
3. **User-facing action audit trail** (architectural — design agreed in chat, not yet written to a spec file)

Key technical thread through all of this: Instinct's founder previously published **Reflexion** (NeurIPS 2023) — agents that keep a full searchable log plus a small always-injected "what matters" layer. Item 1 below is a deliberate, minimal version of that pattern using this repo's existing `memory_notes` table, not a rebuild.

## What shipped this session (commit `7831406`)

### 1. Two-tier memory
- `listRecentMemoryNotes` injected-window default: 40 → 30 (`server/src/db/store.ts`). This is the "always in every prompt" tier.
- New `searchMemoryNotes(ownerId, query, limit=10)` in `store.ts`: SQLite FTS5 **external-content** index over `memory_notes` (`memory_notes_fts`, `content_rowid='id'`), synced via `AFTER INSERT`/`AFTER DELETE` triggers, with a one-time backfill on first migration. Query terms are extracted via `\p{L}\p{N}` regex and re-quoted (`"term1" AND "term2"`) rather than passed raw to `MATCH` — raw FTS5 syntax (quotes/colons/NOT/OR) would throw on arbitrary input otherwise.
- New always-on `search_memory` AI tool (`server/src/ai/assistant.ts`), wired into `runTool`. This is the "on-demand" tier — lets the assistant recall a fact that's aged out of the 30-note window.
- Deliberately **kept keyword/FTS, not embeddings** — the user picked this explicitly to avoid the exact "insane cost" pattern the whole analysis was pushing back on. No new dependency.
- Tests: `server/src/db/memoryNotesStore.test.ts` (8 cases: matching, AND-semantics, owner-scoping, post-delete, special-char safety, blank-query, limit), `server/src/ai/assistant.test.ts` (3 cases: tool listed, finds a note, respects limit).

### 2. Structural risk-tiering for tool execution
- **The gap found:** the existing `ask_user_choice(mode="confirm")` mechanism (stages a `pending_actions` row; only a WhatsApp "Yes" tap via `actionHandlers.ts` actually calls `runTool`) is well-built, but *nothing enforced that a tool actually goes through it* — `delete_calendar_event`'s only "confirm first" instruction was prose in its tool description, which the model could skip.
- **Fix:** `CONFIRM_REQUIRED_TOOLS` set in `assistant.ts` (currently just `["delete_calendar_event"]` — the only tool in the current catalog that's genuinely irreversible; everything else is either safe-by-construction like `create_email_draft`, or reversible like `archive_messages`/`label_message`). In `runAssistantChat`'s live-turn loop, a direct call to a confirm-required tool is intercepted *before* `runTool` — the server returns an `is_error` tool_result telling the model to use `ask_user_choice` instead, and never executes the underlying action.
- `runTool` itself is untouched, so `actionHandlers.ts`'s legitimate confirmed-execution path (after a real "Yes" tap) is unaffected — verified by a test that calls `runTool("delete_calendar_event", ...)` directly and confirms it still executes.
- Tests added to `server/src/ai/assistant.askUserChoice.test.ts`: direct-call rejection (mocks `hubDeleteEvent`, asserts it's never called, asserts the loop retries with the model's next response), plus the confirmed-path-still-works case.
- **Extend this later** by just adding a tool name to `CONFIRM_REQUIRED_TOOLS` if a future tool (e.g. a real booking/purchase-execution tool) needs the same treatment. No new plumbing needed.

## What's still open: item 3 — user-facing action audit trail

**Status:** design fully agreed with the user in chat (architectural path per `brainstorming` skill), but **not yet written to `docs/superpowers/specs/`**. Next session should write the spec doc from what's below, run the self-review checklist, get the user to review the file, then invoke `superpowers:writing-plans` — do not skip straight to implementation.

### Why (the gap)
No user-facing record of "what did the assistant actually do for me" exists anywhere in the app. The only logging found (`server/src/services/logCapture.ts`, `server_logs` table, Portal's "Logs, explained in plain English" tab) is **admin-only server error/warning capture** — a completely different thing, not overlapping with this feature. This closes a real Instinct gap: their public backlash included data retention nobody could verify and an unconfirmed email send nobody could see after the fact.

### Two decisions already made (via AskUserQuestion, don't re-ask)
1. **UI placement:** a new "Activity" **section within the existing `SettingsPage.tsx`** (its `SECTIONS` array / `?section=` pattern), **not** a new top-level sidebar/mobile-tab nav item — the nav already has 7 entries and this doesn't need permanent prime real estate.
2. **Log scope:** an **explicit allowlist** of consequential/write tools (same pattern as `CONFIRM_REQUIRED_TOOLS`), not a denylist-of-read-only-prefixes approach — safer, intentional, matches the precedent just shipped in item 2.

### Agreed design (present this in the spec doc)
- **Mechanism:** log inside `runTool` itself (single funnel — both the live loop and `actionHandlers.ts`'s confirmed-tap path already go through it, so this catches every real execution with no duplicated logic). Log only **successful** executions in v1 — failed/rejected attempts are a reasonable future extension, not required now.
- **Table:** new `action_log` (`owner_id`, `tool`, `summary`, `created_at`), same migration style as `memory_notes`/`pending_actions` in `store.ts`. Store **only a human-readable summary string**, not raw tool input/result JSON — avoids duplicating sensitive content (email draft bodies, document text) across two tables, and a static summary stays meaningful even if the underlying event later changes.
- **Summary generation:** extend the existing `CONFIRM_RESULT_LABEL` map in `server/src/services/actionHandlers.ts` (currently just `archive_messages`/`delete_calendar_event`, used today only for the WhatsApp confirmation reply text) into a shared `describeAction(tool, input, result)` covering the full allowlist below. One describer function, reused for both the confirmation reply and the audit-log entry — don't build a second parallel mapping.
- **Allowlist (14 tools):** `create_email_draft`, `create_calendar_event`, `update_calendar_event`, `delete_calendar_event`, `archive_messages`, `label_message`, `send_document`, `extract_email_attachment`, `set_briefing_preferences`, `connect_xero`, `respond_to_invoice_forward_prompt`, `create_trip`, `link_to_trip`, `remember`. `remember` is included deliberately — "here's what I stored about you" is exactly the transparency this feature is for. Excludes read-only tools (`list_*`/`search_*`/`get_*`/`count_*`) and internal-only tools (`flag_unmet_request`, `search_memory`).
- **API:** `GET /api/activity` (new route, `requireAuth`, same shape/pattern as `server/src/routes/memoryRoutes.ts`), returns latest 50, no pagination for v1 — matches the Portal's existing "refresh to see more, no live-sync" precedent (see `feature-to-do/done-admin-portal.md`).
- **UI:** content extracted into its own `client/src/components/ActivityLog.tsx` component (mirroring how `BriefingSourcePicker.tsx` is already extracted out of `SettingsPage.tsx` rather than inlined) — `SettingsPage.tsx` is already 768 lines, don't add a big new section inline.
- **Testing plan (agreed, not yet written):** store-level tests for insert + `listActionLog` owner-scoping; a `describeAction` unit test per allowlisted tool; a `runTool` integration test confirming an allowlisted call writes a row and a non-allowlisted one (e.g. `search_messages`) doesn't.

### Open questions for next session
- The user never weighed in on whether this work should live on its own branch vs. continuing on `feat/whatsapp-pending-actions` (an existing, topically-unrelated WhatsApp-onboarding branch) — items 1–2 were committed there only because it was already checked out. Worth asking before item 3, or before this branch gets pushed/merged.
- Items 1 and 2 landed in **one combined commit** (`7831406`) because their edits overlapped inside the same hunk of `assistant.ts` — a clean split wasn't attempted under time pressure. Not a blocker, just noted in case the user wants separate history later (would need a rebase/split, not urgent).

## Useful pointers
- Full competitive-analysis findings (Instinct AI sourcing, architecture inference, edge positioning) live only in this conversation's transcript, not written to a doc — if that analysis itself is needed again, ask the user whether to write it up separately; it wasn't in scope for a spec file.
- `graphify-out/` exists and was used for exploration this session (`mcp__graphify__*` tools) — helped locate `memory_notes`, the `ask_user_choice`/`pending_actions` flow, and the admin log-capture code quickly. Worth using again for item 3's exploration if it's still reasonably fresh.
- Test conventions confirmed this session: store-level tests hit real SQLite directly (`db/memoryNotesStore.test.ts`); tool-dispatch tests call `runTool` directly (`ai/assistant.test.ts`); full-loop tests mock `@anthropic-ai/sdk`'s `messages.create` (`ai/assistant.askUserChoice.test.ts`) and, when needed, mock one function out of `../services/hub.js` via `importOriginal` + spread (see that file's `hubDeleteEvent` mock) rather than mocking the whole module.
