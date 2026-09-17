# Phone-first accounts

**Date:** 2026-09-17
**Status:** approved, not yet implemented
**Supersedes:** `feature-to-do/email-less-accounts.md` (Jake's placeholder plan — same feature,
written while shipping the Yes/No onboarding question in `21dba88`)

## Summary

Make a WhatsApp phone number sufficient to create a Marlowe account. Google/Microsoft OAuth
becomes an optional feature someone links when they want inbox and calendar help, not the thing
that brings the account into existence.

## Why

Two reasons, one strategic and one a live bug.

**Strategic.** Today the first thing Marlowe asks of a stranger is full mailbox access — Gmail
read/modify/compose, calendar, Drive, contacts. That is a steep ask from a product they have not
tried. Testers who would happily use reminders, notes and document storage have to hand over
their inbox before they can send a single message.

**The live bug.** `21dba88` (merged to master as PR #65) added a Yes/No question before the email
ask. Tapping **No** replies *"No worries, let me know later if you'd like to connect an inbox. Let
me know how I can help!"* — but no account exists, so there is nothing to help with. The state
machine parks at `awaiting_email_confirm`, and the next message the person sends falls through
`handleAwaitingEmailConfirmText` to `getRegistrationAssistReply(text, "email")`, whose job is
nudging them back toward giving an email.

So Marlowe promises to help and then deflects every request back to the email question. Anyone
who taps No is stuck until they relent or give up. Jake documented this honestly in
`feature-to-do/email-less-accounts.md`; it is shipped and in front of testers now.

This design makes the No branch land somewhere real, which fixes the bug as a side effect of the
feature.

## Decisions taken

Settled during brainstorming; recorded here so they are not relitigated mid-implementation.

| Decision | Choice | Why |
|---|---|---|
| Web portal for phone-only users | **No portal.** WhatsApp only. Linking email unlocks it. | The portal session comes only from OAuth. Building WhatsApp OTP or magic-link sign-in is a whole auth path for users who, by definition, came for the texting product. |
| Signup conversation shape | **Keep Jake's flow as built.** | Name → three intro messages → Yes/No email offer is already exactly the right shape. Only the No branch changes. |
| Capability of a mailbox-less account | **Everything that does not need a mailbox.** | Reminders, to-dos, notes/memory, documents and photos, general chat, feature requests. Inbox/calendar/travel requests get a clean offer to connect rather than a silent tool failure. |
| Email already belongs to another account | **Refuse the link.** No merging. | Matches the precedent already set in both existing collision checks. Merging two sets of to-dos, documents, memory and usage is not worth building for a beta. |
| Existing users | **Untouched.** | They keep their emails and every path they use today. |

Explicitly **not** in scope: portal access for phone-only users, account merging, periodically
re-offering email to someone who declined.

## Current state

Account identity is the connected mailbox:

- `users.email` is `TEXT NOT NULL UNIQUE` (`server/src/db/store.ts`). There is no concept of a
  user row without an email.
- The only place a `users` row is created for a real person is inside the OAuth callbacks —
  `authRoutes.ts:325-327` (Google) and `:450-452` (Microsoft). Both run only after a successful
  token exchange.
- `resolveOwnerByPhone` turns an inbound number into an owner id for every other route, and only
  finds a match once that OAuth-created binding exists.
- All four session-creating sites (`authRoutes.ts:343, 386, 462, 486`) are OAuth callbacks. There
  is no password signup and no magic link.

Two facts make this cheaper to change than it looks:

- `user_phone_numbers.phone` is already `TEXT NOT NULL UNIQUE`. The identity key we need already
  exists and is already unique.
- `PRAGMA foreign_keys` is never enabled, so SQLite defaults it to OFF. The 29 `REFERENCES
  users(id)` declarations are documentation, not enforced constraints, which makes rebuilding the
  `users` table safe.

## Design

### 1. Schema: `users.email` becomes nullable

SQLite cannot relax `NOT NULL` in place, so this is the standard table rebuild inside a
transaction: create `users_new` with the relaxed column, copy every row, drop `users`, rename.

`email` keeps its `UNIQUE` constraint. SQLite permits multiple `NULL`s in a unique column, which
is exactly the behaviour we want: many phone-only accounts, still no two accounts sharing an
address.

Guarded by reading the `notnull` flag from `PRAGMA table_info(users)` so the migration is
idempotent and a no-op on the second boot, matching the existing lightweight-migration style in
`store.ts`. Because foreign keys are off, no other table needs touching and nothing cascades.

Rollback: the migration only widens what the column accepts. Existing rows are copied verbatim,
so a phone-first deployment can be reverted as long as no `NULL`-email rows have been created
yet. Once they exist, reverting requires deleting them.

### 2. `findOrCreateUserByPhone(phone)`

New store function mirroring `findOrCreateUserByEmail`. In one transaction: create a `users` row
with `email = NULL`, then bind the phone with `addPhoneNumberForUser`.

`addPhoneNumberForUser` already throws when the number belongs to another account, and already
returns the existing row when it belongs to this one, so the "called twice" case is handled by
code that exists.

### 3. The No branch creates the account

`handleEmailConfirmTap`, on `EMAIL_CONFIRM_BUTTON_IDS.no`, calls `findOrCreateUserByPhone`,
carries the captured name forward, calls the existing `completePendingRegistration`, and confirms
in the reply.

`sendFirstValueAndBriefingPrompt` is the pattern to mirror for the name: read the pending row,
and if `pending.name` passes `isPlausibleName`, write it to the durable `user_name` setting via
`setSetting(ownerId, "user_name", pending.name)`. Same guard, same key — a sentence-shaped
non-name is dropped rather than becoming someone's permanent display name.

From the next inbound message on, `resolveOwnerByPhone` resolves the number, so
`whatsappRoutes.ts` routes to the normal assistant and never re-enters
`handlePendingRegistration`. That is the whole fix for the live bug.

The typed equivalents in `handleAwaitingEmailConfirmText` (`no`, `no thanks`) already route
through `handleEmailConfirmTap`, so they inherit this for free.

### 4. Mailbox-less capability

Smaller than `email-less-accounts.md` anticipated. Email and calendar tools are not
feature-flagged — `TOOL_KEYS` is only `["teams", "travel"]` — they simply operate on
`listAccounts(ownerId)`, which for these users is empty.

`buildSystemPrompt` (`assistant.ts:1663`) already has a no-accounts branch. It currently emits
`(none connected — tell the user to connect an account on the Setup page first)`, which is portal
language a WhatsApp-only user cannot act on. Replace it, for users with no connected account,
with wording that tells the model to offer connecting an inbox right there in the chat.

Reminders, to-dos, notes, memory, documents and general chat need no changes.

### 5. Linking email later

Reuses the existing OAuth register flow. One change at each callback: when the registering phone
already owns an account, attach the email to **that** row rather than calling
`findOrCreateUserByEmail` and creating a second one.

Collision — the email already belongs to a different `users` row — is refused with the existing
`ACCOUNT_EXISTS_WHATSAPP_TEXT`. The phone-only account is left exactly as it was; nothing is
merged, moved or deleted. An admin can untangle it with the existing reset-test-phone endpoint.

### 6. `user.email` read-site audit

Roughly 18 sites read `user.email`. Most are admin and portal surfaces that only ever see OAuth
users, but each needs a defined rendering for an unconnected account rather than printing `null`.
`isAppOwner` and the bootstrap admin stay email-based and are untouched.

## Testing

TDD, following the repo's existing test style.

**The regression that matters most:** after tapping No, a subsequent message reaches the
assistant, not the registration handler. That is the bug this feature fixes and the thing most
likely to silently regress.

Also covered:

- No creates a real `users` row with `email = NULL`, with the phone bound and the name preserved.
- A phone-only user who later links email fills in the existing row — asserted by user id,
  ensuring no second account.
- Linking an email that belongs to another account is refused, and the phone-only account is
  intact afterward.
- The migration is idempotent and preserves existing users' emails across a rebuild.
- Yes still walks the original path to a connected account, unchanged.
- A mailbox-less user asking something inbox-shaped gets the offer to connect, not a tool error.

## Risks

**The `users` rebuild is the sharp edge.** It is the one step that can lose data if it goes wrong,
and it runs at boot against the production SQLite file. Mitigation: wrap in a transaction, verify
the row count matches before dropping the old table, and rehearse against a copy of the
production database before deploying.

**Two accounts for one person.** Someone who signs up phone-only and later signs into the portal
with Google — having never linked it — would create a second, email-keyed account. The phone is
already bound to the first account, so they cannot be merged by the phone path. Accepted for
beta; the refusal in §5 covers the WhatsApp direction, and the portal direction is only reachable
by a user who was told they have no portal.

## Sequencing

1. Schema migration, with tests, deployed and verified before anything depends on it.
2. `findOrCreateUserByPhone`.
3. The No branch — at which point the live bug is fixed and the feature is usable.
4. System-prompt wording for mailbox-less users.
5. Linking email later.
6. Read-site audit.

Steps 1-3 are the feature. Steps 4-6 make it good.

## Coordination

Branch from `master` (this builds directly on Jake's `21dba88`), not from
`fix/review-findings-6-12`. Jake wrote `feature-to-do/email-less-accounts.md` as his own plan for
this work — tell him it is being built so he does not start it independently. That file should be
deleted as part of the implementation, with this spec replacing it.
