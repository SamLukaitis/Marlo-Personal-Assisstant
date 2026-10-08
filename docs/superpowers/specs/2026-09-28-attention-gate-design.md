# Attention gate: Marlowe as a PA, not a notification feed

## Problem

Marlowe has ~10 independent code paths that message the user unprompted, none aware of the others.
There is no daily budget, no quiet hours and no cross-source dedupe, and several messages are vague
("worth a look?", "N important-looking emails", "…and N more — check your inbox").

Audit (2026-09-28):

| Source | Sends | Problem |
|---|---|---|
| `importantEmailAlerts.ts` | 8 categories of automated mail, instant, up to 5 per 5-min tick + an overflow line | Deliveries, every booking confirmation, every sign-in notice and renewals all interrupt |
| `reconciliation.ts` | "📎 an email about your *X* came in… Worth a look?" | Says an email exists, not what it says; often a second ping for the mail above |
| `tripPrep.ts` | "Check-in should be open for X" / "Check-in day for X" | A third ping for the same booking; uses the server's date, not the user's |
| `emailDigest.ts` | "N new emails from people — Sarah (Re: Thursday)…" | Names senders, not what they want or whether a reply is needed |
| `alerts.ts` (instant mode) | "X emailed you" + raw snippet; "…and N more — check your inbox" | Raw snippet; content-free overflow |
| `onboardingAlertSuppression.ts` | "*N* important-looking emails came in while we were setting up" | A count, no content |
| `briefing.ts` | Inbox/Calendar/Needs-attention lines always present | Filler when empty ("no unread emails"); unread count is noise |

Example: booking one hotel today can produce a ✅ reservation alert, a 📎 document-match alert, a
check-in-day nudge and a briefing mention: four messages for one event.

## Goal

Marlowe behaves like a good PA, the narrow slice of Instinct we want: it notices what matters,
brings it up **at the moment it matters**, and doesn't narrate the inbox. When it learns something
(a booking, a renewal, a bill) it quietly acknowledges it once and says what it will do with it.

Success criteria:

- One real-world event (a booking, an order, a bill) produces at most: one acknowledgement line
  (in the briefing or digest), one timed reminder, and an instant message only if it is in the
  interrupt tier.
- No proactive message contains a banned vague phrase or lacks a concrete specific.
- At most 4 capped messages per user per local day. Nothing is ever dropped because of the cap.
- No capped message is sent between 22:00 and 07:00 user-local time.

## Design

### Tiers

Every candidate proactive item gets exactly one tier:

| Tier | What | Delivery |
|---|---|---|
| `interrupt` | Flight change/delay/cancellation; genuine security alert; government mail that needs action; bill due within 2 days | Sent now as one concrete message |
| `scheduled` | Bookings (flight, hotel, restaurant, car), subscription renewals, bills with a due date further out | Silent on arrival; acknowledged in the next briefing/digest; reminder sent at `surface_at` |
| `brief` | Worth knowing, not worth interrupting: refund/dispute updates, delivery exceptions needing action, government mail with no action, anything whose text failed the concreteness check | One line in the next briefing/digest |
| `drop` | Duplicate of an existing event, routine delivery progress ("out for delivery", "delivered"), marketing | Nothing sent; still stored (`list_flagged_emails` still answers) |

Tier is decided **in code** from structured classifier output (category + `needs_action` + dates),
not by the model, so it is testable and predictable.

Category → tier rules:

- `flight_change` → `interrupt`
- `security_alert` → `interrupt`. The existing own-app and verification-code filters stay.
- `government_mail` → `interrupt` if `needs_action`, else `brief`
- `invoice_due` → `scheduled` (2 days before `due_date`); `interrupt` if due within 2 days, or no due date and `needs_action`; `brief` if no due date and no action
- `reservation_confirmed` → `scheduled` (see timing)
- `subscription_renewal` → `scheduled` (3 days before charge date); `brief` if no date
- `delivery_notification` → `brief` if `needs_action` (failed delivery, customs fee, collect from depot), else `drop`
- `refund_dispute` → `brief`

### Cap and quiet hours

- **Cap:** 4 messages per user per local day across `interrupt` + `scheduled` sends.
- **Exempt from the cap:** flight changes, security alerts, user-set reminders (`reminderScheduler.ts`,
  untouched by this work), and real-person pings for users who explicitly chose instant mode.
- **Over the cap:** the item is never dropped. It becomes `held` and is included in whichever comes
  first, the evening digest or the next morning briefing, then marked `folded`.
- **Quiet hours:** 22:00–07:00 user-local (`userTimezone.ts`). Only `flight_change` breaks through.
  Everything else due in that window is deferred to 07:00. Several deferred items go out as one
  combined message. If the proactive briefing is sent before 09:00, they fold into it instead.
- v1 hardcodes cap and quiet hours as constants; no settings UI.

### Merging duplicates (`event_key`)

Each item carries an `event_key`, normalised in one pure function:

1. `ref:<REFERENCE upper>` when a confirmation/PNR/order/invoice reference is known
2. else `flight:<FLIGHTNO upper>:<YYYY-MM-DD>`
3. else `merchant:<slug>:<YYYY-MM-DD>` when both are known
4. else `msg:<accountId>:<messageId>` (no dedupe possible)

A new item whose `event_key` already exists for this owner **updates** that row rather than creating
a second one:

- It refreshes the details and recomputes `surface_at`. A changed flight time moves the reminder.
- It only produces a message if its own tier is `interrupt`, e.g. a flight change on a known booking.
  In that case the message says what changed and that the reminder moved.
- Otherwise, a venue's own confirmation, a saved document, or a reconciliation match for a known event is absorbed silently.

### Concreteness

Every outgoing gate message is built from structured fields, not free-form model text alone, and
must pass `isConcrete(text)`:

- contains at least one bold specific (`*...*`): a name, reference, amount, date or time
- contains none of the banned phrases: `worth a look`, `check your inbox`, `important-looking`,
  `…and N more` / `and \d+ more`, `might need attention`, `just ask and I'll run through`

A message that fails is not sent. The item is downgraded to `brief`, where the briefing model has the
full stored details. Unit-tested against every template.

Message shape: **what happened** (specifics bold) · **what the user needs to do** (or that nothing is
needed) · **what Marlowe will do next** (if anything). Examples:

- Interrupt: "✈️ Your *BA 432* to Lisbon tomorrow now leaves *09:55* (was 08:40). Nothing to do — I've moved your reminder."
- Reminder: "✈️ *BA 432* to Lisbon tomorrow at *08:40*, ref *X7KQ2P* — online check-in is open."
- Acknowledgement: "Noted your *Netflix* renewal, *£17.99* on *3 Oct* — I'll remind you on the 30th in case you want to cancel."
- Digest line: "*Sarah Kim* — wants to move Thursday's call to Friday; needs a yes/no."

The "what I'll do" clause is generated in code from tier + `surface_at`, not by the model, so it
always matches what the scheduler will actually do.

### Timing defaults (`surface_at`, user-local)

| Item | Reminder time |
|---|---|
| Flight | 24h before departure when a time is known, else 09:00 the day before |
| Hotel | 09:00 on check-in day |
| Restaurant / other reservation | 3h before when a time is known, else 09:00 that day |
| Subscription renewal | 09:00, 3 days before the charge |
| Bill (`invoice_due`) | 09:00, 2 days before the due date |

- **Already in the past when computed:** the reminder surfaces at the next allowed moment (now,
  outside quiet hours), but only if the event itself is still in the future. If the event has
  passed, the item is `drop`.
- **Near the briefing:** a reminder due within 2h after the user's proactive briefing time is folded
  into that briefing instead of sent separately.

### Extracting details

- **Classification:** `classifyImportantEmails` stays a cheap subject + snippet call. It additionally
  returns `needs_action: boolean`.
- **Enrichment:** matches not tiered `drop` get one enrichment call (same Haiku model) on the full
  message (`hubGetMessage`). It returns `summary`, `event_start` (ISO with offset when known),
  `due_date`, `reference`, `flight_number`, `merchant`, `amount`, `needs_action`.
- **Cost:** one extra small call per matched email, not per email.
- **If enrichment fails:** fall back to the classifier's fields. Missing dates mean `scheduled`
  degrades to `brief`.
- **Real-person triage:** `triageRealPersonEmails` additionally returns, per kept email, a one-line
  `gist` ("wants to move Thursday's call to Friday") and `needs_reply: boolean`. No new call; it
  already runs on these emails. Stored on the digest queue entry.

## Components

### New: `attention_items` table (`store.ts` migration)

```sql
CREATE TABLE IF NOT EXISTS attention_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id        INTEGER NOT NULL REFERENCES users(id),
  event_key       TEXT NOT NULL,
  source          TEXT NOT NULL,        -- 'email' | 'document' | 'booking' | 'reconciliation'
  category        TEXT,                 -- importantEmailClassifier category, or 'booking'
  tier            TEXT NOT NULL,        -- interrupt | scheduled | brief | drop
  status          TEXT NOT NULL,        -- pending | sent | held | folded | dropped
  details         TEXT NOT NULL,        -- JSON: summary, dates, reference, amount, merchant, source ids
  surface_at      INTEGER,              -- ms epoch; scheduled reminder time
  acknowledged_at INTEGER,              -- ms epoch; "noted" line delivered in briefing/digest
  sent_at         INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (owner_id, event_key)
);
CREATE INDEX IF NOT EXISTS idx_attention_owner_status_surface ON attention_items(owner_id, status, surface_at);
```

The table must be added to `deleteUserCompletely` (see the recurring owner-scoped-table FK bug).

`important_email` entities (`saveFlaggedEmail`) keep being written, so `list_flagged_emails` is unchanged.

### New: `services/attention.ts`

Pure, unit-tested core:

- `tierFor(category, fields, now, zone)`
- `eventKeyFor(fields, fallback)`
- `surfaceAtFor(item, zone, briefingTime)`
- `isConcrete(text)`
- `withinQuietHours(now, zone)`
- `capRemaining(ownerId, now)`
- message builders: interrupt, reminder, ack line, held line

I/O:

- `submitAttentionItem(ownerId, candidate)`: upsert by `event_key`, decide the tier, and either
  send now (through `sendToAllNumbers`, so per-number retry and history work as today), defer, or
  store.
- `deliverDueAttentionItems(ownerId)`: called each scheduler tick. Sends `scheduled` items whose
  `surface_at` has passed, plus quiet-hours-deferred interrupts, respecting the cap. Over-cap items
  become `held`.
- `takeBriefingAttention(ownerId)` / `takeDigestAttention(ownerId)`: return unacknowledged
  `scheduled` items (ack lines) plus `brief`/`held` items. After a successful send, the caller
  marks them `acknowledged_at` / `folded`.

### Changed

- **`importantEmailAlerts.ts`:** classify → enrich → `submitAttentionItem`. It no longer sends
  directly. The per-tick 5 cap and the overflow message are removed; the gate's daily cap replaces
  them.
  - Onboarding: the curated preview in "Connected!" stays.
  - Xero: the invoice "reply yes to forward to Xero" offer moves to the moment the bill's reminder
    (or interrupt) is actually sent; `setPendingInvoiceForward` is called then.
- **`reconciliation.ts`:** a strong match becomes `submitAttentionItem` with the document's
  reference as `event_key`, tier `brief`. It usually merges silently into the existing item.
  `buildMatchNotification` and the direct send are removed.
- **`tripPrep.ts`:** each tick upserts future `booking` entities as `scheduled` attention items
  (idempotent by `event_key`) instead of sending. `tripPrepNotifiedAt` stays as a marker only.
  The fix to use the user's local date comes free with `surfaceAtFor`. Existing future bookings are
  picked up automatically on first run.
- **`alerts.ts`:**
  - Digest mode: queues with `gist`/`needs_reply`.
  - Instant mode: sends "📬 *Sarah Kim* — wants to move Thursday's call to Friday; needs a yes/no."
    instead of the raw snippet. It respects quiet hours but not the cap.
  - The "…and N more" line goes; overflow joins the digest queue.
- **`emailDigest.ts`:**
  - Each person line becomes `*Name* — gist; needs a reply` (or no suffix).
  - It also carries attention ack/brief/held lines when the proactive briefing is off, and held
    (over-cap) lines always.
  - It sends when either list is non-empty.
  - Attention lines are sent even if real-person alerts are off (only people lines are gated by
    that setting).
- **`briefing.ts`:**
  - New fact line "Noted since the last briefing" (acks) and "Needs attention" (brief/held items),
    sourced from `takeBriefingAttention`.
  - The prompt drops the "always say none" rule for Inbox/Calendar/Needs-attention. Empty sections
    are omitted, and the unread count is removed from the Inbox line.
  - Items are marked folded only when the scheduler actually delivers the briefing. If a cached
    briefing predates new items, the scheduler regenerates it before sending.
- **`onboardingAlertSuppression.ts`:** the count-and-flush summary is removed.
  - Real-person mail during suppression is queued for the digest (with gist).
  - Reconciliation matches go to the gate.
  - `isPostConnectChainInProgress` stays as the gate's hold-until-chain-ends check.
- **`scheduler.ts`:** calls `deliverDueAttentionItems` after the mail scans, then the digest flush.

### Unchanged

User-set reminders and their 24h give-up notice, the slow-reply holding message, Xero receipt
forwarding follow-ups, onboarding/registration messages, and the Schengen line in the briefing.

## Settings interaction

- `important_email_alerts_enabled = false`: email-derived attention items are not created (as today).
- Travel tool off: booking reminders are not created (as today's trip-prep gate).
- `realtime_alerts_enabled = false`: no people lines in the digest; attention lines still flow.

## Error handling

- A send failure leaves the item `pending`/due, and it is retried next tick for the numbers that
  missed it (`proactiveDelivery.ts`). It does not count against the cap until delivered.
- An enrichment failure falls back to the classifier's fields. A classification failure keeps
  today's behaviour (hold the checkpoint, retry).
- The cap count is derived from `sent_at` within the user's local day, not a separate counter,
  so it cannot drift.

## Testing

Unit tests (`attention.test.ts`):

- the tier table
- `event_key` normalisation and merging (booking email + venue email + document gives one row;
  a flight change on a known booking gives one interrupt and a moved `surface_at`)
- timing defaults, including past/near-briefing cases
- quiet-hours deferral and the flight-change exception
- the cap: the 5th capped item becomes `held`, then folds into the next digest/briefing and is
  never lost; exempt categories bypass the cap
- `isConcrete` against every template and banned phrase

Updated tests:

- `importantEmailAlerts`, `reconciliation`, `tripPrep`, `emailDigest`, `alerts`, `briefing`,
  `onboardingAlertSuppression`
- the prompt/parser tests for the classifier, enrichment and triage extensions
- `deleteUserCompletely` covers `attention_items`

## Out of scope

User-configurable cap/quiet hours, user-facing to-dos, reminders into the briefing (see
`briefing-alert-config-todo`), web UI changes, and an LLM "decide everything" pass.
