"Tell Ella I'll be late" now reaches Ella straight away instead of waiting until she next messages Joyce, and once Meta approves a new message template, it works even if she hasn't messaged Joyce for days.

## What changed

When someone asked Joyce to pass a message to another family member, Joyce always stored it and
handed it over the next time that person messaged her, even if they'd been chatting with her a
few minutes earlier. Joyce said "I've left it for Ella", which was accurate but not what people
expected.

Now Joyce sends it straight away and tells the sender it's been sent:

- If the recipient has messaged Joyce in the last 24 hours, it's an ordinary message: "Jake asked
  me to pass this on: …".
- If they haven't, it goes as a WhatsApp template (`joyce_family_message`): "Hi Ella, you have a
  new message from Jake in your family group: "…" Reply here if you'd like me to pass anything back."
- If neither can be sent (for example, before Meta approves the template), it works as before:
  it waits for their next message, and Joyce tells the sender so.

## Why a template

WhatsApp only lets a business message someone freely within 24 hours of that person's last
message. Outside that window, only a message template that Meta has approved in advance gets
through. The template was submitted on 2026-10-18 as UTILITY (the cheaper category, for
notifications rather than promotion). It's worded as a notification of a new message in the
person's own family group, with fixed text around the message, because Meta tends to reclassify
or reject templates that are mostly one free-text variable or that read as promotional. Check
its status with `npm run joyce:templates -- 1574262347469069` in `server/`.

## Details

- A message is only marked as delivered once WhatsApp accepts it. If the send fails, it waits for
  the recipient's next message instead of being lost, and it's never delivered twice.
- The sent message is kept in the recipient's own conversation with Joyce, so if they reply to it
  ("tell him OK"), Joyce knows what they're replying to.
- If Joyce's clock says the 24-hour window is open but WhatsApp says it has closed, she falls back
  to the template.
- Code: `server/src/joyce/relayDelivery.ts`, used by the `pass_message` tool in `assistant.ts`.
  The template is defined in `joyce/whatsapp.ts` and submitted by
  `server/src/scripts/createJoyceTemplates.ts`.
