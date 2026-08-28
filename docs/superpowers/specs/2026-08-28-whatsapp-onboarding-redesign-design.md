# WhatsApp onboarding redesign: ordering, copy, and a real feedback channel

## Problem

The WhatsApp-native onboarding (`whatsappRegistration.ts` pre-OAuth, `postConnectSetup.ts`
post-OAuth) has grown two concrete UX problems, confirmed against a real transcript:

1. **A stacked-question bug.** In `postConnectSetup.ts`'s `ask_briefing` handler, tapping "Yes
   please" fires an open-ended text question ("Want me to also include news, business headlines,
   or weather?") and, in the same turn, immediately sends the next button question (Teams) with no
   wait. The user sees two unrelated questions back to back and the content one is effectively
   unanswerable — nothing captures the reply as onboarding-specific (see next point).
2. **Dead-code duplication.** `assistant.ts`'s `onboardingNote` system-prompt paragraph (from the
   2026-08-20 spec) was meant to catch that content answer and pivot to the tools question, gated
   on `hasBriefingSettings(ownerId)` being false. But `postConnectSetup.ts`'s `ask_briefing`
   handler calls `saveBriefingSettings(...)` (to persist the yes/no `proactive` flag) *before*
   sending the content question — which flips `hasBriefingSettings` true immediately, killing
   `onboardingNote` before the user can ever answer. Same class of bug the 2026-08-20 spec fixed
   for `awaiting_briefing_time`, reintroduced by the button-chain rewrite that followed it.

On top of the ordering bug, a real onboarding transcript surfaced copy and sequencing problems:
"Which email do you use?" reads as ambiguous (address vs. provider), "Tap here to let me in"
reads poorly, there's no acknowledgment of what's in the inbox/calendar beyond a bare count, the
Schengen tracker gets asked about unconditionally even though it's a niche feature, the first
daily briefing can fire minutes after registration instead of the next morning, there's no way for
a user to get a request in front of the developers, and none of the copy uses WhatsApp's own text
formatting.

## Design

### A. Pre-OAuth copy (`whatsappRegistration.ts`)

Unchanged state machine (`awaiting_name` → `awaiting_email` → `awaiting_provider` →
`awaiting_link_tap`), copy only:

- `handleAwaitingName`: `` `Nice to meet you, ${name}! Let's connect your email so I can help with your inbox, calendar, and more — what's your email address?` `` (was "Which email do you use?").
- `askProvider`: unchanged — no longer ambiguous once it directly follows a typed email address.
- `sendProviderLink`: CTA body text becomes:
  `` `Almost there — tap below to connect *${PROVIDER_LABEL[provider]}*. I'll be able to read your mail and draft replies, but I can never send anything without you approving it first. This link works for ten minutes.` ``
  (drops "Tap here to let me in"; button label unchanged, still `Connect ${label}`).
- `currentStepPrompt`'s `awaiting_name` / `awaiting_email` strings stay in sync with the new
  wording (used for the post-help-interrupt re-prompt).

### B. New shared mechanism: blocking free-text setup steps

Two new steps need to send a question, then genuinely wait for a reply (real request or a
skip), then continue the chain — the fix for problem #1. Both get the same treatment:

**`db/store.ts`**: extend the step union —
```ts
export type PostConnectSetupStep =
  | "ask_first_task"
  | "ask_briefing"
  | "ask_briefing_content"
  | "ask_teams";
```
(`ask_travel` is removed — see section D.) `getPendingSetup`/`setPendingSetup`/`clearPendingSetup`
are unchanged otherwise.

**`postConnectSetup.ts`**: a shared skip-pattern matcher —
```ts
const SKIP_PATTERN = /^(skip|no|nothing|none|all good|i'?m good|let'?s continue|continue|finish setup)$/i;
function isSkip(text: string): boolean {
  return SKIP_PATTERN.test(text.trim());
}
```

Two step handlers, each returning `Promise<boolean>` (true = fully handled, caller must not also
route the message to `handleText`):

- `handleFirstTaskReply(ownerId, message)`: only applies when `getPendingSetup(ownerId) ===
  "ask_first_task"` and `message.kind === "text"`.
  - `isSkip(message.text)` → reply `"No worries — let's finish setting up."`, then call
    `askBriefing(ownerId, phone)`. Return `true`.
  - Otherwise → call the existing `handleText(ownerId, phone, message.text)` (real assistant
    answers the request, exactly like ordinary chat — the owner is already resolved), then call
    `askBriefing(ownerId, phone)` right after it completes. Return `true`.
- `handleBriefingContentReply(ownerId, message)`: only applies when `getPendingSetup(ownerId) ===
  "ask_briefing_content"` and `message.kind === "text"`.
  - `isSkip(message.text)` → reply `"No worries, just the essentials then."`, then call
    `askTeams(ownerId, phone)`. Return `true`.
  - Otherwise → call `handleText(ownerId, phone, message.text)` (the assistant has
    `set_briefing_preferences` available as an always-on tool and acts on it directly), then call
    `askTeams(ownerId, phone)` right after. Return `true`.
  - Both branches return `false` (no-op) if the pending step doesn't match, same convention as the
    existing `handlePostConnectSetupReply`.

`postConnectSetup.ts` calling `handleText` would create a cycle (`whatsappRoutes.ts` already
imports from `postConnectSetup.ts`). Fix: `handleText` moves out of `whatsappRoutes.ts` into a new
`services/chatDispatch.ts` (`export async function handleText(ownerId, from, text): Promise<void>`
— same body, same imports it already uses: `appendWhatsAppMessage`, `isHelpTrigger`,
`isVersionTrigger`, `findSaveableUrl`, `handleLink`, `getWhatsAppHistory`, `runAssistantChat`,
`sendAssistantReply`). `handleLink` moves alongside it (it's `handleText`'s only internal
dependency besides shared imports). `whatsappRoutes.ts` imports `handleText` from the new module
instead of defining it; `postConnectSetup.ts` imports it the same way. No cycle: both are leaves
depending on the new module, not on each other.

**`whatsappRoutes.ts`'s `handleIncoming`**: add the two new checks alongside the existing one,
before the generic dispatch:
```ts
if (await handleFirstTaskReply(ownerId, message)) return;
if (await handlePostConnectSetupReply(ownerId, message)) return;
if (await handleBriefingContentReply(ownerId, message)) return;
if (await handlePendingActionReply(ownerId, message)) return;
```
(`handleFirstTaskReply` first since it's the earliest step in the chain; order among the rest
doesn't matter since each only fires on its own exact pending step.)

**`assistant.ts`**: replace the `hasBriefingSettings`-gated `onboardingNote` with one keyed off the
pending step instead (accurate now, rather than a flag that flips before it's useful):
```ts
const pendingStep = getPendingSetup(ownerId);
const onboardingNote =
  pendingStep === "ask_first_task"
    ? "The user is mid-setup and was just asked if there's anything they'd like help with before finishing. Answer their request normally — a scripted setup question will follow automatically after your reply, so don't try to ask it yourself."
    : pendingStep === "ask_briefing_content"
      ? "The user is mid-setup, just said yes to a daily briefing, and was asked what to include (news/business headlines/weather). Call set_briefing_preferences with whatever they said, confirm briefly — a scripted setup question will follow automatically after, don't ask about other tools yourself."
      : "";
```
`hasBriefingSettings` import/usage is removed from `assistant.ts` if nothing else there uses it
(confirm at implementation time; `briefing.ts` keeps exporting it regardless since it may still be
useful elsewhere).

### C. Post-connect chain — full new sequence

`startPostConnectSetup` (called once, right after OAuth):
1. Existing connected-confirmation + first-value fact message, unchanged logic.
2. New: `` `Anything you'd like me to look at right now, or shall we finish setting up? Just ask, or say *skip*.` `` → `setPendingSetup(ownerId, "ask_first_task")`. Replaces the immediate call to
   `askBriefing`.

`askBriefing` (unchanged trigger point, now reached via `handleFirstTaskReply` instead of
directly from `startPostConnectSetup`) — copy unchanged, light bold added:
`` `Want a daily morning update with your email, calendar, and anything that looks like it needs a reply?` ``

`handlePostConnectSetupReply`'s `ask_briefing` case:
- Persist `proactive: yes` as today, **plus** the scheduler fix (section E) when `yes`.
- `yes` → send `` `Great — I'll send that each morning. Want me to also include *news*, *business headlines*, or *weather*? Just tell me, or say *skip*.` ``, `setPendingSetup(ownerId, "ask_briefing_content")`. **Does not** call `askTeams` directly anymore.
- `no` → go straight to `askTeams(ownerId, phone)` (content question is moot).

`askTeams` — copy gets light bold (`*Microsoft Teams*`), otherwise unchanged. Reached either from
`ask_briefing`'s `no` branch or from `handleBriefingContentReply`.

`handlePostConnectSetupReply`'s `ask_teams` case — **replaces** the current `askTravel` call with
the closing message (section D/F): `setToolEnabled`, `clearPendingSetup`, send closing message.

### D. Schengen/travel question removed from onboarding

`askTravel` and the `ask_travel` step/case are deleted from `postConnectSetup.ts` and the step
union. The Schengen tracker stays available exactly as it is everywhere else (`set_tool_enabled`
in normal chat, the web Settings/onboarding "Your hub" step) — only the unconditional ask during
WhatsApp onboarding goes away. A trigger tied to "first EU trip" is out of scope for this design;
tracked as separate follow-up work (needs its own design for what counts as a trip).

### E. Scheduler fix: no same-day briefing

`runDailyCheckForUser` (`scheduler.ts`) already skips a user for the day if
`getSetting(ownerId, "last_proactive_send_date") === todayKey()`. `postConnectSetup.ts`'s
`ask_briefing` handler, when `yes`, sets that flag to today's date right after saving
`proactive: true` — so the scheduler's next tick sees "already sent today" and the first real
briefing goes out tomorrow morning instead of minutes after onboarding.

`todayKey()` is currently duplicated in `briefing.ts` and `scheduler.ts`. Since
`postConnectSetup.ts` now needs it too, extract it once into a new `services/dateKey.ts`
(`export function todayKey(): string`), and update both existing call sites to import it instead
of keeping their own copy.

### F. Closing message + admin feedback tool

New closing message (sent from the `ask_teams` case once `setToolEnabled` runs):
```
*All set!* ✅ Ask me anything, or say *help* any time.

One more thing — I'm still in testing, and my developers *Sam* and *Jake* want your feedback. If something's off or you've got a request, just tell me and I'll pass it straight to them.
```

New always-on tool in `assistant.ts`, alongside `set_briefing_preferences`/`set_tool_enabled` in
`ALWAYS_ON_TOOLS`:
```ts
{
  name: "send_feedback_to_admin",
  description:
    "Relay a bug report, complaint, or feature request from the user to the developers (Sam and Jake). Call this whenever the user asks you to pass something along, report an issue, or explicitly says something like 'tell Sam' / 'send this to admin'. Not for routine questions — only for something they clearly want a human to see.",
  input_schema: {
    type: "object",
    properties: {
      summary: { type: "string", description: "A concise summary of the feedback/request/bug, in the user's own terms." },
    },
    required: ["summary"],
  },
},
```
`runTool` case:
```ts
case "send_feedback_to_admin": {
  const summary = input.summary as string;
  const reporter = getUser(ownerId);
  const adminId = getAppOwnerUserId();
  const adminNumbers = listPhoneNumbersForUser(adminId).map((r) => r.phone);
  const text = `*Feedback from ${reporter?.email ?? `user #${ownerId}`}:*\n${summary}`;
  if (adminNumbers.length === 0) {
    console.error(`send_feedback_to_admin: no WhatsApp number registered for the app owner (user ${adminId}) — feedback logged only`, { ownerId, summary });
  } else {
    await Promise.all(adminNumbers.map((phone) => sendWhatsAppMessage(phone, text).catch((err) =>
      console.error("send_feedback_to_admin: failed to notify admin", err)
    )));
  }
  return { ok: true };
}
```
Non-fatal by design (best-effort like every other WhatsApp send in this codebase) — a delivery
failure still returns `{ ok: true }` to the model so it confirms to the user rather than surfacing
an internal error; the failure is logged server-side only.

No new table, no admin web page — this reuses the existing "message the owner's registered
WhatsApp number" pattern already used by `alerts.ts`/`memoryReminders.ts`/`reconciliation.ts`.

Requires two additions to `assistant.ts`'s existing `../db/store.js` import list: `getUser` and
`getAppOwnerUserId` (`listPhoneNumbersForUser` likely also needs adding unless already imported —
confirm at implementation time). `sendWhatsAppMessage` needs importing from `../providers/whatsapp.js`
if not already present in `assistant.ts`.

### G. WhatsApp text formatting

WhatsApp supports `*bold*`, `_italic_`, `~strikethrough~` in free-form messages — no underline.
Applied sparingly (key nouns/actions, not decorative) across every message touched by this design:
`MARLOWE_HELP_TEXT` bullets stay as-is (already a clean bullet list); the provider-link, connected,
first-task, briefing, briefing-content, teams, and closing messages above all get light bold as
shown in their copy.

## Error handling

- `handleFirstTaskReply`/`handleBriefingContentReply` mirror the existing
  `handlePostConnectSetupReply` convention: unmatched pending step or message kind → return
  `false`, no side effects, caller proceeds to the next handler in the chain.
- A non-text message (media, interactive) arriving while `ask_first_task`/`ask_briefing_content`
  is pending is not specially handled — it falls through to normal `handleMedia`/interactive
  handling, and the pending step stays put until a text reply advances it. No timeout/expiry is
  added (matches the existing chain's behavior for `ask_briefing`/`ask_teams`, which also just
  waits indefinitely for the right input).
- `send_feedback_to_admin` never fails the tool call itself — WhatsApp send failures are logged
  and swallowed, consistent with every other outbound WhatsApp call in the codebase
  (`postConnectSetup.ts`, `alerts.ts`, etc.).

## Testing

- `server/src/test/postConnectSetup.test.ts` (new or extended): full chain walk —
  `ask_first_task` (skip path and real-request path, asserting `handleText` gets called and
  `askBriefing` fires after either), `ask_briefing` yes → `ask_briefing_content` set +
  `last_proactive_send_date` stamped to today; `ask_briefing` no → straight to `ask_teams`;
  `ask_briefing_content` skip and real-reply paths both landing on `askTeams`; `ask_teams` →
  closing message, `ask_travel` no longer exists.
- `server/src/ai/assistant.test.ts`: `send_feedback_to_admin` sends to the app owner's registered
  number(s) with the reporter's email in the text; returns `{ ok: true }` even when
  `sendWhatsAppMessage` rejects. `buildSystemPrompt`'s new pending-step-keyed `onboardingNote`
  present/absent per step, replacing the old `hasBriefingSettings`-keyed assertions.
- `server/src/services/dateKey.test.ts` (or fold into existing `scheduler`/`briefing` tests):
  `todayKey()` behavior unchanged after extraction.
- Regression test: registering fresh, saying yes to briefing, and answering with text (not
  "skip") on the content question does not send the Teams question until after the assistant's
  reply to that content question — guards the exact bug this design fixes.

## Out of scope

- EU-trip-triggered Schengen prompt (needs its own design for what counts as "a trip").
- A dedicated admin web UI/table for feedback — explicitly deferred; WhatsApp-to-owner is the
  whole mechanism for now.
- Changing the pre-OAuth identity steps' state-machine shape (still name → email → provider →
  link) — copy only, per the 2026-08-20 spec's own reasoning (invite-checking is a security
  boundary, stays rigid).
