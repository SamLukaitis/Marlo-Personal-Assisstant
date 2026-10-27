# Email watches: follow-ups

Email watches ("keep an eye out for Jazz Fest ticket emails") shipped on 2026-10-27; see
`changelog/2026-10-27-email-watches.md`. These are the rough edges left for later:

- **A failed check can lose a match when alerts are off.** With email alerts switched off, Marlo
  still checks new mail from people for watched topics. If that one check fails (say the AI service
  has an outage), those emails are marked as handled, and a match among them is never sent. When
  alerts are on, a failed check alerts on everything, so nothing is lost. The fix is to try again on
  the next check instead of marking them handled.
- **Watches in Settings.** Watches can only be seen and removed in chat. If people end up with
  several, a list in Settings next to the mutes (`email-alert-mutes-settings-ui.md`) would help.
- **Watches that end on a date.** Some watches have a natural end, like "until the festival on
  1 May". Marlo could end those itself instead of waiting for the every-third-alert check-in.
