# Codebase review — 2026-09-15

Branch reviewed: `feat/onboarding-seamless` (at `234990a`).

Baseline: server and client typecheck clean; all 845 server tests pass. None of the tests cover the
issues below. Two were reproduced with throwaway tests (since deleted); the rest come from tracing
the code by hand. Nothing has been changed yet.

**Legend:** ✅ reproduced · 🔍 traced in code · ❓ plausible, not tested

## Status

| # | Issue | Status |
|---|---|---|
| 1 | Forged OAuth connect state | **Fixed** — callback requires the session to match `state.ownerId` |
| 2 | Microsoft sign-in by `mail` | Open — needs a decision (see below) |
| 3 | Document delete FK failure | **Fixed** — match keys deleted first; file removed only after the row |
| 4 | Gmail alerts lost | **Fixed** — checkpoint saved only after fetch/scan; scanners hold it on retryable failures (max 1h) |
| 5 | Mid-reply message mishandled | **Fixed** — batches matched to history by row id, not position |

Each fix has regression tests that failed before the change. Full server suite: 865 passing.

---

## High

### 1. Anyone can attach their own mailbox to another user's account 🔍
**Where:** `server/src/routes/authRoutes.ts:63-89, 221-225`

The OAuth `state` is plain base64 JSON with no signature. Any visitor can get a valid nonce cookie
from `/auth/google/login-signin`, write a `connect` state containing someone else's `ownerId` (user
ids are small sequential numbers), and finish OAuth with their own Google/Microsoft account. The
callback trusts `state.ownerId`, so the attacker's mailbox is added to the victim's hub.

**Impact:** an email in that mailbox can steer the victim's assistant (prompt injection).
`create_email_draft` runs without confirmation, so it could copy the victim's data into a draft in
the attacker's mailbox.

**Fix:** at the callback, require the session and use its user id instead of `state.ownerId`
(the session cookie is already sent to `/auth/*/callback`), or HMAC-sign the state.

### 2. Microsoft sign-in may allow account takeover ❓
**Where:** `server/src/providers/microsoft.ts:90-91` → `server/src/routes/authRoutes.ts:387-402`

Users are matched by the Graph `mail` field (`profile.mail ?? profile.userPrincipalName`) via the
`/common` endpoint. The admin of any Microsoft tenant can set `mail` on their own users. If it's set
to an existing Marlowe user's address (including the app owner's), they may be able to sign in as
that user. This is the known "nOAuth" pattern; not tested here.

**Fix:** identify Microsoft users by tenant id + object id (`tid`/`oid`), not by email.

### 3. Deleting a document can fail and leave it broken ✅
**Where:** `server/src/db/store.ts:1711`, `server/src/routes/documentRoutes.ts:52-55`

If the document has a `document_match_keys` row (booking codes, flight numbers), `deleteDocument`
throws `SqliteError: FOREIGN KEY constraint failed`. The route has already unlinked the file on disk
by then. The Files page doesn't check the response, so the document stays listed and "View" returns
404.

**Fix:** delete `document_match_keys` (and `links` pointing at the document) in a transaction before
the document row; only unlink the file after the DB delete succeeds.

### 4. Email alerts from Gmail can be lost for good 🔍
**Where:** `server/src/providers/google.ts:279-290`

`googleListNewMessages` saves the new history checkpoint (`setAccountHistoryId`) before fetching the
messages. If the `messages.get` fan-out fails (e.g. the Gmail quota error from 2026-09-10), those
messages never come back on a later tick.

The "stays retriable / next tick retries" comments in `server/src/services/importantEmailAlerts.ts`
(lines 168-181, 215, 300-304) don't hold for Gmail: an unmarked message isn't returned again once
the checkpoint has moved. Same for undelivered alerts and failed classification.

**Fix:** advance the checkpoint only after messages are fetched, and ideally only after consumers
have processed them.

### 5. A WhatsApp message sent while Marlowe is still replying gets mishandled ✅
**Where:** `server/src/services/messageBatching.ts:96-106`

Overrides are matched to history rows by position (the last `entries.length` rows), but the reply to
the earlier message is appended to history after the new message arrived. Reproduced:

- **Plain text:** the request to Claude is `[user:A, user:B, assistant:reply#1]` — it ends on
  Marlowe's own reply, not the user's message, so it may error (prefill isn't supported with
  thinking) or produce a garbled answer.
- **Photo / link / swipe-reply:** the request is `[user:A, user:B, user:B+context]` — the override
  overwrites Marlowe's previous reply.

**Fix:** record the history row ids of buffered messages when queueing, and splice overrides by id.

---

## Medium

### 6. Onboarding asks the next question before answering 🔍
**Where:** `server/src/services/postConnectSetup.ts:244-249`, `server/src/ai/assistant.ts:1557`

At the "anything you'd like me to look at?" step, `handleText` only queues the message (debounced).
`askBriefing` then sends the next question immediately, before the answer. The pending step has also
moved to `ask_briefing` by the time the assistant runs, so the `ask_first_task` onboarding note is
never applied. The tests mock `handleText`, so they miss this.

### 7. Some confirmation and choice messages will fail to send 🔍
**Where:** `server/src/providers/whatsapp.ts:218-228`, `server/src/ai/assistant.ts:1468`

The prompt tells the model to put the full email draft in the `ask_user_choice` question, but
WhatsApp caps interactive body text at 1,024 characters. Button titles over 20 characters (24 for
list rows), or more than 10 options, are also rejected. The user just sees "Sorry, I hit an error".

**Fix:** send long drafts as a normal message first and keep the button body short; truncate labels;
cap options.

### 8. The help-widget rate limit is shared by every visitor 🔍
**Where:** `server/src/routes/helpChatRoutes.ts:35`, `server/src/index.ts`

Express isn't configured with `trust proxy`, so behind Railway `req.ip` is the proxy's address. All
visitors share one bucket of 15 messages per 10 minutes. Message length isn't capped either (cost
abuse), and the timestamp map grows unbounded.

### 9. Calendar times can be wrong 🔍
**Where:** `server/src/providers/microsoft.ts:285-316`, `client/src/pages/CalendarPage.tsx:16-26`

Outlook returns `dateTime` in UTC with no zone marker (no `Prefer: outlook.timezone` header is sent).
The client, `findFreeSlots`, the briefing, and the model all read these as local time. Google all-day
dates (`"2026-09-15"`) are parsed as UTC midnight, so they can display as the wrong day/time. Event
sorting in `hub.ts:261` also compares these mixed formats as strings.

### 10. Any logged-in user can list file names on the server 🔍
**Where:** `server/src/providers/local.ts:27-34`, `server/src/routes/localRoutes.ts`

"Folders on this computer" accepts any path. On Railway, "this computer" is the server, so any
invited user can enumerate server file names (and so can the assistant's `search_files`).

### 11. Old conversation summaries survive account deletion 🔍
**Where:** `server/src/db/store.ts:2767` (`deleteUserCompletely`), `server/src/ai/assistant.ts:1628`

`whatsapp_conversation_summaries` is keyed by phone and never deleted. After reset-test-phone (or a
real account deletion), a new account on the same number gets the old summary in its system prompt.

### 12. A failed send to one number means repeat messages to the others 🔍
**Where:** `server/src/services/scheduler.ts:79-82`, `memoryReminders.ts:48`, `tripPrep.ts:67`,
`importantEmailAlerts.ts:215`

If an account has several numbers and one send fails, the item isn't marked sent, so it retries every
5 minutes and the numbers that succeeded receive it again. Affects the daily briefing, reminders,
trip nudges, and important-email alerts for Outlook accounts.

### 13. Marlowe says an invoice went to Xero when it didn't 🔍
**Where:** `server/src/ai/assistant.ts:1253, 1267`

`respond_to_invoice_forward_prompt` always returns `forwarded: true`. Forwarding only actually happens
if the document is filed as `receipts` with an active expense, and never for an attachment that was
already extracted (`alreadyExtracted`).

### 14. The account Read/Delete toggles only cover email 🔍
**Where:** `server/src/services/hub.ts:254-375`

`requirePermission` isn't checked for calendar events (list/create/update/delete), drafts, labels,
contacts, or files. E.g. a calendar event can be deleted with "Delete" turned off. (See open
questions — this may be intended.)

---

## Low

15. **A number removed in Settings can get stuck.** Its pending registration stays `completed`, so if
    that number messages again it's silently ignored (`whatsappRegistration.ts:363-367`).
16. **The one-number-per-account cap can be bypassed.** In WhatsApp sign-up, signing in on the OAuth
    screen with an existing account's email adds a second number to it (`authRoutes.ts:250-252`).
17. **Replacing your WhatsApp number can leave you with none.** `whatsappSettingsRoutes.ts:50-66`
    removes the old number before adding the new one; if the add is rejected (409) the account has no
    number. `SettingsPage.tsx` `handleAddNumber` doesn't handle the error.
18. **Document extraction may save the wrong text.** ❓ If the model writes a short preamble alongside
    its first tool call, `runExtraction` stops and saves the preamble as the extraction
    (`documents.ts:337`).
19. **A briefing time like "7:30" never fires.** `send_time` from `set_briefing_preferences` isn't
    validated, and `"07:45" < "7:30"` is true as a string comparison (`scheduler.ts:54`).
20. **Client calls ignore server errors.** `deleteDocument`, `disconnectAccount`,
    `updateAccountPermissions`, and `removeMemoryNote` in `client/src/api/client.ts` never check
    `res.ok`, so failures are silent.

---

## Open questions

- **#14:** should the account Read/Delete toggles also cover calendar, contacts, and files, or only
  email?
- **#10:** should "Folders on this computer" be available at all when Marlowe runs on the server?

## Suggested order

Fix #1, #3, #4, #5 first, each with a failing test before the change.
