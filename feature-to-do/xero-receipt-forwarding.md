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

4. **Decide what gets forwarded, and build the actual forward. ✅ Done (2026-08-25).** Went with
   the default: forward automatically, no per-item confirmation, but only things Marlowe actually
   filed under the `receipts` category *and* where it successfully pulled a real amount out of it
   (not e.g. a hotel confirmation filed under `travel`, even though those can carry a payment too)
   — and tell you it did it. Built in `server/src/services/xeroForwarding.ts`, triggered right
   after a WhatsApp receipt is saved (`server/src/services/documents.ts`). Doesn't block or delay
   the normal "receipt saved" confirmation — forwarding happens in the background and its own
   outcome (sent, or couldn't) arrives as a separate WhatsApp follow-up message.

5. **Unlock the stored file to attach it. ✅ Done (2026-08-25) — turned out to be free.** The file
   is already unlocked in memory at the exact moment of extraction (before it gets re-encrypted for
   storage), so the forwarder reuses that same in-memory copy — no extra decrypt step needed.

6. **Avoid double-sending. ✅ Done (2026-08-25).** Every document now carries a
   `xero_forwarded_at` timestamp (`server/src/db/store.ts`) — null until it's actually been
   emailed to Xero, set the moment it has. `forwardReceiptToXero` checks it first and refuses to
   re-send a document that's already marked. This protects against the same *document row* ever
   going out twice (e.g. a future "resend" tool). It does **not** protect against the same photo
   being ingested as two separate document rows in the first place, or two different photos of the
   same receipt — see `feature-to-do/document-deduplication.md` for why that's deliberately not
   being solved here.

7. **Test it against a real Xero forwarding address.** Automated tests cover the forwarding logic
   itself (`server/src/services/xeroForwarding.test.ts`) and the live `connect_xero` chat flow was
   tested end-to-end. Not yet tested: sending a real WhatsApp receipt through to see a real email
   land in a real Xero inbox — needs your actual Xero forwarding address and, since it goes via
   WhatsApp, touches the same production number your family uses (see
   `feature-to-do/dev-whatsapp-number.md`). Do this once you're ready to point it at a real Xero
   trial/account.

8. **Scan email for invoices, fully automatic. ✅ Done (2026-08-26, revised same day).** Sam
   separately built two things this plugs into: an email attachment pipeline
   (`ingestEmailAttachment` — download an attachment from an email and run it through the exact
   same extract/validate/store path as a WhatsApp photo, so it already benefited from step 1-6's
   Xero forwarding for free) and a proactive classifier that scans automated mail every 5 minutes
   and flags one category as `invoice_due`.

   **First built as notify-then-confirm** ("reply yes and I'll forward it to Xero"), matching
   step 1's original design decision. **Revised same day, still 2026-08-26**, once Jake actually
   used it: having to reply to each one was exactly the hand-holding he'd said from the start he
   didn't want, so this is now **fully automatic** — same trust level as a WhatsApp receipt.
   When `invoice_due` fires and Xero is connected and the email has either an attachment or real
   body text, Marlowe extracts and forwards it immediately, no reply needed; the alert just gains
   a line — *"Forwarding to Xero."* — and `forwardReceiptToXero`'s own existing success/failure
   WhatsApp message (already built in step 1) confirms once it's actually done. **Plain-text
   receipts (no attachment) covered too** — a subscription renewal or payment confirmation that's
   just email text goes through a sibling path (`ingestEmailBodyReceipt`) that extracts the
   vendor/amount from the body using the same validation as everything else; if it can't find a
   real expense, it quietly does nothing rather than forwarding an empty document — there's no
   human confirming first anymore, so a false-positive classification should fail closed, not
   send junk to Xero.

   The confirm-step machinery (`xeroInvoiceConfirmation.ts`, the `respond_to_invoice_forward_prompt`
   tool) was deleted outright rather than left dead, once it stopped being how this works.

   **Open question, not yet verified: does the plain-text (`.txt` attachment) path actually
   produce a usable bill in Xero?** Checked Xero's own documentation (2026-08-26): the standard
   Email-to-Bills feature only scans attachments (PDF/JPG/PNG) — a plain email body is never read,
   confirming body-only delivery would never have worked. What we send instead (a small `.txt`
   *attachment* with the extracted text) has a real chance, since Xero's Hubdoc-powered capture
   engine does list plain text among its supported formats — but whether Jake's specific
   forwarding address actually routes through that engine is unconfirmed. **Don't treat this as
   proven until a real plain-text receipt has been checked in Xero afterward** — if nothing usable
   shows up, the honest fix is having Marlowe say plainly "no attachment on this one, you'll need
   to enter it yourself" instead of silently sending something Xero can't read.
