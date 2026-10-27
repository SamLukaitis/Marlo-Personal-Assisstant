Marlo can now keep watching your email for a topic you name, and flags matching emails as they arrive.

**Why:** a user asked Marlo to keep watching her inbox for New Orleans Jazz Fest ticket sale
announcements. Marlo could only search when asked; it couldn't watch in the background.

**What changed:**
- **Setting up a watch:** in chat, say something like "keep an eye out for Jazz Fest ticket emails".
  Marlo saves a watch: a short label plus a plain-English description of what counts
  (`server/src/services/emailWatches.ts`). It also runs one ordinary search, for anything that
  arrived before the watch was set up.
- **Matching:**
  - Matching goes by meaning, not keywords. Active watches are added to the model calls that
    already read new mail, so no extra call is made per check for users with alerts on.
    - Automated mail goes through `importantEmailClassifier.ts`.
    - Mail from people goes through `realPersonTriage.ts`.
  - A match beats the "this is marketing, skip it" rules, because a ticket presale announcement is
    exactly that kind of email.
  - A matching email from a person skips digest mode and pings at once.
- **The alert:**
  - It reads `👀 *Jazz Fest tickets*: <one-line summary>`.
  - It's sent through the attention gate as `watch_match`, which always interrupts and isn't
    limited by the daily cap of 4. Quiet hours still apply, so a match at 2am arrives in the
    morning.
  - Mutes still win: a muted sender stays quiet even when their email matches a watch.
- **Works with alerts switched off:** if the user has switched email alerts off, the scheduler still
  runs the scans for anyone with at least one watch. In this "watch-only" mode it sends only watch
  matches, and nothing goes into the digest.
- **Ending a watch:**
  - The user says to stop.
  - The user implies it's done ("got the tickets!"). Active watches are listed in the system
    prompt so Marlo can notice this. It removes the watch and says so in one line.
  - Every third alert from the same watch asks "Still want me flagging … emails?". No removes the
    watch; yes resets the count. No answer means the watch carries on.
- **Chat tool:** `watch_emails`, with actions add / remove / keep / list. There is no Settings
  screen; watches are managed in chat only.

Design: `docs/superpowers/specs/2026-10-27-email-watches-design.md`.
