# Idea: let someone use Marlowe without connecting an email

## Where this came from

While wiring up a new onboarding question ("Connecting your email will let me draft responses,
add calendar events, flag important emails — want to start here?" with Yes/No buttons), the
obvious next question was: what happens on **No**? Could Marlowe still be useful — reminders,
"what's a good restaurant near me", forwarded receipts — for someone who never connects a mailbox?

Short answer: not without real schema/data-model work. This file is a placeholder plan for that
work, not something to build casually alongside a wording change.

## What's stopping it today

Account identity is keyed entirely on the connected mailbox's email address:

- `users` table (`server/src/db/store.ts` ~line 87): `email TEXT NOT NULL UNIQUE`. There is no
  concept of a user row without an email.
- The **only** place a `users` row gets created is inside the OAuth callback
  (`server/src/routes/authRoutes.ts`, `addPhoneNumberForUser` calls around lines 327 and 452),
  which only runs after Google/Microsoft OAuth actually succeeds.
- `resolveOwnerByPhone` (`server/src/db/store.ts` ~line 1764) — the function that turns an
  inbound WhatsApp number into an owner id for every other route — only finds a match once that
  OAuth-created binding exists. There is no path to it otherwise.
- Lots of downstream code assumes `user.email` is a real, usable address (admin routes, settings
  page, `getUserByEmail` lookups) — anywhere that's read would need an "unconnected" case handled.

So "No" currently has nowhere to land: no owner record to attach a name/preferences to, nothing to
resume from on their next message.

## What the current onboarding does instead (interim, already shipped)

Until this is scoped and built, "No" is **not treated as a real skip**. After the name step, a
Yes/No button question is now asked ("Connecting your email will allow me to help draft
responses, add events to your calendar, and flag important emails. Would you like to start
here?"). Tapping **No** sends "No worries, let me know later if you'd like to connect an inbox.
Let me know how I can help!" but the registration state machine
(`server/src/services/whatsappRegistration.ts`, step `awaiting_email_confirm`) deliberately stays
put rather than advancing or completing. Nothing new is deleted or created by saying no — no
account exists either way.

**What's stored if someone says No:** just what was already captured one step earlier — their
name (if it looked like a real name; free-text sentences are rejected, see `plausibleName.ts`) and
their phone number, in the `pending_whatsapp_registrations` SQLite table. No `users` row, no
email, no calendar/inbox access — none of that is possible pre-OAuth.

**How long it sits there:** indefinitely, until one of two things happens on their *next* message:
- If they message again within 24 hours (`IDLE_RESET_MS` in `whatsappRegistration.ts`), the flow
  just continues — effectively re-asking for their email.
- If more than 24 hours pass, the pending row is silently wiped the next time they do message, and
  they start over from the name question.

**Visibility:** nothing in the admin routes lists/browses these pending rows — an admin can only
delete one via the existing reset endpoint (`adminRoutes.ts`), not review what's in it.

## If we do build this properly, the shape of the work is roughly

1. Make `users.email` nullable (or split identity: a `users` row keyed by phone, with `email`
   attached later once/if OAuth happens) — a real migration, not a quick patch.
2. Create an account at the "No" branch instead of only at OAuth success — decide what a
   no-mailbox account can actually do (reminders? note-taking? "nearby restaurants" type
   assistant chat?) versus what it can't (anything touching `hub.ts`'s inbox/calendar reads).
3. Audit every read of `user.email` (admin dashboard, settings page, alert copy that assumes an
   inbox) for an "unconnected" fallback.
4. Decide whether/how someone later upgrades from no-mailbox to connected — probably just
   re-running the existing OAuth link flow and filling in `email` on the existing row instead of
   creating a second account.
5. Decide what tools stay enabled for a no-mailbox user (`setToolEnabled` / `user_enabled_tools`)
   — likely just reminders/notes/general chat, with calendar/inbox/travel tools hard-disabled
   rather than silently failing.

Not estimated or scheduled — flagging the shape of it so it's easy to pick up later.
