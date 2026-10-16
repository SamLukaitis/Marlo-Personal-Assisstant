Business testers now get their own WhatsApp setup: Marlowe asks what their business does and invites a first receipt, and the morning-message offer is about money, not headlines.

## What changed

The setup chain that runs after someone connects their mailbox (`server/src/services/postConnectSetup.ts`)
now checks the user's edition. For business users:

1. After their name, Marlowe asks **"What does your business do?"** and saves the answer (it helps
   file receipts into the right HMRC category). *Skip* or a blank reply moves on, and the assistant
   asks again later in chat. A question back ("what can you do?") is answered first, then setup
   carries on.
2. Then: **"Send me a photo of any receipt or invoice and I'll add it to your books."** A photo is
   filed and confirmed by the assistant, and then the next question follows. Two photos sent
   together still move setup on only once. A typed message or *skip* works too.
3. The morning-message question offers **email, calendar, receipts to check, and last week's money
   on Mondays**. Saying yes no longer switches world/business headlines on for business users.
4. The Teams question (Outlook users only) and the closing message are unchanged.

General users get exactly the same setup as before. Someone switched to general halfway through
setup finishes the step they're on, and then gets the general questions.

## Why

Business testers were going through the general setup: headlines turned on, and no mention of
receipts, so the product's main feature wasn't seen until they happened to chat. The first receipt
inside setup is the moment it should click.
