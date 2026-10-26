A script now moves a Marlowe account to a new WhatsApp number, keeping its data.

**Why:** someone's SIM changed (the founder, UK to Peru and later back), and Settings can only rebind the number itself. Chat history, the conversation summary, saved documents and the like are keyed by the phone number, so they would have been left behind.

**How to use it** (from `server/`, on the machine holding the real database; in production that is inside the Railway container; copy `data/app.db` first):
- `npm run change-phone -- <old> <new>` is a dry run that lists the rows per table.
- Add `--apply` to do it, in one transaction.

**What it does** (`server/src/services/phoneChange.ts`)
- Rebinds the number on the account and clears its `last_inbound_at`, because the new number has no open 24h window, so Marlowe sends a template first rather than free text WhatsApp would reject.
- Moves the phone-keyed tables: chat messages, conversation summary, documents, phone actions, memory cursors, proactive deliveries, invite.
- Clears stale waitlist, pending-registration and replay-park rows the new number picked up before the move.
- Stops, changing nothing, if the old number isn't bound, the new one belongs to another account, or the new number already has chat history (it won't merge two histories).

**Joyce is not moved.** Joyce keeps its own phone registry (hashed numbers in per-family databases). If the old number is in a Joyce family, the script warns and leaves the Marlowe-side family link and shared trips on the old number so the two stay consistent. The Joyce side needs its own move.

A test fails if a new table gains a `phone` column that the script doesn't know about.
