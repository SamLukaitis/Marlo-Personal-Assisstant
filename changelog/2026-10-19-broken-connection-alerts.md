When a Gmail or Outlook connection stops working, Marlowe now says so on WhatsApp instead of acting as if the inbox were empty.

## What changed

- **One alert per breakage.** `hub.ts` already flagged an account as broken when Google or Microsoft
  rejected its token. `markAccountAuthBroken` now reports the healthy-to-broken change, and only
  then does `server/src/services/connectionAlert.ts` send one message through the attention gate
  (new category `connection_broken`: an interrupt, exempt from the 4-a-day cap, still held for quiet
  hours). Later failed polls send nothing. The event key includes the day, so a connection that
  breaks, recovers and breaks again pings at most once a day. If the user reconnects while the
  alert waits out quiet hours, it is dropped rather than sent.
- **Chat.** `buildSystemPrompt` marks a broken account "connection expired, needs reconnecting"
  and adds a rule: an empty search on a broken account must not be reported as "nothing found";
  Marlowe says it couldn't reach that mailbox and offers to reconnect.
- **Reconnect link.** `connect_email` used to refuse anyone who already had a mailbox. It now sends a
  "Reconnect Gmail/Outlook" link (`connectMailboxLink.ts`, purpose `reconnect`) when that
  provider's account is broken. The Google WhatsApp sign-in callback now treats an already-connected
  address as a reconnect, as Microsoft's already did: it refreshes the tokens, replies
  "✓ Reconnected …", and skips the new-user setup chain.
- **Briefing.** When an account is broken, the morning briefing ends with "⚠️ I couldn't read your
  *Gmail* (address) today — the connection has expired. Reply *reconnect* and I'll send you a link
  to fix it." The line is added in code after the model's text so it can't be trimmed. The model is
  also told the mailbox is missing, so it won't call the day quiet.
- **Fewer false alarms.** `isAuthError` no longer counts Gmail's rate-limit and quota 403s as a
  dead token, since a false positive now costs the user a WhatsApp message.

## Why

More family testers are about to join while the Google OAuth app is probably still in Testing mode,
where refresh tokens expire every 7 days. An audit on 2026-10-19 found a dead connection showed
only on the web Settings page. On WhatsApp, Marlowe said "no emails" or "nothing on your calendar"
and briefings went quietly empty, so it looked broken or wrong.

## Design note: "reply reconnect" instead of a link in the alert

The connect link's token lasts ten minutes. The alert may also wait out quiet hours, or go out as a
WhatsApp template outside the 24-hour window, where a link button can't be sent. So the alert and
the briefing ask the user to reply *reconnect*. That reply reopens the window, and `connect_email`
then sends a fresh link.

## Not covered

If the breakage is first discovered during a chat turn (no background poll caught it first), that
turn's reply can still say "nothing found" while the alert arrives alongside it. Background polls
run every few minutes, so this should be rare.
