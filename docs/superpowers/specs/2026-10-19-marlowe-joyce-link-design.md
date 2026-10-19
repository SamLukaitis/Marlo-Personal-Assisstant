# Linking Marlowe and Joyce — design

Status: draft for review, 2026-10-19. Written from a brainstorm with Sam. Anything marked **(my call)**
was decided by the writer, not by Sam.

## Intent

Marlowe is one person's private assistant. Joyce is a family's shared assistant. Today they share
nothing, deliberately (see `feature-to-do/joyce-family-assistant.md`). Sam wants a person's Marlowe
to be able to contribute selected things to their family's Joyce, and Joyce to ask that person's
Marlowe narrow questions, **without** the family ever seeing anything private.

Examples Sam gave:

- Marlowe knows my flights, so the family can ask Joyce when I'm away.
- A parent tells me a builder's number or payment details. I tell Marlowe "send this to Joyce" and
  anyone in the family can ask for it later. (Payments handed over this way become shared family
  expenses, so totals and who-owes-who can be worked out.)
- Joyce asks "do these holiday dates work for everyone?" and each person's Marlowe answers from their
  private calendar.
- Forwarding things from the family group chat to Joyce so they aren't lost in a long chat.

**This document covers only the foundation:** the link between a Marlowe account and a Joyce
membership, the bridge that carries data, the sharing settings, the audit log, and one flow to prove
it ("send this to Joyce" for a note). Trip dates, availability checks, the expense ledger and
forwarded-message filing are separate, later projects that each use this bridge.

## Goals

1. A person on both products can **link** their Marlowe to their family's Joyce, by choice.
2. Data crosses only through a **small fixed set of typed operations**, never free-form queries.
3. The person can see what has been shared and **switch any of it off**, with effect immediately.
4. Joyce keeps working exactly as today for people with no Marlowe. Marlowe keeps working exactly as
   today for people with no Joyce. Both remain first-class.
5. Joyce's existing isolation guarantees (file per family, key per family, no family id in any AI
   tool) are not weakened.

## Non-goals

- No trip sharing, availability checks, expense ledger or forwarded-message handling in this project.
  The settings for trips and availability are stored and shown, but have no effect until those
  projects ship.
- No change to how Joyce stores or encrypts family data.
- No sharing between two different people's Marlowes except via Joyce.
- No change to Joyce's "everyone in the family sees everything in Joyce" model.

## Anti-goals (a failure even if it technically works)

- Any text from a user's email or Marlowe conversations reaching Joyce or other family members, other
  than what the person explicitly handed over or a category they switched on.
- Any family member reading another member's Marlowe conversation, orders or payments.
- Marlowe automatically extracting payment details from email and passing them on. Payments cross
  only when the person says so.
- A model being able to name a family or a member in any bridge call.

## Constraints

- Stack stays as is: TypeScript, Express, SQLite, WhatsApp. No new infrastructure.
- `src/joyce/` must keep importing nothing from Marlowe (enforced by the test in
  `onboarding.test.ts`). The bridge is the one new place allowed to import both sides; the test must
  be updated to name it as the sole exception, and a new test must stop it growing.
- Every proactive Marlowe message goes through `services/attention.ts` (PR #99).
- `deleteUserCompletely` must remove the new Marlowe-side tables. It has repeatedly broken on
  owner-scoped tables with foreign keys; add them and a test.
- One phone belongs to at most one family (existing database constraint). The link follows that.

## Decisions made with Sam

**Identity.** The link is made by phone number. Both products verify a number by receiving a
WhatsApp message from it. Joining or creating a family on Joyce never links anything by itself.

**Linking flow.**

1. A person creates or joins a family on Joyce with the join code.
2. The server sees the same phone number has a Marlowe account.
3. Marlowe messages that person: it has noticed they've joined a family on Joyce, and offers to
   connect. Nothing is linked until they say yes.
4. If yes, Marlowe walks through the settings, one message each with buttons.
5. If they don't answer, nothing is shared, and Marlowe asks once more a few days later, then stops.
6. If someone is already in a family when they start using Marlowe, the same offer appears at signup.

**Settings (first version).**

| Setting | Options | Default |
|---|---|---|
| Trips: share dates and destination with the family | ask each time / automatic / off | ask each time (**my call**: Sam agreed) |
| Availability: let Joyce check if I'm free for proposed dates, answered free / busy / not sure | on / off | on once linked |
| Handing things over ("send this to Joyce") | always works when the person says it | not a setting |

Changing or switching off any of these is done by telling Marlowe. Off takes effect immediately and
removes what that category had already shared.

**What may cross.** Trip dates and destination only (no booking references or prices); free/busy
answers only for proposed dates (never "what is X doing on Tuesday?"); items the person deliberately
hands over. Payments handed over become shared expenses (later project). Nothing else.

**Joyce-only users** can plan, store things and ask Joyce as before. Marlowe only makes it easier.

## Design

### The bridge

A new module, `server/src/bridge/`, is the only code that imports both Marlowe and Joyce modules.
It exposes a short, fixed list of functions, for example:

- `detectLinkableMember(phone)`: called by Joyce after create/join; tells Marlowe to make the offer.
- `linkMemberToMarlowe(ownerId, settings)` and `unlink(ownerId)`.
- `handOverNote(ownerId, title, body)`: Marlowe → Joyce.
- later: `shareTrip`, `askAvailability`, `handOverExpense`.

None takes a family id or a member id. Each resolves the family from the caller's own phone number,
the same way `openFamilySessionForPhone` does, so a model can't aim an operation at someone else.

Neither product's AI tools call the other's modules. A Marlowe tool calls a bridge function with the
person's own context; Joyce's tools, in later projects, call `askAvailability(member)` and get back
only an enum.

### Where state lives

- **Consent and settings: Marlowe side** (a table keyed by `owner_id` in `app.db`). Authority for
  "may this cross?" sits with the person's private assistant.
- **Joyce side:** a flag on the member row in the family's own encrypted file saying "this member has a
  linked Marlowe", so Joyce knows she can ask. No Marlowe data is stored there.
- **Audit log: Marlowe side**, one row per crossing: when, category, a short label (for example the
  note title), and the id of the Joyce item. Never the body. **(my call)**

### "Send this to Joyce" (the proof flow)

A Marlowe tool `send_to_family(title, body)` with no family parameter. The bridge writes a note into
the caller's family as that member, marked "from Marlowe", with a provenance link so it can be removed
later. Marlowe replies with a confirmation. The tool is only available on turns where the person
themselves has asked in chat; it is not offered while processing email or other background content
**(my call, prompt-injection defence)**.

### Switching off and leaving

- Switching a category off, or unlinking, stops further crossings immediately.
- Unlinking asks: "Also remove what I shared?" Remove means the items the bridge wrote for that
  person. **(my call: Sam agreed removal on off, but a handed-over note like a builder's number may be
  one the family relies on, so ask rather than delete silently.)**
- Leaving the family on Joyce unlinks automatically.
- Deleting a Marlowe account removes the link, the settings and the log.

### Testing

- Boundary test: only `src/bridge/` imports across the products; the bridge's exported function list
  matches an allow-list.
- No Marlowe or Joyce AI tool has a family id or member id parameter.
- Linking: no data crosses before consent; declining or ignoring shares nothing.
- Handover: lands in the right family only; a second family sees nothing; body never appears in the
  audit log; removal on unlink works.
- Off means off: no crossing after a category is switched off.
- Phone in no family, or no Marlowe account: the detection path does nothing.
- `deleteUserCompletely` leaves no link rows.

### Docs to update when built

`README.md` (what Marlowe and Joyce can do), a `changelog/` entry, and the `feature-to-do/` entries
for the later projects (trips, availability, expense ledger, forwarded messages).

## Calls added after the builder check (all my call)

- **Phone matching must not trust an unverified number.** Marlowe's Settings page
  (`routes/whatsappSettingsRoutes.ts`) can attach a phone number to an account after only a format
  check, so "has a Marlowe account on this phone" is not proof the phone belongs to that person.
  Rule: a link is only offered, and only changed, over WhatsApp, from the number itself. The offer is
  made only if that number has sent Marlowe at least one inbound WhatsApp message (proof the holder
  uses it). Linking, settings changes, unlinking and `send_to_family` are never available from the web
  portal. Any phone on the account counts; the link is keyed to the owner and the specific phone that
  consented.
- **One-to-one.** One owner links one phone to one family member. If an owner has several phones, only
  the one that consented is linked. A second phone in a different family needs its own consent.
- **A handed-over note is a row in Joyce's `notes` table**, authored by the member, with a new
  `source` column ("marlowe") added additively on open. The existing provenance mechanism
  (`provenance.ts`) links it to the handover so unlinking can remove it. Joyce's delete and leave
  flows are unchanged.
- **Scope of settings in this project:** the full button walkthrough and storage for trips and
  availability are built, since the link flow needs them. They stay inert until those projects ship.
  Removal on switch-off is built for handed-over notes only.
- **User-initiated turns:** `send_to_family` is offered only when the turn started from an inbound
  WhatsApp message from the person. If Marlowe's tool layer doesn't already distinguish that from
  email or background processing, the plan starts with a per-turn tool filter and a test.
- **No circular import:** Joyce's onboarding exposes a hook (`onFamilyJoined`) that the bridge
  registers at server start. Joyce still imports nothing from Marlowe or the bridge.
- **Follow-up nudge:** goes through the attention gate like any proactive message. After the second
  unanswered ask it stops. The person can ask Marlowe to link at any time, and can re-link after
  unlinking.

## Left to the builder

Table and column names, the exact wording of Marlowe's messages, how buttons are rendered, whether the
"ask again in a few days" nudge reuses an existing scheduler, and how the bridge is exposed to
Marlowe's tool layer.

## Later projects, in the order they'd probably go

1. Trip dates to Joyce (ask each time first, then automatic).
2. Availability checks for proposed dates.
3. Shared expenses and who-owes-who (handover of payments).
4. Forwarded group-chat messages filed into Joyce.
