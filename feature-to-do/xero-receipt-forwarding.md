# Forward receipts to Xero

Right now Marlowe will digest a receipt, store it, and create the relevant events and entities
from it — it tracks your spending. It doesn't do anything with Xero yet.

The idea: give Marlowe your Xero forwarding email address and have it forward receipts there
automatically, so they land in Xero without you doing anything extra. That's the right end state
— it's how Xero's own email-in feature is meant to be used — but it's a bit more than flipping a
switch. Here's what's actually involved, in plain terms:

1. **Give Marlowe the ability to actually send an email. ✅ Done (2026-08-25).** Built as internal
   plumbing only (`googleSendMessage` in `server/src/providers/google.ts`, dispatched via
   `hubSendMessage` in `server/src/services/hub.ts`) — Gmail accounts can send now, using the
   permission you already granted (no reconnect needed).

   **Locked down on purpose:** this is *not* a general "send any email" tool the AI assistant can
   call from chat. It's never wired up that way, and it never will be for this feature — the only
   thing allowed to trigger a send is the specific, hardcoded "forward this receipt to your stored
   Xero address" action from step 3. The recipient address always comes from what's saved on your
   account, never from something typed into a conversation, so there's no scenario (including
   someone trying to trick Marlowe in chat) where it sends anywhere other than your one Xero
   address. This directly answers the "only Xero, not runaway email access" concern.

2. **Give Marlowe the ability to send from Outlook/Microsoft too.** Not done — Outlook accounts
   were only ever given permission to *read* email, not send, so a Microsoft-connected user can't
   use this yet. Needs one extra permission added and a one-time reconnect. Not urgent while usage
   is Gmail-only.

3. **Somewhere to store your Xero forwarding address. ✅ Done (2026-08-25).** Ask Marlowe to
   "connect Xero" / "set up Xero" in chat — it explains where to find the forwarding address in
   Xero, asks you to paste it, and saves it once you do (`connect_xero` tool in
   `server/src/ai/assistant.ts`, stored via `server/src/services/xero.ts`). It only ever saves an
   address you actually typed in that conversation — the AI can't fill one in on its own. Doesn't
   forward anything yet; that's step 4.

4. **Decide what gets forwarded.** Every receipt Marlowe files, or should you get a say per-item
   ("forward this one?")? Default: forward automatically, but only things filed as receipts (not
   boarding passes etc.), and tell you it did it.

5. **Unlock the stored file to attach it.** Marlowe stores your receipt files locked (encrypted)
   on the server. Before emailing one to Xero, it needs to unlock it first — small technical step,
   not a design decision.

6. **Avoid double-sending.** Mark each receipt as "already sent to Xero" so it doesn't get
   forwarded twice if something reruns.

7. **Test it against a real Xero forwarding address.** Confirm Xero actually accepts and reads
   what we send it before trusting it for real spending.

8. **Later: scan email for invoices automatically, no forwarding needed from you.** Right now
   Marlowe only picks up a receipt when you send it a photo/PDF via WhatsApp. The next step up:
   Marlowe watches your inbox itself, spots emails that are clearly an invoice or receipt (e.g.
   "Your Uber receipt", "Invoice from X"), pulls them in the same way as a WhatsApp receipt, and
   sends them on to Xero — all without you having to forward or upload anything yourself.

   Needs the same "only ever does the one narrow thing" discipline as step 1: reading the inbox to
   *spot* invoices is broader access than sending is, so when this gets picked up, decide up front
   exactly what Marlowe is allowed to do with what it reads (e.g. it may flag/forward things that
   look like invoices, but should never be given a general "act on anything in this inbox" tool).
