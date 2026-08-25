# Document deduplication — exact vs. fuzzy

Comes up any time a document/receipt could reach Marlowe more than once — not specific to Xero
forwarding, will affect any feature built on `documents`/`entities`. Two different problems, worth
keeping separate rather than solving with one mechanism:

## 1. Exact duplicate — worth building eventually

The literal same file arrives twice (e.g. a WhatsApp webhook redelivery, or someone genuinely
resending the identical photo). Cheap and safe to catch: compare file bytes — a `content_hash`
column on `documents` (already brainstormed in `changelog/2026-08-24-entities-and-links.md`) would
let a second identical upload be dropped/ignored outright. No ambiguity, no judgment call, no
false-positive risk. Not built yet.

## 2. Fuzzy duplicate — decided against, deliberately

Two *different* photos of the same physical receipt, or two genuinely separate purchases that
happen to look alike (same vendor/amount/date) — where the extracted *data* looks the same but the
files themselves differ. **Decision (2026-08-26, Jake): not building an automatic check for this.**

Any such check has to guess, and both ways of guessing wrong are worse than doing nothing:
- Too eager → silently drops or merges a real, separate expense — silent data loss on financial
  records, the worse failure.
- Too cautious → keeps interrupting to ask "is this a duplicate?" — the hand-holding Jake
  explicitly doesn't want from Marlowe.

Occasionally forwarding/logging the same real receipt twice is a minor, recoverable annoyance
(accounting software already expects to reconcile the odd duplicate bill) — a better trade than
either failure mode above. Leave "was this already handled" as the user's judgment call, not
something Marlowe tries to infer from extracted data. Applies to any future document-adjacent
feature, not just Xero.
