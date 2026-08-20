# WhatsApp onboarding expansion: briefing content + tools, via the real assistant

## Problem

The WhatsApp-native registration flow (`server/src/services/whatsappRegistration.ts`) currently
gets a brand-new user from "Hi" through name → email (invite-checked) → OAuth link → connected,
then asks one narrow question: what time should the morning briefing arrive (8am / 9am / no
thanks). It doesn't ask about briefing *content* (weather, news topics, markets) or the optional
tools (Teams chat, travel/Schengen tracker) — both of which the web onboarding flow
(`client/src/pages/OnboardingPage.tsx`) already covers in its "Your hub" and "Briefing" steps. A
WhatsApp-only user currently has no way to configure either without switching to the website.

## A pre-existing bug this design also fixes

`addPhoneNumberForUser(user.id, reg.phone)` runs in the OAuth callback (`authRoutes.ts`) *before*
`sendFirstValueAndAskBriefingTime` sends the "what time?" prompt. Once that call has run,
`resolveOwnerByPhone(phone)` resolves for that number — so `whatsappRoutes.ts`'s `handleIncoming`
routes the user's very next message straight to the normal chat engine (`runAssistantChat`),
never back into `handlePendingRegistration` / `handleAwaitingBriefingTime`. The reply "8am" today
is treated as an ordinary chat message; the briefing time from WhatsApp onboarding silently never
saves. The `awaiting_briefing_time` step is effectively dead code in production.

This also means the fix is nearly free: once OAuth completes, the person already has a working
hub, and the next thing they type already flows through the real, tool-calling assistant with no
new routing required.

## Design

### Flow

**Before OAuth** (unchanged — this is the security-relevant identity part, stays a rigid state
machine): `awaiting_name` → `awaiting_email` (invite-checked via `isEmailInvited`) →
`awaiting_link_tap`.

**After OAuth** (new):

1. Connected-confirmation message (unchanged): "Connected — I can see your inbox and calendar.
   ${fact}."
2. One new scripted push — authored copy, not LLM-generated, since nothing's been said yet to
   respond to:
   > "Each morning I'll send you an update on your email, calendar, and anything that looks like
   > it needs a reply. Want me to also include news, business headlines, or weather?"
3. The pending-registration row is marked `completed` immediately after step 2 sends — there is
   nothing left to await server-side; `awaiting_briefing_time` is removed from
   `PendingRegistrationStep`.
4. The user's reply is now their first ordinary WhatsApp chat message. Two new tools
   (`set_briefing_preferences`, `set_tool_enabled`, see below) let the assistant act on it exactly
   like any other tool call, and confirm back in plain language.
5. Once briefing preferences exist for the user (see "pivot signal" below), a system-prompt
   instruction has the assistant pivot — *in that same reply* — to asking what else they'd like
   help with day to day (Teams chat search, travel/Schengen tracking), and act on the answer via
   `set_tool_enabled`. This is not a second scripted WhatsApp message; it's the assistant's own
   next line, so a user who already said "I use Teams constantly" while answering the briefing
   question can just get "Teams chat search — done" instead of being asked again.

A user who ignores both prompts and starts asking normal questions ("what's in my inbox today?")
falls through to ordinary chat with no harm — the two new tools stay available for later ("turn on
Teams" whenever they think of it works the same six months in as it does on day one).

### Pivot signal: no new state

`buildSystemPrompt(ownerId)` doesn't see conversation history today (only `runAssistantChat`
does), so detecting "still onboarding" by conversation shape would need new plumbing and would be
fragile. Instead, key off data that will already exist: `getBriefingSettings(ownerId)` already
falls back to `DEFAULT_SETTINGS` when nothing has been saved for that user. When it's still at
defaults, `buildSystemPrompt` includes an extra paragraph instructing the assistant to settle
briefing preferences first, then pivot to the open-ended tools question in the same reply. Once
`set_briefing_preferences` has been called for that user (any time, not just during onboarding),
the paragraph disappears — a returning user is never re-onboarded.

### Two new tools (`server/src/ai/assistant.ts`)

Both join `ALWAYS_ON_TOOLS` — not gated behind `TOOL_KEYS`, since gating "turn Teams on" behind
Teams already being on would be circular.

- **`set_briefing_preferences`** — patch-style, mirrors `BriefingSettings`
  (`server/src/services/briefing.ts`) exactly: optional `include_weather` (bool) +
  `weather_location` (string), `include_news` (bool) + `topics` (array of `NewsTopic` values —
  unrecognized values are silently dropped rather than erroring, same "ask again rather than
  guess" spirit as the code this replaces), `include_markets` (bool) + `tickers` (array of
  strings), `proactive` (bool) + `send_time` ("HH:MM"). Implementation is a one-liner reusing
  existing storage: `saveBriefingSettings(ownerId, { ...getBriefingSettings(ownerId), ...patch })`.
- **`set_tool_enabled`** — `tool` (`"teams" | "travel"`) + `enabled` (bool). Validates `tool`
  against `TOOL_KEYS` the same way `toolsRoutes.ts`'s PUT handler already does, returning
  `{ error: "unknown tool: ..." }` (matching `runTool`'s existing error-object convention, not a
  throw) rather than enabling something invalid. Otherwise a direct wrapper around the existing
  `setToolEnabled(ownerId, tool, enabled)`.

Side effect worth noting: these tools aren't onboarding-only plumbing. Any user, any time, can
tell Marlowe "add sports to my morning briefing" or "turn off Teams" in normal chat and it'll
work — that capability currently only exists on the Setup page.

### Removed / changed code

- `server/src/services/whatsappRegistration.ts`:
  - Remove `handleAwaitingBriefingTime` and `parseBriefingTimeReply` (dead code, superseded).
  - `sendFirstValueAndAskBriefingTime` is renamed `sendFirstValueAndBriefingPrompt` (it no longer
    asks specifically about time) and rewritten to send the new step-2 message (above) instead of
    the old "reply 8am/9am/no thanks" prompt, calling `completePendingRegistration(phone)` right
    after sending rather than leaving the row on `awaiting_briefing_time` waiting for a reply that
    structurally can never route back to it. The call site in `authRoutes.ts` (both Google and
    Microsoft register callbacks) updates to the new name.
- `server/src/db/store.ts`: drop `"awaiting_briefing_time"` from `PendingRegistrationStep`.
- `server/src/ai/assistant.ts`: add the two tools to `ALWAYS_ON_TOOLS`, two cases to `runTool`,
  the conditional onboarding paragraph to `buildSystemPrompt`.
- No changes needed to `toolsRoutes.ts`, `briefing.ts`, or `store.ts`'s `setToolEnabled` /
  `getEnabledTools` — all reused as-is.

### Error handling

- WhatsApp send failures for the new step-2 message follow the existing pattern: wrapped in
  `.catch(err => console.error(...))` at the call site in `authRoutes.ts`, same as the
  connected-confirmation today — non-fatal, logged, user just doesn't get that message.
- `set_tool_enabled` with an unknown key returns an error object the model can react to
  conversationally, instead of throwing and breaking the turn.
- `set_briefing_preferences` never rejects on a partially-understood request — it silently drops
  unrecognized `topics` entries and otherwise applies whatever fields were understood, letting the
  model's own reply (not a hard error) carry any needed clarification.

### Testing

- `server/src/test/pendingRegistration.test.ts`: remove/update the test that upserts
  `step: "awaiting_briefing_time"` (that step no longer exists).
- New unit tests for `runTool`: `set_briefing_preferences` patches correctly (merges with
  existing settings, drops unknown topics) and `set_tool_enabled` both enables/disables and
  rejects an unknown key.
- New unit test on `buildSystemPrompt`: the onboarding paragraph is present when
  `getBriefingSettings` is at defaults and absent once briefing settings have been saved.
- New regression test guarding the bug this design fixes: once `addPhoneNumberForUser` has run
  for a phone, an inbound webhook message for that phone routes to the normal chat path, not
  `handlePendingRegistration` — this is the exact condition that made `awaiting_briefing_time`
  dead code, and nothing currently asserts it.

## Out of scope

- Changing anything about the pre-OAuth identity steps (name/email/link) — those stay a rigid
  state machine deliberately, per the earlier design discussion, since invite-checking is a
  security boundary.
- A dedicated "still onboarding" flag/table — explicitly rejected in favor of reusing
  `briefing_settings`'s existing default-vs-saved state.
- Parity for local-folder search ("This computer") in onboarding — that tool requires a
  filesystem path on the server's own machine, which doesn't make sense to configure over
  WhatsApp text; unchanged, stays a Setup-page-only feature.
