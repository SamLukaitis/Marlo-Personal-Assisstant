A family member can now delete something they sent to Joyce, within 24 hours, and Joyce removes it and everything she made from it.

The case this is for: someone sends Joyce something incorrect or personal (a PIN, the wrong
letter), then swipe-replies to it with "delete this". Joyce lists exactly what will be removed —
the message, any file it carried, and the notes, calendar events, reminders and replies she made
from it — with Delete and Keep buttons. Delete removes all of it, including the "delete this"
request itself, so nothing points back at what was there.

To make that possible, Joyce now records which message everything she keeps was made from. Only
direct links: what she made in her reply to that message. So a trip event made from a letter goes
when the letter is deleted, but a packing note someone asked for later, in a different
conversation, stays — a delete never sweeps up something unrelated.

Rules:
- Only the person who sent it, or the family admin (whoever started the family), can delete it.
  The admin can delete someone else's message by describing it ("delete what Sam said about the
  gym login").
- Only within 24 hours of it being sent, for everyone. Older messages may have had a lot built
  on them, so they need a developer: `npm run joyce:delete -- <member's phone> "<words>"`, then
  `--id <n>` to preview and `--confirm` to delete.
- It removes it from Joyce's memory only. WhatsApp doesn't let a business delete messages from
  people's phones.
- Where things came from is recorded from now on; deleting an older message removes only that
  message.

Tested against the real model: deleting a saved PIN by swipe-reply, deleting a trip letter (which
also removed the event and note Joyce made from it, her reply, and the file on disk), a non-admin
being refused, and the admin deleting another member's message.
