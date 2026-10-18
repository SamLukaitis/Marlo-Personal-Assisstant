Marlowe no longer sends phone-action links it made up itself. After a failed run it now offers a fresh, working link.

## What changed

- Every phone-action link in a reply is checked before it's sent. Each must be a real code that hasn't been used. A link the model typed itself, or an old link it reused, is replaced with "(that link isn't valid — ask me again for a fresh one)" (`scrubUnknownActionLinks` in `server/src/services/phoneActions.ts`, called from `runAssistantChat`'s `finish`).
- The "known problems" line in Marlowe's instructions used to say "don't repeat these". It now says to mention the earlier failure and still call `make_phone_action`. It also says never to write or reuse a link.

## Why

On the first production test, one alarm run failed. Marlowe was told not to repeat it, so it stopped calling the tool. Instead it typed links that looked like the earlier ones and said "Alarm set". Those codes never existed, so every tap showed "This link has expired or was already used".
