Email alerts stop flagging your own drafts, can be muted per sender, and the evening digest skips what you've already dealt with in chat; "help" now links to the features page.

Five fixes from live use on 2026-10-19:

1. **"help" links to the features page.** The help reply was a hand-kept list of five things that had
   fallen well behind what Marlowe does. It now sends `${SERVER_URL}/features` (the public
   `FeaturesPage`), which is kept current. `server/src/services/whatsappRegistration.ts`.

2. **Mute one sender or kind of email.** Before, the only choices were "important alerts on/off" and
   "people alerts on/off", so "don't tell me about Railway crash emails" couldn't be honoured. New
   `mute_email_alerts` assistant tool (add / remove / list). A mute matches on the sender (name or
   address), the subject, or both. Applied to real-person alerts (`alerts.ts`), important automated
   mail (`importantEmailAlerts.ts`, before the paid classifier call) and the digest queue. Stored as
   JSON in the `email_alert_mutes` setting (`emailAlertSettings.ts`). The mail itself is left alone.

3. **Your own drafts and sent replies are no longer "new mail".** Gmail's `history.list` with
   `labelId: INBOX` still lists the user's own drafts (a new id on every autosave while typing a reply)
   and sent replies on inbox threads. Those reached the scanners and came back as "needs a reply"
   alerts about something the user had just written. `googleListNewMessages` now keeps only messages
   labelled `INBOX` and not `DRAFT`/`SENT`, and `hub.ts` drops any new message whose From is the
   mailbox's own address, whatever the provider.

4. **No more made-up message ids.** Asked which email an alert was about, the assistant named two
   message ids that didn't exist. `get_message` on an unknown id used to return a bare `null`; it now
   returns an error that says ids must be copied from a tool result. A new system-prompt rule says
   never to name an email's id or details from memory: find it, fetch it, then answer.

5. **The digest skips what you've already handled in chat.** It re-raised a thread the user had gone
   through with Marlowe an hour earlier, because the queue only knew what had arrived. Now: opening
   an email with `get_message`, or replying with `send_email`, takes that thread (same sender, same
   subject ignoring Re:/Fwd:) off the queue (`dropFromEmailDigest`). The digest model is also given
   the last day's chat (capped at about 6,000 characters) and told to leave out anything the
   conversation shows is sorted, such as "I've already called Steven about that". The plain fallback
   digest only gets the first of these.

Not done: there's no Settings page UI for mutes yet; they're chat-only.
