The Portal's Usage tab now shows what each of Jake's and Sam's own messages to Marlowe cost, next to the message and reply.

## What changed

On 2026-10-16 WhatsApp chats cost $2.61 in a day, and the Usage tab could only say "Assistant chat,
32 calls". It couldn't say which messages they were.

Now, when an admin account (Jake and Sam) messages Marlowe on WhatsApp or the web, the first 500
characters of the message and of Marlowe's reply are saved on that call's cost row in `api_usage`
(new `user_message` / `reply_text` columns). In the Portal, Usage → Recent calls shows them under
the cost. A new "Only admins' own messages" checkbox, on by default, hides the background checks
that would otherwise fill the list.

## Privacy

- Text is only ever saved for admin accounts (`isAdmin` in `ai/assistant.ts`). Every other user's
  rows still record cost only.
- If someone stops being an admin, the Portal stops showing their saved messages too.
- Messages from before this change have no text, so the list starts empty and fills from here on.
- Anyone made a Portal admin later will also have their own messages shown this way.
