# Forward an email, with its attachments

A user asked Marlo to forward a booking confirmation to someone (unmet request, 11 Nov 2026). Marlo
can write a new email or a reply, but it can't forward an existing one, and it can't attach a file
from an email to a new message.

## What's needed

- A `forward_email` tool: takes an account, a message id, a recipient and an optional note, and
  sends the original with its attachments. Gmail has no forward call, so this means fetching the
  raw message and building a new one; Microsoft Graph has `createForward`.
- It should go through the same confirm step as `send_email` (show who it's going to and what's
  attached, send only on a tap), since it can't be undone.
- `send_email` already takes one attachment in code (`hubSendMessage`), used for Xero forwarding.
  The assistant's tool doesn't expose it. Exposing it for documents the user has saved ("email my
  passport scan to the letting agent") is a smaller first step.

## Things to watch

- Size limits: Gmail rejects messages over 25 MB.
- An account with sending switched off in Settings must refuse, as `send_email` does.
- Outlook accounts connected before `Mail.Send` was requested need the reconnect prompt.
