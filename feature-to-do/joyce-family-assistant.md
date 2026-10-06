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
- **Passing messages between members**: "tell mum I'll be late Friday" is left for Priya and
  delivered the next time she messages.
- **Reminders**, for one member or the whole family.
- **Refusing to reach outside the family**, in her own words and without being asked to.
- One phone can only ever be in one family — enforced by a database primary key, not by code
  remembering to check.
- **Leaving a family**, with a two-step confirmation (see below).

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

1. **Timezones.** Store one per family (ask during onboarding, or guess from the phone's country
   code) and convert reminder times. Reminders are close to useless until this exists.
2. **Reminders actually arriving.** Right now a reminder is delivered the next time that person
   messages Joyce, and she's honest about that. Real delivery needs a scheduler like Marlowe's,
   plus WhatsApp message templates — outside the 24-hour window since a user's last message,
   Meta only allows pre-approved templates, which have to be submitted and approved.
3. **Documents and photos.** The storage table and the search tool are built and wired up, but
   nothing ingests a WhatsApp media message into them yet. Marlowe's `services/documents.ts` is
   the model to copy — carefully, since it writes to Marlowe's store.
4. **Expiring or single-use join codes**, if permanent shareable codes feel too loose once real
   people use them.
6. **Deleting a family**, for the same reasons Marlowe has `deleteUserCompletely`. With one file
   per family this is genuinely easy — delete the file, delete the registry rows.
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
3. Point the webhook at `/webhooks/joyce` and subscribe it to messages. Note the WABA
   webhook-subscription gotcha that bit us with Marlowe: subscribing the *app* is not the same as
   subscribing the *WhatsApp Business Account*, and both are needed.
4. Send one message to Marlowe and one to Joyce and confirm each is answered by the right one and
   ignored by the other.

## What this touched outside Joyce

- `server/src/providers/whatsapp.ts` — `extractIncomingMessages` now reads
  `metadata.phone_number_id` and takes an optional number to filter by. A payload without that
  field is still kept, so existing traffic, fixtures and the simulator are unaffected.
- `server/src/routes/whatsappRoutes.ts` — one line, passing Marlowe's own number to the above.
- `server/src/index.ts` — mounts `joyceRoutes`.
- `server/src/test/setup.ts` — sets `JOYCE_MASTER_KEY` for tests.
- `server/.env.example` — documents the new variables.
