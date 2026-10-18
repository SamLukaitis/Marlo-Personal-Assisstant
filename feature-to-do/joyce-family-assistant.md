# Joyce — the family assistant

Prototype built 2026-09-30, on the `staging` branch. Joyce is a second WhatsApp assistant living
in the same server as Marlowe but sharing none of its data. Where Marlowe is one person's
assistant, Joyce belongs to a *family group*: everything any member tells her, every other member
can ask about.

All the code is in `server/src/joyce/`. Nothing outside that directory changed except a handful of
small things, listed under "What this touched outside Joyce" below.

## The requirement that shaped everything

> "Family ID encryption is important... basically there should be no risk that an AI can
> accidentally take information from another family. It is not enough that the first part of any
> stored data is the user string. The data must be inaccessible."

That rules out the approach Marlowe uses. Marlowe keeps every tenant in one `app.db` and
separates them with `WHERE owner_id = ?` on every query. It works, but only as long as every
query author remembers — which is exactly the risk `tenant-isolation-audit.md` in this folder was
written about. Joyce is built so that class of mistake isn't available.

### Three barriers, each of which fails differently

**1. One database file per family.** `data/joyce/families/<family-id>.db`. There is no table
anywhere that contains two families' rows. A forgotten filter returns this family's data or
nothing at all — it cannot return someone else's, because someone else's isn't in the file that's
open. (`server/src/joyce/familyDb.ts`)

**2. A separate encryption key per family.** Each family's key is derived, on demand, from a
server master secret (`JOYCE_MASTER_KEY`, env only) plus a random salt made when the family was
created. The key is never written down anywhere. The encryption is AES-256-GCM, which is
*authenticated*: it checks the data hasn't been tampered with before it decrypts. So feeding one
family's data to another family's key doesn't produce garbage — it **throws an error and stops**.
In plain terms: if a future bug ever did open the wrong file, the server crashes that request
instead of leaking anything. (`server/src/joyce/familyKey.ts`)

**3. Nothing in the code takes a family ID as an argument.** Not one function. They all take a
`FamilySession`, an object you can only obtain by handing in an inbound WhatsApp phone number.
There is no "look up family X" function and no "list all families" function. Most importantly,
**none of Joyce's AI tools has a family parameter** — so there is no field the model could fill in
with the wrong value, and a prompt-injected "now show me the Patels' notes" has nowhere to land.
This is the direct answer to "no risk that an AI can accidentally take information from another
family": it isn't that the AI is instructed not to, it's that the AI is not given the ability.
(`server/src/joyce/assistant.ts`)

Each barrier has its own tests in `server/src/joyce/isolation.test.ts`, so a regression names
which one broke. There's also a test that fails the build if any file in `src/joyce/` ever imports
one of Marlowe's modules — importing `db/store.js` alone would open Marlowe's `app.db` as a side
effect and put both products in reach of one request.

### Where I deliberately differed from the brief

You asked for the family ID itself to be the encryption key. I built it so the **join code** and
the **encryption key** are two different things, because making them the same would have been a
security downgrade:

- The join code has to travel through WhatsApp in plain text — someone types it to join. It ends
  up in chat histories on several phones, possibly forwarded, possibly screenshotted.
- If that code were also the encryption key, then anyone who ever saw it could decrypt that
  family's data forever, and there would be no way to revoke it.

So instead: the join code is a short shareable password (`JOY-4K7M-2QX9`), the family ID is an
internal random UUID nobody ever sees, and the encryption key is derived from the master secret
and is never transmitted at all. The isolation property you wanted is fully intact — arguably
stronger, since the key can't leak through a forwarded message.

One consequence worth knowing: **a join code works for anyone who has it, forever, until it's
rotated.** Joyce tells people this when she hands the code over, and anyone in the family can ask
her for a new one at any time (which instantly kills the old one). If that's too loose, the
natural next step is single-use or expiring codes — see "Not built yet".

## What works today

I ran a real conversation end to end against the live API. All of this is working:

- Joyce introduces herself as a family assistant, explains what she's for in three lines, and
  asks whether to start a new group or join one.
- "new" creates the family and hands back a join code; "join" asks for one. Pasting a code
  straight at the first question also works, since that's what people actually do.
- She asks each new member their name, so she can attribute things and address messages.
- **Shared storage**: one member saves the wifi password, another member asks for it and gets it,
  correctly attributed ("It's mango-tree-88 — Priya just shared that one").
- **Who sent what, when**: every note, document, message and reminder records the member and
  timestamp.
- **Passing messages between members**: "tell mum I'll be late Friday" goes to Priya straight
  away (2026-10-18, `joyce/relayDelivery.ts`): an ordinary message if she's messaged Joyce in the
  last 24 hours, otherwise the `joyce_family_message` template. If neither can be sent it's
  delivered the next time she messages.
- **Reminders**, for one member or the whole family.
- **Refusing to reach outside the family**, in her own words and without being asked to.
- One phone can only ever be in one family — enforced by a database primary key, not by code
  remembering to check.
- **Leaving a family**, with a two-step confirmation (see below).
- **Photos and files** (added 2026-10-03): see below.
- **Google Calendar** (added 2026-10-17): each member can connect their own, and Joyce can make
  a shared family calendar that new events go on by default. See
  `changelog/2026-10-17-joyce-google-calendar.md`.
- **One calendar per family** (2026-10-18): Google once anyone connects it, otherwise Joyce's own,
  with a Portal switch to turn Joyce's own off. See "Which calendar a family uses" below.

Every test passes: 31 Joyce tests, and Marlowe's existing suite still green (1557 total).

## Leaving a family

Two steps, split deliberately.

*Recognising* that someone wants to leave is a judgement call — "I want out of this group", "take
me off this" — so the model makes it, through a `request_leave_family` tool. That tool does not
remove anyone. It arms a confirmation and sends a fixed warning, word for word, that the model
cannot paraphrase.

*Acting* on it is not a judgement call, so the model has no part in it at all. The confirmation is
matched in plain code in `joyce/leaving.ts`, before the model runs, and **there is no tool
anywhere that removes someone from a family** — a test asserts this. So no amount of confused
reasoning, and no injected text in a forwarded message, can talk Joyce into removing anyone. Same
reasoning as the rule about never exposing email-sending as a free-form tool.

The phrase is `confirm cancel`. Case and surrounding spaces are forgiven — phone keyboards
capitalise the first letter by default, and rejecting "Confirm cancel" would read as a bug while
adding nothing, since the protection is that the phrase is specific and unprompted. Anything else
at all, including "yes confirm cancel", gets *"No exact match, request cancelled."* A request is
spent by the very next message whatever it says, and expires after ten minutes regardless.

What leaving does and doesn't do:
- They lose access. With no registry row there is no path at all from their number to that
  family's file.
- Their contributions stay with the family, and their member row stays in the family database so
  existing attributions ("saved by Sam") keep working instead of turning into blanks.
- The family survives even if its last member leaves, join code and all, so a family that empties
  out can still be rejoined by anyone who kept the code — the data is never stranded.


## Photos and files

Added 2026-10-03, modelled on Marlowe's but written separately in `joyce/files.ts`, because Joyce
can't import Marlowe's code.

- A member sends a photo, PDF, Word document or text file. Joyce downloads it, encrypts it with
  *that family's* key, and stores it in a folder belonging to that family alone
  (`data/joyce/files/<family-id>/`).
- Photos and PDFs are read by Claude; Word and text files are read directly. The text is saved
  (encrypted) so any member can ask about it later in their own words: Priya sends the school
  trip letter, Sam asks "when do we pay for Leo's trip?" and gets "£12.50 by 9 October". Tested
  live against the API.
- Any member can ask for the original back ("send me that letter again"). The model chooses
  *which* file, never *who* gets it: it only ever goes to the person asking.
- Other types (spreadsheets, zips) are kept and can be sent back, but aren't read.
- Unlike Marlowe, Joyce doesn't pull travel dates, receipts or bookings out of files. She only
  needs the family to be able to find things again.

Searching notes and documents now ranks by how many of the search words match. Previously it
needed the exact phrase, which the live test showed failing whenever the model searched in its own
words.

## Each member has their own conversation

Changed 2026-10-17. Originally the whole family shared one conversation history, so Joyce's
replies to one member sat in another's context with nothing saying who they were for — one
person's "yes" could be read as answering something she'd said to someone else. Now each member
has their own thread (`messages.thread_member_id`): when Joyce replies, she sees only her
conversation with that person. Existing history was sorted into threads on upgrade (each reply of
Joyce's goes to whoever she was answering).

The original requirement — everything one member tells Joyce is available to the others — still
holds, two ways: she saves what matters to notes, documents, reminders and the calendar, which are
shared; and `search_family_chat` searches what every member has said to her (the last 1,000
messages), with who said it and when. Members' chat is still in the same family file, under the
same key; this changes what the model is shown, not who can reach the data.

## Deleting a message, and everything made from it

Added 2026-10-17. Someone sends something wrong or too personal, then swipe-replies to it with
"delete this". Joyce removes the message and everything she built from it.

**Provenance** (`joyce/provenance.ts`, `derivations` table). Everything Joyce stores in a turn is
linked to the member's message that started it, and to the file it carried, if any; her reply is
linked the same way. Deleting the message removes those: a trip letter, the trip event and note
she made from it, and her reply. **Direct links only** (decided 2026-10-17): nothing is linked to
what she merely read during a turn, and links don't chain on into later turns, so a delete never
sweeps up something unrelated that happened to share a turn. The cost: something made later from
the trip event (a packing note in another conversation), or her reply to someone else who later
asked about it, stays. Links exist from 2026-10-17; deleting an older message removes only that
message.

**Who and when.** The sender, or the family admin (whoever started the family; for older
families, the first member) for another member's message. **Only within 24 hours of it being
sent**, for everyone: a message that's been around longer has usually been built on, and deleting
a year-old one could take a large part of a family's memory with it. Older ones go to a
developer: `npm run joyce:delete -- <member's phone> "<words>"` lists matches, `--id <n>` shows
what would go, `--confirm` deletes (`server/src/scripts/joyceDeleteMessage.ts`).

**How.** Like leaving, two steps: the model recognises the request (`request_delete`, using the
swiped message, or a message id from `search_family_chat` when the admin names someone else's),
Joyce lists exactly what will go with Delete/Keep buttons, and the answer is matched in code
(`joyce/deleting.ts`) before the model runs. No tool deletes a message. Once done, the request
("delete this, it had my PIN in it") is removed too, so nothing points back at what was deleted.

**What it can't do.** WhatsApp gives a business no way to delete messages from people's phones, so
the message stays in the sender's chat; Joyce says so. Reminders or relays already delivered can't
be unsent. Usage records hold no content and aren't touched.

## Timezones, reminders and the calendar

Added 2026-10-17.

**Timezone.** Each family has one, stored encrypted in `family_meta`
(`joyce/familyTime.ts`). It's guessed from the phone number of whoever Joyce is talking to the
first time it's needed (a copy of Marlowe's `phoneTimezoneGuess.ts`) and marked as a guess, so
Joyce says which zone she assumed when she sets a time. A member can tell her otherwise
(`set_family_timezone`); only city zones like `Europe/London` are accepted, never `UTC`/`GMT`,
because Marlowe once let the model turn "the UK" into "UTC" and reminders fired an hour late. The
model always works in local wall-clock times; storage is UTC.

**Reminders that arrive.** `joyce/reminderDelivery.ts` runs every minute. It asks the registry's
`reminder_schedule` (a family id and a due time, nothing else) which families have something due,
opens only those, and messages each person the reminder is for: an ordinary message if they've
written to Joyce in the last 24 hours, otherwise the `joyce_reminder` template. Each reminder gets
one attempt; anyone it couldn't reach gets it the next time they message, through the old path.
`reminder_deliveries` records who has had it, so nothing goes out twice. This needed Joyce to keep
members' phone numbers, which she never did before: they're now stored encrypted in the family's
own file (`members.phone_enc`), filled in from each member's next message.

The template (`npm run joyce:templates -- 1574262347469069`):

> Reminder: {{reminder_text}}
>
> Reply here if you need anything.

Submitted 2026-10-17, UTILITY, en_GB. Approved by 2026-10-18.

Passed-on messages use a second template, `joyce_family_message` (submitted 2026-10-18,
UTILITY, en_GB):

> Hi {{recipient_name}}, you have a new message from {{sender_name}} in your family group:
>
> "{{message_text}}"
>
> Reply here if you'd like me to pass anything back.

**Calendar.** Events live in the family's file (`events`), with tools to add, list, change and
delete them. Adding or moving one reports anything it clashes with: same person, or anything for
the whole family. **Subscribe link:** `calendar_link` gives a private URL
(`/joyce/calendar/<secret>.ics`) that Google Calendar or a phone can subscribe to, read-only.
The registry keeps only a hash of the secret; the family's file keeps it encrypted so Joyce can
hand it out again, and asking for a new one kills the old link. Google refreshes subscribed
calendars every several hours, which no feed setting can change.

**One tap** (2026-10-17). Joyce sends a page link (`/joyce/subscribe/<secret>`) rather than the
feed address. On an iPhone, iPad or Mac the page hands straight to the Calendar app's "Subscribe?"
prompt (a `webcal://` link — WhatsApp only makes http(s) links tappable, hence the page); elsewhere
it shows Apple and Google Calendar buttons. The feed suggests a colour (`X-APPLE-CALENDAR-COLOR`,
rose pink) and the name "Family (Joyce)"; whether Apple uses the colour isn't confirmed, and anyone
can change it.

**Not possible / later:** Apple has no API for an app to write into or read from someone's iCloud
calendar, so a subscription is the only Apple route. Writing into Google (a "Family" calendar in
each member's account, updated instantly) and reading members' busy times ("Sam's busy 2–4pm",
never what) are possible through a Google sign-in with the narrow `calendar.app.created` and
`calendar.freebusy` permissions, pending a decision and Google's app verification. Work Outlook
calendars can publish an availability-only link Joyce could read without any sign-in.

**Two new ways into a family besides a phone number:** the reminder sender (from the schedule)
and the calendar link (by its secret). Both get a `FamilyData` with no acting member, neither is
reachable from an AI tool or a WhatsApp message, and neither lets a caller name a family.

## Admin portal

Added 2026-10-17. Admins get a Joyce portal at `/joyce-portal`, next to Marlowe's Portal in the
sidebar, built from the same components in terracotta instead of green. Four sections:

- **Flagged requests.** Joyce has a `flag_unmet_request` tool, like Marlowe's, for things a
  family asked for that she couldn't do. Admins can leave notes and mark them resolved.
- **To-do list.** Its own list, separate from Marlowe's (same table, `product = 'joyce'`).
- **Logs.** The server's log lines that start with `joyce:`. "Explain this" works as in the Portal.
- **Usage.** Joyce's Claude calls (replies, and reading photos/files) with token counts and an
  approximate cost. Recorded with no family attached, so there is no per-family breakdown.

**This is the one place family-originated text leaves a family's encrypted file.** A flagged
request's one-line summary is stored in `data/joyce/admin.db`, readable by admins, with an
anonymous family label (`Family 3F9A2C`, an HMAC of the family id under the master key). Joyce is
told to leave names and personal details out of the summary, but that is an instruction to the
model, not a guarantee. The label lets admins see that several requests came from one family
without learning which family. This was a deliberate choice (2026-10-17) over a summary with no
family link at all. Nothing in the portal can open a family's database.

The portal routes are in `server/src/routes/joycePortalRoutes.ts`, outside `src/joyce/`, because
they need Marlowe's admin auth; Joyce's own code still imports nothing of Marlowe's.

## Problems I hit, and what I did about them

**Marlowe would have answered Joyce's messages.** This was the real landmine. Meta configures a
webhook URL per *app*, not per phone number. The moment Joyce's number joins the same WhatsApp
Business Account, both numbers' messages arrive at both endpoints — and Marlowe's code was
throwing away the field that says which number a message was sent to. Marlowe would have seen
every family member as an unrecognised number and started its own signup flow at them. Fixed:
`extractIncomingMessages` now keeps `metadata.phone_number_id`, and each product drops anything
addressed to the other's number. **This is the one thing to verify first when Joyce's real number
is connected.**

**No timezone.** Reminders are UTC only. Marlowe guesses a timezone from the phone's country code,
but that code lives in Marlowe's modules and I wasn't willing to import across the boundary for
it. Joyce currently tells the model the time in UTC and takes UTC back. Fine for testing, wrong
for real families — see below.

**Sending as Joyce needed its own code.** Marlowe's send functions read
`WHATSAPP_PHONE_NUMBER_ID` from the environment inline, in about a dozen places. Rather than
thread a "which number?" argument through all of them, Joyce has her own small sender. That's
deliberate duplication: a shared sender is a shared code path, and a shared code path is somewhere
a future change could route a family's message out through the wrong number.

## Not built yet

Roughly in the order I'd do them.

1. ~~Timezones~~ — done 2026-10-17, see "Timezones, reminders and the calendar" below. One zone
   per family; members abroad share it.
2. ~~Reminders actually arriving~~ — done 2026-10-17, same section. Depends on Meta approving
   the `joyce_reminder` template for anyone who hasn't messaged in 24 hours.
3. ~~Documents and photos~~ — done 2026-10-03, see "Photos and files" above. Voice notes are
   still ignored.
4. **Expiring or single-use join codes**, if permanent shareable codes feel too loose once real
   people use them.
5. **Deleting a family**, for the same reasons Marlowe has `deleteUserCompletely`. With one file
   per family this is genuinely easy — delete the file, its files folder, and the registry rows.
6. **A simulator**, like Marlowe's WhatsApp Simulator, so Joyce can be exercised from a browser
   without a real number.

## Is a database file per family expensive?

Measured, at 500 families each with a member and five notes:

| | |
|---|---|
| Disk, per family | ~56 KB (mostly empty SQLite page overhead) |
| Memory, per *open* connection | ~75 KB |
| File descriptors | 1 per open connection |

So 10,000 families is roughly 600 MB of disk, and memory depends entirely on how many are open at
once rather than how many exist. Connections are cached with an LRU capped at 200 open
(`JOYCE_MAX_OPEN_FAMILIES`), evicting and closing the least recently used — without that cap a
long-running server would accumulate every family that ever sent a message and eventually run out
of file descriptors. Each connection also gets a 256 KB page cache instead of SQLite's 2 MB
default, which is what took per-connection memory from ~190 KB down to ~75 KB.

The real costs aren't disk or memory, they're operational:
- **No cross-family queries.** "How many families have more than three members?" means opening
  every file. Fine for a product with no cross-family features, which Joyce deliberately is.
- **Migrations run N times.** A schema change has to loop every file, and can half-fail. Right now
  `SCHEMA` is all `CREATE TABLE IF NOT EXISTS` and runs on open, which handles additive changes;
  anything else needs a real migration runner.

**Should Marlowe switch to this?** No. The isolation benefit would be just as real, but the cost
is in a different league and the trade lands differently:
- Marlowe has genuine cross-tenant features — admin todos, API usage and spend rollups, the
  waitlist, invites, the portal's pricing tables. Every one of those becomes an N-file scan.
- It's ~211 `owner_id` references across ~20 tables and 74 store functions, plus a data migration
  that splits a live production database. That's a rewrite, not a refactor.
- Joyce can do it because she has no cross-family features and never should. That's a property of
  the product, not a cleverer choice of storage.

The right move for Marlowe stays the one in `tenant-isolation-audit.md`: a repeatable check that
every new query is scoped. Worth saying plainly though — if Marlowe were being built today, per
tenant files would deserve a serious look before committing to the shared table.

## Going live

1. Get the number and add it to the WhatsApp Business Account.
2. Set `JOYCE_WHATSAPP_PHONE_NUMBER_ID`, `JOYCE_WHATSAPP_VERIFY_TOKEN` and `JOYCE_MASTER_KEY`.
   Generate the master key fresh — it must **not** be the same value as `ENCRYPTION_KEY`, and
   losing it makes every family's data permanently unreadable, so back it up off the server.
   `server/.env.example` has the full list with instructions.
3. Route Joyce's number to `/webhooks/joyce`. Meta has **one** callback URL per app (Marlowe's
   `/webhooks/whatsapp`), so without this every message to Joyce lands on Marlowe's endpoint,
   Marlowe drops it (wrong `phone_number_id`), and Joyce never hears it. The fix is a
   *phone-number-level webhook override*, which applies to Joyce's number only:
   `POST /{JOYCE_PHONE_NUMBER_ID}` with
   `{"webhook_configuration":{"override_callback_uri":"https://<host>/webhooks/joyce","verify_token":"<JOYCE_WHATSAPP_VERIFY_TOKEN>"}}`.
   Meta checks the URL when you set it, so the Joyce env vars must already be deployed. Check
   it with `GET /{JOYCE_PHONE_NUMBER_ID}?fields=webhook_configuration`. Do **not** use the
   WABA-level override; that would move Marlowe's traffic too. (Corrected 2026-10-16: an earlier
   version of this step assumed both endpoints receive every message.) The WABA must also be
   subscribed to the app, which it already is.
4. Send one message to Marlowe and one to Joyce and confirm each is answered by the right one and
   ignored by the other.

## Which calendar a family uses

Added 2026-10-18 (`joyce/calendarMode.ts`). Joyce has two calendars: her own (above) and Google
(below). A family only ever uses one, so she never has two to choose between:

- **Google** as soon as any member has connected it. Joyce is given only the Google tools, and her
  own calendar's subscribe feed is served empty, so phones don't show a second "family calendar".
- **Joyce's own** if nobody has connected Google and the switch in the Joyce portal (Settings) is
  on. This is the default.
- **None** if nobody has connected Google and the switch is off. Joyce can only offer to connect
  Google. Used for testing Google on its own.

The model is handed only the current mode's tools, worked out afresh on every round of a turn, and
`runTool` refuses the others too (an old tool call earlier in the conversation could name one).
Nothing is deleted on a change: built-in events stay in the family's file and come back if the
switch is turned on again or everyone disconnects Google. They don't move to Google by themselves;
the connect message says so when there are any. The switch lives in Joyce's `admin.db` (`settings`
table) and applies to every family at once. Follow-ups are in
`feature-to-do/joyce-calendar-followups.md`.

## Google Calendar

Added 2026-10-17. Code in `joyce/googleCalendar.ts` (talking to Google), `joyce/calendarTools.ts`
(the model's tools), `joyce/familyCalendar.ts` (the shared family calendar) and
`joyce/googleRoutes.ts` (the connect and callback pages). The full story
is in `changelog/2026-10-17-joyce-google-calendar.md`. Points that matter for the isolation design:

- The browser that finishes Google's sign-in has no phone number, so the one-time link stands in
  for one. It's minted for a phone hash in the registry (`google_connect_tokens`), and spending it
  opens that phone's family as that member (`openFamilySessionForGoogleConnect`). That is the only
  way into a family other than an inbound message, and it still takes no family id.
- Event refs are `<account id>|<calendar id>|<event id>`. The account id is looked up in this
  family's own `google_accounts` table, so a ref from anywhere else finds nothing.
- Leaving a family deletes and revokes the leaver's Google connection.
- The family calendar is a Google calendar owned by whoever asked for it. Its id is kept
  encrypted in `family_meta`. Only the owner's account can share it, so new members are shared in
  (and leavers unshared) through the owner's tokens. If the owner leaves, the family drops it.
- New events go on the family calendar by default. Anyone can still ask for a specific person's
  own calendar, and any member can change any connected member's calendar, because that's how the
  rest of Joyce works (everyone sees everything). Joyce warns about this before anyone connects.
  If that turns out too loose, the obvious tightening is to make personal calendars read-only to
  other members, now that family events have their own place.
- Not handled yet: if the owner deletes the family calendar in Google, Joyce reports errors
  rather than offering to make a new one.
- Adding or moving a timed event reports clashes with timed events on the family calendar and
  every connected member's own calendars (all-day events aren't counted). Best effort: a calendar
  that can't be read is skipped.

## What this touched outside Joyce

- `server/src/providers/whatsapp.ts` — `extractIncomingMessages` now reads
  `metadata.phone_number_id` and takes an optional number to filter by. A payload without that
  field is still kept, so existing traffic, fixtures and the simulator are unaffected.
- `server/src/routes/whatsappRoutes.ts` — one line, passing Marlowe's own number to the above.
- `server/src/index.ts` — mounts `joyceRoutes`.
- `server/src/test/setup.ts` — sets `JOYCE_MASTER_KEY` for tests.
- `server/.env.example` — documents the new variables.
