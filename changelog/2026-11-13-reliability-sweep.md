The scheduler can no longer freeze, calendar events land at the time the user said, and Marlo's memory stops contradicting itself.

A sweep before opening Marlo to more people, starting from three reports: the logs repeating
"previous tick still running", calendar adds failing, and Marlo "correcting itself when it was right".

## The scheduler froze for 15 hours

At 00:39 UTC on 13 Nov one scheduler tick started and never finished. The scheduler refuses to
start a new tick while one is running, so every 5-minute cycle after it was skipped: no briefings,
email alerts, digests or reminders for anyone, until the next deploy restarted the process.

The logs don't say which call hung, because nothing logged per step. The most likely cause is a
Google API call on a stalled connection: the Google client has no request timeout by default, so it
waits forever. Whatever it was, three things now stop it happening again:

- **Every step has a deadline** (`scheduler.ts`, `STEP_DEADLINE_MS`, 3 minutes per user per step).
  A step that runs past it is abandoned and logged by name (`scheduler: alerts check for user 5
  timed out after 180s — moving on`), and the tick carries on. That step is not started again for
  that user while the abandoned call is still pending (up to 30 minutes). A step slower than 30s
  logs a warning, so the next slow call can be identified from the logs.
- **Google calls time out after 30s**, including the token refresh (`providers/google.ts`,
  `joyce/googleCalendar.ts`).
- **Every plain `fetch()` times out after 60s** unless the caller set its own signal
  (`services/fetchTimeout.ts`, installed in `index.ts`). This covers WhatsApp, Microsoft Graph,
  weather and geocoding.

## Logs drowned by one dead Gmail token

One user's Gmail connection had expired ("Token has been expired or revoked"). The background scans
retried it every 5 minutes and logged Google's whole request dump each time, about 85 lines. That
pushed everything else out of Railway's log window and the Portal's Logs tab.

- A failed provider call now logs one line, naming the account and user
  (`hub: provider call failed (account 12, google, user 5): invalid_grant (Token has been expired
  or revoked.) [400]`). An error with no HTTP status, which is a bug or a network failure rather
  than a refusal, keeps its stack.
- A mailbox already flagged as expired is skipped by the background scans and looked at again every
  6 hours. Chat lookups still try every time. The user was already told to reconnect when it first
  broke; nothing about that changes.

## Calendar events

`create_calendar_event` told the model to convert the user's local time to UTC itself. It often
passed the plain clock time instead ("2026-11-14T15:00:00"), which Google rejects ("Missing time
zone definition") and Outlook silently reads as UTC, or it converted with the wrong offset.

The model now passes the clock time the user said and the server applies the user's timezone
(`services/calendarTime.ts`), the same split reminders already use. Also:

- A plain date makes an all-day event; a range of dates makes a multi-day one. Google and Outlook
  both support this now.
- A missing end defaults to one hour after the start.
- A time that can't be placed (end before start, an unknown timezone name, "tomorrow at 3") is
  refused with a reason the model can act on, instead of being sent to the calendar.
- The result includes `saved_as`, the saved time on the user's own clock, so the time Marlo
  confirms is the time that was saved.

Not changed: a user's timezone still comes from Settings, a shared location, a travel check-in, or
a guess from their phone number (`feature-to-do/timezone-handling.md`). If that is wrong, the event
is an hour or more out; the confirmation names the timezone so it can be noticed.

## Memory

Four separate causes of Marlo holding stale or conflicting information:

- **Facts had no age.** An old fact and a newer one that disagreed ("lives in Leeds", "moved to
  London") were shown side by side with nothing to choose between them. Every remembered fact is
  now shown with the date it was noted, and the prompt says the newer one is current and that what
  the user says now beats both.
- **The same fact was saved twice.** The `remember` tool saves it during the chat, then background
  extraction reads the same messages and saves it again. A later correction retired one copy and
  left the other. `addFact` now returns the fact already held when the sentence is the same
  (ignoring case, spacing and trailing punctuation).
- **Corrections left the old fact active.** `remember` now returns related facts already held and
  tells the model to forget any that the new one contradicts. The extraction prompt is firmer about
  using `supersedes_id`, and messages are dated so facts aren't recorded as "tomorrow".
- **The rolling conversation summary went stale.** It was undated, kept wrong answers the user had
  already corrected, and was read back as fact on every later message. The summary prompt now dates
  anything time-bound, keeps only the corrected version, and lets a new batch overwrite the old
  summary. The system prompt says the summary may be out of date. Existing summaries improve as
  they are next rewritten (every 8 messages).

Two more changes aimed at "corrects itself when it was right":

- User messages reach the model with the time they were sent (`[Tue 10 Nov 2026, 12:47]`), in the
  user's timezone. Before, a message from three days ago read the same as one from a minute ago.
  Assistant messages are not stamped, so Marlo doesn't start writing timestamps.
- A new rule: don't take back an answer without a reason (a tool result that differs, or the user
  saying it's wrong). "Are you sure?" means check again, not reverse.

## From the unmet-requests list

- **"Remove the give-me-a-moment filler"** (Sam, 26 Oct). The holding line is off by default.
  A slow reply keeps WhatsApp's typing dots alive instead. `WHATSAPP_HOLDING_TEXT=on` brings the
  line back.
- **"Plan before acting; the missed J&J assessment email"** (Sam, 26 Oct). A new rule: for a broad
  request, work out what a full answer needs and run every lookup before replying; for a sweep of
  mail on a theme, list recent mail and run several searches; open an email before stating a time
  from it. "What have I missed"-style messages now go to the stronger model.
- **Train times, car hire prices** (5 and 10 Nov). Marlo declined because it has no dedicated tool.
  It now uses web search for live information it has no specific tool for, and gives the source.
- **Forwarding an email with its attachment, and voice notes** are not built. See
  `feature-to-do/forward-email-with-attachments.md` and `feature-to-do/voice-note-transcription.md`.

## Smaller fixes

- When a request used up all 8 tool rounds, Marlo replied "I wasn't able to finish that within my
  tool-call limit" and threw away what it had found. It now gives an answer from what it found and
  says what it couldn't finish.
- Three error messages told users to "check the server logs". They now say something went wrong and
  to try again.

## Not verified

- These changes are covered by unit tests, not by a run against real Gmail, Outlook or WhatsApp.
- The memory changes stop new duplicates and conflicts. Facts already stored that contradict each
  other are still there: run `npm run memory:audit -- PHONE` per account to review them.
- Which call hung on 13 Nov is an inference from the code, not something the logs show.
