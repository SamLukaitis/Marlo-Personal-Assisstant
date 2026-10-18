Swipe-replying to any of Marlowe's messages now reliably tells it which message you meant, down to the part you swiped. When it can't tell, it asks instead of guessing.

## What was wrong

Two real cases on 7 Oct 2026:

- Sam swiped a "✓ Sent." confirmation and asked why that email address was used. Marlowe said it
  couldn't see swipe replies, then made up an explanation about "the platform".
- Sam swiped an anime list (one part of a longer message) and asked "what's this". Marlowe
  explained a Google security alert instead.

Swipe-replies have worked since September through the WhatsApp message ID (wamid) of the quoted
message. Three gaps undermined that:

1. **Several send paths never saved the wamid.** Messages with buttons, the plain text sent before
   the buttons of a long question, list messages, the confirmations after a button tap ("✓ Sent.",
   "Cancelled."), help/version text, link errors and the user's own messages. A swipe on any of
   these couldn't be found.
2. **A message sent in several parts resolved to the whole message.** Marlowe got the full text
   with no idea which part was swiped, so it answered about the wrong part.
3. **When a lookup failed, the model guessed.** It was told "you can't see it, don't guess", but
   with nothing to go on it answered about whatever stood out in its context.

## What changed

- Every part of every message is now saved with its wamid and its own text
  (`whatsapp_message_wamids.part_text`, added automatically on startup). A swipe on one part tells
  Marlowe exactly that part, with the full message only as context.
- All replies go through `sendTextAndRecord`, `sendChoiceAndRecord` or `sendAssistantReply`
  (`server/src/services/whatsappReply.ts`), which send and then save the message with its
  wamid(s). `sendChoiceMessage` now returns every part it sent.
- The user's own text, media and location messages are saved with their wamids, so swiping your
  own earlier message works too.
- A "✓ Sent." (or any other button-tap confirmation) keeps a hidden note in history of what was
  actually run, e.g. the recipient and subject of the email, so "why this address?" can be
  answered.
- If a swipe still can't be resolved, Marlowe is shown its last five messages with times. It
  answers about the one that clearly fits (saying which it assumed), or asks. It's told not to
  answer about anything else on a guess or invent reasons. Each miss is logged as
  `quotedMessage: swipe-reply to an unrecorded message`, so any remaining gap shows up in the logs.
- A reply sent during onboarding's free-text steps now keeps its swipe context too.

### Every message now carries its wamid

Every send, not just the conversational ones, now saves its wamid:

- **Files Marlowe sends back** ("send me that boarding pass") are linked to the saved document in
  a new `document_sent_wamids` table. A swipe on one resolves to the document's content, as a swipe
  on a file you sent already did.
- **Scripted messages** go through `sendScriptedText` / `sendScriptedButtons` / `sendScriptedLink`
  (`whatsappReply.ts`). These cover onboarding and registration questions, connect/reconnect links,
  OAuth-callback notices, error replies and "That option has expired". **Behaviour change:** these
  now appear in chat history, so the model sees what was actually said to the user during
  onboarding. A number with no account yet has no history, so its messages are only sent. A connect
  link's history row holds the body text only, never the link, which carries a sign-in token.
- **The "One sec, working on it…" holding line** still isn't its own history row; the model
  deliberately never sees it. Its wamid is saved as the first part of the reply that follows, so a
  swipe on it resolves to the answer it was waiting on.

Messages sent before this change still have no saved wamid, so a swipe on one of them uses the
fallback above.
