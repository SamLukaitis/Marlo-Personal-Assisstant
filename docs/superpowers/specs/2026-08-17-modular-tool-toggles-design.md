# Modular tool toggles (v1): Teams chat + Travel tracker

**Status:** Design approved by user, pending spec review before implementation planning.
**Date:** 2026-08-17
**Author:** Claude (design session with Sam Lukaitis)

## Context

This is sub-project 1 of a larger pivot: turning the Personal AI Assistant Hub from a fixed,
one-size-fits-all feature set into a platform where users select which capabilities ("tools")
their assistant has. The full pivot was decomposed into independent pieces during brainstorming
(see "Related work / explicitly out of scope" below); this spec covers only the first, smallest,
lowest-risk slice: proving the enable/disable mechanism end-to-end using two features that
already exist in the codebase, before building any new tool or touching onboarding/billing/the
"Other" custom-tool concept.

**Why these two tools first:** Teams chat (`microsoftListChats`/`microsoftSearchChats` in
`server/src/providers/microsoft.ts`, its own nav page) and the Schengen/travel-day tracker
(`server/src/services/travelDays.ts`, `server/src/routes/checkinRoutes.ts`) are the only two
features in the app that are already self-contained vertical slices — each has its own backend
logic and its own assistant tool functions, without deep coupling to the rest of the app. They're
the cheapest possible way to validate the mechanism with zero new business logic.

## Decisions made during design (for context on trade-offs below)

- **Nav stays fixed** (the 5-tab shell — Assistant/Chats/Calendar/Files/Setup — designed and
  confirmed just prior to this spec is NOT reworked). A disabled tool's page shows an inline
  "not enabled" state instead of disappearing from the sidebar. This avoids invalidating the
  responsive breakpoints (icon rail width, bottom tab bar item count) already tuned for exactly
  5 fixed items.
- **Both channels stay available for every enabled tool** — a UI surface (for reviewing/managing
  data, which chat is a poor interface for) AND full assistant/WhatsApp tool-calling access.
  Neither channel is dropped in favor of the other.
- **Selection happens in two places, not one blocking wizard:** a lightweight, non-blocking
  toggle step is added to onboarding (so a new signup gets the "personalizing my assistant"
  moment immediately), but it's skippable exactly like the existing account-connection step, and
  everything remains fully adjustable later from Setup → Tools. This preserves the existing
  onboarding philosophy (`OnboardingPage.tsx`'s own comment: "deliberately never blocks").

## Scope

**In scope:**
- A `user_enabled_tools` table and the server-side plumbing to filter Claude's tool list and
  system prompt per user.
- Teams chat and the travel/Schengen tracker become the two toggleable tools.
- `GET /api/tools`, `PUT /api/tools/:key` routes.
- Setup page: new "Tools" section with two toggles.
- Chats page and the travel/check-ins section of Setup: inline "not enabled" state when off.
- Onboarding: one new lightweight, skippable tool-picker step.

**Out of scope (this spec):**
- Any tool beyond these two (no finance tracker, no travel map/logger yet).
- The "Other" custom/bespoke tool concept — needs its own design (template system vs. bespoke)
  before any commitment is made to offer it.
- Fully dynamic nav (nav item count still fixed at 5).
- Billing/self-serve signup infrastructure (none exists today; access is still invite-only).
- WhatsApp scaling/compliance work (shared-number rate limits, the 24-hour template-message
  requirement for proactive sends) — flagged as a real, already-existing gap during the earlier
  risk review, but independent of and not blocking this sub-project.
- Closing the plaintext-data debt the README already flags (WhatsApp history, extracted document
  text, check-in history) — also independent of this sub-project.

## Data model

New table in `server/src/db/store.ts`, following the exact shape already used for simple
owner-scoped attributes (e.g. `user_phone_numbers`):

```sql
CREATE TABLE user_enabled_tools (
  owner_id INTEGER NOT NULL REFERENCES users(id),
  tool_key TEXT NOT NULL,        -- 'teams' | 'travel'
  enabled_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, tool_key)
);
```

Guarded the same way existing migrations in `store.ts` are (checked for a missing table/column
before running), consistent with the codebase's established migration pattern.

The tool *catalog* (key, label, short description, icon) is NOT stored in the database — it
stays as a small hardcoded array in server code, mirroring the existing precedent of
`GET /api/providers` returning a hardcoded provider list. Only *which tools a given user turned
on* is data; what tools exist at all is code, at least at this stage (a DB-driven catalog only
becomes worth it once tools are added/removed without a deploy, which isn't a need yet).

New store functions: `getEnabledTools(ownerId): Set<string>`, `setToolEnabled(ownerId, toolKey, enabled)`.

## Server logic

- `assistant.ts`'s `buildSystemPrompt` and the `tools` array (currently module-level constants,
  identical for every request) both become functions parameterized by `ownerId`:
  - Teams' 2 tool schemas (`list_recent_chats`, `search_chats`) and travel's 2 tool schemas
    (`list_travel_checkins`, `count_travel_days`) are only included in the array passed to
    `messages.create` if the corresponding `tool_key` is enabled for that owner.
  - The "Rules" text block in the system prompt currently hardcodes rules for archiving,
    calendar, documents, and travel in one fixed string. It becomes an array of rule fragments,
    filtered by enabled tools, joined at the end.
- **Defense in depth**: `runTool`'s dispatch switch also checks `getEnabledTools(ownerId)` before
  executing a travel- or Teams-related tool call, independent of whether it was offered in the
  schema. A disabled tool is rejected server-side, not just hidden from Claude.
- **Prompt caching note** (flagged during risk review, accepted as a known trade-off for v1):
  today's tool array is byte-identical for every user, so it's effectively one shared cache
  prefix across the install. Per-user filtering fragments this into up to 4 distinct
  combinations (both on / both off / either alone) — still cacheable per-combination, just no
  longer one shared prefix for everyone. With only 2 optional tools this is a non-issue; worth
  re-examining if the tool catalog grows much larger later.
- New routes (new file or added to an existing router, e.g. `server/src/routes/toolsRoutes.ts`):
  - `GET /api/tools` → `{ key, label, description, enabled }[]`, same response shape as
    `GET /api/providers`.
  - `PUT /api/tools/:key` → body `{ enabled: boolean }`, calls `setToolEnabled`.
  - Both gated by `requireAuth` like every other `/api/*` route.

## Client / UI

- **`client/src/pages/SetupPage.tsx`**: new "Tools" section (own `<h2>` + `.card`, consistent
  with every other section on the page) listing the 2 tools with a toggle each, wired to the new
  API routes. Placed near "Connected accounts" since tool relevance is downstream of which
  accounts are connected (Teams needs a Microsoft account, though the toggle itself doesn't
  require validating that — an unconnected Microsoft account with Teams "on" just has nothing to
  show, same as today).
- **`client/src/pages/ChatsPage.tsx`**: if Teams is disabled for the current user, replace the
  thread list with an inline state: short explanation + a direct link to Setup → Tools to turn
  it on. Same pattern for the travel/check-ins section currently embedded in Setup — if travel
  is off, that section collapses to the same kind of inline "turn this on" prompt instead of
  showing the Schengen banner/check-in list.
- **`client/src/pages/OnboardingPage.tsx`**: one new step, following the existing page's
  established shape (numbered section, own explanatory line, non-blocking) — a short list of the
  same 2 tools with on/off switches, defaulting to off (see "Open questions" for reasoning),
  with the same "skip for now" affordance already on the page. This is deliberately lightweight:
  a flat toggle list, not a wizard, not a required step.
- `client/src/api/client.ts`: add `fetchTools()`, `setToolEnabled(key, enabled)` following the
  existing typed-fetch-wrapper pattern already used for every other API call in that file.

## Testing

- Travel day-counting is already deterministic/pure (`travelDays.ts`, no model involved) and
  should already have or gain straightforward unit test coverage independent of this change.
- New coverage needed specifically for the enable/disable branching:
  - `buildSystemPrompt`/`tools` construction: both tools off, both on, one of each — assert the
    right schemas/rule fragments are/aren't present.
  - Defense-in-depth: calling a disabled tool's handler directly via `runTool` is rejected even
    when bypassing the schema-level filtering (simulating a hypothetical model or client bug).
  - `GET`/`PUT /api/tools`: basic CRUD + auth-gating (an unauthenticated request is rejected,
    same as every other `/api/*` route).
  - Onboarding step: skipping it leaves both tools in their default state; toggling and
    continuing persists the choice (can reuse existing patterns from how the account-connection
    step is likely already tested, if such tests exist — worth checking during implementation).

## Open questions for implementation time (not blocking this design)

- **Default state for new signups**: decided as **off by default** — the onboarding step is an
  opt-in ("turn on what you want"), not an opt-out ("turn off what you don't"), since that
  matches the "personalizing my assistant" framing better and is the more conservative choice.
  Easy to flip later if it tests poorly.
- Exact route file placement (new `toolsRoutes.ts` vs. extending an existing router) is an
  implementation detail, not a design decision.

## Related work / explicitly out of scope (tracked separately)

This spec is intentionally narrow. The following were identified during brainstorming as
separate sub-projects, each needing its own design pass before work starts:

1. **This spec** — tool registry + toggle mechanism, proven with 2 existing features.
2. Onboarding flow deepening (beyond the lightweight step added here).
3. Building one genuinely new tool (finance tracking or a travel map/logger) as the real test of
   the "cheap marginal tool" claim, using the travel tracker's shape as a template.
4. The "Other" / custom bespoke tool concept — flagged as the highest-risk part of the whole
   pivot (a real risk of becoming an unbounded services business rather than a product feature)
   and needs its own resolution — most likely constrained to a parameterized template system
   rather than true bespoke per-customer builds — before any customer-facing commitment is made.
5. Infrastructure/compliance work that blocks a real subscription business regardless of the
   tools pivot: the shared WhatsApp number's scaling ceiling and a live compliance gap (proactive
   sends outside the 24-hour customer-service window should use pre-approved templates, not free
   text — this exists today, independent of this pivot), no billing/self-serve infrastructure at
   all currently, and the README's own flagged plaintext-data debt (WhatsApp history, extracted
   document text, check-in history) that's explicitly noted as needing revisiting "if this grows
   beyond a handful of trusted users."
