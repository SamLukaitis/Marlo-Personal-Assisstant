# Stop Marlowe typing numbered lists instead of sending buttons

Seen 2026-10-16 while reviewing business-edition receipts: after "Personal", Marlowe replied
"Got it, logged as personal. Two more:" then **typed** "TfL £10.50 on 28 Aug — business or
personal? 1. Business 2. Personal" as plain text, with no buttons. When asked why, the next one
came back as real buttons.

## Why it happens

1. A button message is saved in chat history as the question **plus a typed numbered list**
   (`buildChoiceReply` in `server/src/ai/assistant.ts`, recorded by `sendChoiceAndRecord` in
   `server/src/services/whatsappReply.ts`). The model never sees buttons, only that text, so a
   typed numbered list looks like how it always asks.
2. `ask_user_choice` must be the only thing in its turn and shows only the question, so a lead-in
   like "Got it, logged as personal" gets dropped. To say both, the model typed everything.
3. A typed list has no pending choice behind it, so replying "2" only works if the model happens
   to read it right.

## Fix (affects all users)

1. Save button messages in history as `question (sent with buttons: Business / Personal)`
   instead of a typed list. The `whatsappReply.test.ts` case that pins the old history text needs
   updating.
2. Let `ask_user_choice` carry one short lead-in line, sent just before the buttons.
3. Add a rule: never type a numbered list of options; use `ask_user_choice`.

Each one starts with a test that reproduces the problem.
