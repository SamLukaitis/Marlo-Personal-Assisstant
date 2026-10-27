# Email watches: "keep an eye out for X" — design

## Why

Nat asked Marlo to keep watching her email for New Orleans Jazz Fest ticket sale announcements.
Marlo could only search when she asked; it had no way to watch the inbox for a topic she named. She
wants to be flagged when an email about it arrives, the same way Marlo already flags important
mail.

Marlo already has the two halves of this:
- **Important-email alerts** (`server/src/services/importantEmailAlerts.ts`). Every 5-minute tick, new automated mail
  goes to a Haiku classifier (`importantEmailClassifier.ts`) against a fixed category list (flight
  change, invoice due…). Matches go to the attention gate (`attention.ts`).
- **Mutes** (`emailAlertSettings.ts`, the `mute_email_alerts` chat tool): a user-defined list of
  things *never* to hear about.

A **watch** is the opposite of a mute: a user-defined topic Marlo should *always* flag.

## Goals

- In chat, the user can say "keep an eye out for Jazz Fest ticket emails" (or similar), and Marlo
  saves a watch.
- When new mail about a watched topic arrives, the user gets pinged straight away, the same way
  important-email alerts work.
- Matching goes **by meaning, not keywords**. "Jazz Fest 2027 presale starts Friday" from a
  ticketing site matches a watch on "New Orleans Jazz Fest ticket sales" even though the words
  "New Orleans" never appear.
- A watch ends when the user says so, or **implies its purpose is done** ("got the tickets!",
  "we're not going anymore").
- Fallback for watches that never get closed: the **3rd** ping from a watch carries a check-in,
  "Still want me flagging Jazz Fest emails?"

## Non-goals

- No Settings-page UI. Users manage watches in chat only (user's decision).
- No backfill of mail that arrived before the watch was created (see "Builder's calls").
- No new delivery channel. Watches use the existing attention gate and WhatsApp delivery.

## Anti-goals (failures even if it technically works)

- **A watch ending silently.** When Marlo ends a watch because the user implied it's done, it
  always says so in one line ("I'll stop watching for Jazz Fest emails").
- **Dropping a watch because the user ignored the check-in.** If the check-in gets no answer,
  Marlo keeps flagging.
- **Overriding a mute.** If a muted sender or subject also matches a watch, the mute wins and
  nothing is sent.
- **Pinging twice for one email** because it matched both a fixed category and a watch.

## Behaviour (decided with the user)

### Creating a watch
The assistant gets a new chat tool, shaped like `mute_email_alerts`. A natural name is
`watch_emails`, with actions `add` / `remove` / `list` / `keep`. On `add` it stores a short
plain-English description of the topic, written by the assistant from what the user said (e.g.
"New Orleans Jazz Fest ticket sales or presale announcements"), plus a short label to show in
alerts (e.g. "Jazz Fest tickets"). Marlo confirms in one line.

### Matching
Watches apply to **all new mail**, both automated and from real people:
- **Automated mail:** pass the user's active watches into the important-email classifier's prompt
  as extra, user-specific categories. Then one Haiku call does both jobs, as it does today.
- **Real-person mail** (`alerts.ts`): pass the watches into the existing triage call
  (`realPersonTriage.ts`). A real-person email that matches a watch is sent instantly through the
  attention gate, **even in digest mode**: the user asked to be told about this topic. The email
  is marked handled so it doesn't *also* show up in the digest.

**Watches work whatever the user's alert switches say** (user's decision). `scheduler.ts` skips the
people-mail check when `realPersonAlertsEnabled` is off and the automated-mail check when
`importantEmailAlertsEnabled` is off. Both checks must now still run whenever the owner has at
least one active watch, in a **watch-only mode**:
- send only watch matches, nothing else;
- still mark non-matches as handled;
- never add anything to the digest queue (`emailDigest.ts` clears that queue when people alerts
  are off).

This deliberately adds model calls per tick for users who have alerts off but at least one watch
on. That cost was accepted.

Mutes are applied before either model call, as they are today, so muted mail never reaches
watch-matching.

When an email matches both a fixed category and a watch, it goes out once, as a **watch alert**
(the user asked for this topic explicitly).

### The alert
- New attention category, e.g. `watch_match`. It is tier `interrupt`, and **exempt from the daily
  cap** (the user asked for every one). It is **not** exempt from quiet hours, so a 2am ticket
  email arrives at 7am.
- Text: emoji + watch label + the model's one-sentence summary, e.g.
  `👀 *Jazz Fest tickets*: Presale for Jazz Fest 2027 opens *Friday 10am* on *Ticketmaster*.`
  Same WhatsApp-bold convention as `importantEmailClassifier.ts`.
- Saved as a flagged email entity (as `saveFlaggedEmail` does), so `list_flagged_emails` can
  answer "what was that Jazz Fest email?" later.

### Ending a watch
1. **The user says so:** `remove`.
2. **The user implies it's done:** the assistant must know the active watches on every turn, so
   it can notice "got my Jazz Fest tickets!". This needs a short line in the system prompt listing
   active watch labels. When it recognises the purpose is done, it removes the watch straight away
   (no confirmation question) and tells the user in one line.
3. **Check-in fallback:** each watch keeps a count of alerts sent since it was created or last
   reset. The 3rd alert has the check-in question added to the same message: "Still want me
   flagging Jazz Fest emails?"
   - Answer "no": `remove`.
   - Answer "yes": `keep`, which resets the count to 0, so the next check-in comes 3 alerts later.
   - No answer: the watch stays and keeps flagging, and the count keeps rising. The check-in is
     asked again on the 6th, 9th… alert (every 3rd alert since the last reset).

## Constraints

- Follow existing patterns: store watches in a per-owner setting holding JSON, like
  `email_alert_mutes`, with a sensible cap (≈20 watches, label/description length-limited and
  cleaned like `cleanPart`).
- No extra paid model calls per tick for users whose alerts are on. Watches ride along on the classifier call and triage call
  that already happen.
- The deliverability gates in `checkForImportantEmails` (WhatsApp configured, phone registered)
  apply unchanged.
- Docs per `CLAUDE.md`: README (new capability), a `changelog/2026-10-27-email-watches.md`, and a
  `feature-to-do/` entry if a related idea comes up.

## Builder's calls (made by me, not discussed with the user)

- **No backfill.** A watch only applies to mail arriving after it's created. When adding a watch,
  the assistant may also run its normal `search_messages` in the same turn and mention any recent
  hit, which reuses an existing tool.
- **Watch matches on real-person mail skip digest mode.** This is my reading of "flag me when
  anything comes through".
- **A watch match beats every "skip" decision.** Triage in `realPersonTriage.ts` drops some emails
  as `not_personal` or `duplicate`, and the classifier's prompt skips "promotional" mail. A ticket
  presale announcement is exactly the kind of mail those rules drop. So the triage output gets a
  separate watch-match field that is read *before* any skip is applied, and both prompts say the
  skip rules don't apply to watched topics.
- **Count at submission.** The check-in count goes up when the alert is handed to the attention
  gate, not when it's actually delivered. This is simpler, and a held alert still counts.
- **No onboarding scan involvement.** A brand-new user has no watches.
- **Left to the builder:** storage shape and ids, the exact prompt wording for the extra
  categories, emoji, tool naming and descriptions, how `classifyImportantEmails` returns a watch
  match (e.g. `category: "watch:<id>"`), and the event-key/dedupe details in the attention gate.
