# Teams chat — make it actually work (or take it out)

Parked 2026-09-26 while the rest of Outlook was brought up to par with Gmail. Teams was
deliberately left alone, so this is what's known about where it stands.

## What exists today

Marlowe can list and search Microsoft Teams chats (`list_recent_chats` / `search_chats` in
`server/src/ai/assistant.ts`, backed by `microsoftListChats` / `microsoftSearchChats` in
`server/src/providers/microsoft.ts`). It's switched on per user as the `teams` tool. It has never
been tested with real users.

## Known problems

1. **Personal Outlook/Hotmail accounts don't have Teams chat at all.** Microsoft only offers chat
   access for work/school accounts. Most of our Outlook users will be personal accounts, so for
   them the feature can never work.

2. **It might stop personal accounts connecting at all — needs checking first.** Every Outlook
   sign-in asks Microsoft for chat permission (`Chat.Read` in the `SCOPES` list in `microsoft.ts`).
   Because personal accounts don't have that permission, Microsoft may reject the whole sign-in,
   not just the chat part. Test by connecting a personal @outlook.com / @hotmail.com account. If it
   fails, the fastest fix is to stop asking for `Chat.Read` (and turn off the Teams tool) until
   this is worked on properly.

3. **A failure used to flag the whole mailbox as broken.** Fixed 2026-09-26: a chat error no longer
   tells the user to reconnect their mailbox (`hubListChats` / `hubSearchChats` in
   `server/src/services/hub.ts`). Chat errors are now just logged.

4. **Search results have no link or real topic.** `microsoftSearchChats` labels every hit "Teams
   chat" and gives no link to open it.

## What "done" would look like

- Only ask for chat permission from work/school accounts (or ask for it later, when someone
  actually turns the Teams tool on), so personal accounts never see it.
- Hide the Teams tool from people whose account can't have it, instead of it quietly returning
  nothing.
- Decide whether Teams belongs in the morning briefing / alerts, or stays something you ask for.
- Test end to end with a real work account.
