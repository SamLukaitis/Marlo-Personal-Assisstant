Marlowe now texts when you say "message", sends WhatsApp messages, adds calendar events to your iPhone when no calendar is connected, and sends phone actions as a "Run on iPhone" button.

## What changed

- **Choosing the channel.** "Message" or "text" someone now goes to a phone text step. Before, Marlowe often drafted an email for users with a mailbox connected. Email is used only when you say email or give an address. "Remind me…" is still Marlowe's own WhatsApp reminder; the iPhone Reminders app is used only when you mention it.
- **WhatsApp messages.** `make_app_link` has a new `whatsapp` option. It builds a `https://wa.me/<number>?text=…` link that opens the chat with the message already typed, and you just tap Send. It needs no Shortcut. The number has to be in full international form; without one, WhatsApp asks you to pick the contact.
- **Calendar without an account.** With no Google or Microsoft calendar connected, a calendar event goes on the iPhone through a `calendar_event` step, instead of Marlowe asking you to connect an account.
- **Run on iPhone button.** A WhatsApp reply with exactly one phone-action link is sent as a button labelled "Run on iPhone" (`server/src/services/phoneActionButton.ts`). History keeps the full text. If the button can't be sent, the reply goes out as plain text.
- **No delay on the landing page.** `/a/<code>` now jumps to Shortcuts straight away instead of after 300 ms.

## Why

These came from the first test on a phone. "Message mum" drafted an email, "send a WhatsApp" was refused, and a calendar request was refused for a user with no calendar connected. Each phone action also took about 3–4 taps. iOS always asks "Open in Shortcuts?" when anything outside Shortcuts starts a Shortcut, so 2 taps (the button, then Open) is the minimum for Shortcut actions. WhatsApp messages now take 1.
