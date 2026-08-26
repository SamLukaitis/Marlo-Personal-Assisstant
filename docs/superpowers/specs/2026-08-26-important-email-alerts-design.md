# Proactive important-email notifications

## Problem

Today, nothing proactively flags transactional/automated mail — flight changes, invoices,
government correspondence, and the like. Two existing checks come close but both structurally
miss this category:

- `checkForNewImportantMessages` (`server/src/services/alerts.ts`) explicitly **excludes**
  automated senders (`AUTOMATED_SENDER_PATTERN` in `hub.ts`) — it only pings on unread mail from
  real people.
- `checkNewEmailsAgainstRecentDocuments` (`server/src/services/reconciliation.ts`) only matches an
  incoming email against a document the user **already saved**. There's no coverage for a
  first-time reservation confirmation, invoice, or piece of government mail with nothing to match
  against yet.

So a flight-cancellation email or a tax notice can sit unread indefinitely with no proactive
signal at all, until (if ever) the user happens to check their inbox directly. This was scoped in
an earlier conversation as the third of three tester-readiness features, deferred until the first
two — proactive memory surfacing and the hallucination/grounding eval — were done.

## Design

### Categories (8, fixed allow-list)

| key | emoji | meaning |
|---|---|---|
| `flight_change` | ✈️ | Flight/reservation change or cancellation |
| `reservation_confirmed` | ✅ | A new reservation confirmation (flight, hotel, car, etc.) |
| `invoice_due` | 💳 | Invoice or payment due |
| `government_mail` | 🏛️ | Government correspondence |
| `delivery_notification` | 📦 | Delivery/shipping notice (out for delivery, delayed, exception) |
| `security_alert` | 🔐 | New sign-in, password changed, suspicious activity |
| `subscription_renewal` | 🔁 | Upcoming auto-renewal charge or a price increase notice |
| `refund_dispute` | 💰 | Status update on a refund, chargeback, or dispute already in progress |

Fixed for v1 — not user-configurable, not stored per-category settings. A single global list the
classifier is told to use.

### New file: `server/src/services/importantEmailAlerts.ts`

Sibling to `alerts.ts` and `reconciliation.ts`, following their shape closely.

`checkForImportantEmails(ownerId)`:

1. `hubListMessages(ownerId, { limit: 50 })`, filtered to
   `m.unread && m.from && AUTOMATED_SENDER_PATTERN.test(m.from)` — the exact **inverse** of
   `alerts.ts`'s filter, reusing the same exported pattern from `hub.ts`.
2. **Baseline on first run**, identical to `alerts.ts`'s `BASELINE_KEY` pattern: a
   `important_email_baseline_set` setting. On the first-ever run for a user, every current
   candidate is marked alerted without notifying, so shipping this (on-by-default, see below)
   doesn't backfill-alert a user's entire existing unread automated mail the moment it deploys.
3. Excludes anything already alerted, via a **namespaced** dedupe key —
   `` `important-email:${accountId}:${id}` `` — never the bare `` `${accountId}:${id}` `` key
   `alerts.ts` uses on the same `hasAlerted`/`markAlerted` ledger. The two features are mutually
   exclusive by filter today (one wants non-automated senders, this wants automated ones) so a
   collision can't happen in practice, but the prefix keeps that true by construction rather than
   by coincidence, and keeps this feature's key space collision-free against
   `reconciliation.ts`'s `recon-match:`/`recon-scan:` prefixes too.
4. If there are zero unscanned candidates, return early — no API call.
5. Otherwise, one Haiku call classifies all candidates in a single request (see below).
6. Matches are sent via WhatsApp (existing `sendWhatsAppMessage` plumbing, `alerts.ts`'s
   `notify()`-style loop over registered numbers), capped at `MAX_ALERTS_PER_CHECK` (5, matching
   `alerts.ts`) with the same "...and N more" overflow summary for anything past the cap.
7. Every candidate that was actually examined by the classification call — matched or not — gets
   marked scanned, so a boring piece of automated mail isn't reclassified every tick. (Same
   already-established principle as `reconciliation.ts`'s `scanKey`: only what was truly examined
   gets marked, so an API failure before classification leaves candidates retriable.)

### Classification: one batched Haiku call

```ts
const CLASSIFY_TOOL: Anthropic.Tool = {
  name: "classify_messages",
  description:
    "For each numbered email below, decide whether it clearly falls into exactly one of the " +
    "fixed categories. Only include emails that are a clear, confident match — skip anything " +
    "ambiguous, promotional, or a generic automated notice that isn't one of these categories " +
    "(newsletters, marketing, app notifications with no action needed). Omit indices that don't match.",
  input_schema: {
    type: "object",
    properties: {
      matches: {
        type: "array",
        items: {
          type: "object",
          properties: {
            index: { type: "number" },
            category: {
              type: "string",
              enum: [
                "flight_change", "reservation_confirmed", "invoice_due", "government_mail",
                "delivery_notification", "security_alert", "subscription_renewal", "refund_dispute",
              ],
            },
          },
          required: ["index", "category"],
        },
      },
    },
    required: ["matches"],
  },
};
```

Called with `tool_choice: { type: "tool", name: "classify_messages" }` to force structured output
(the same "model transcribes/decides, code stores" split `documents.ts` already uses for
extraction), model `MODEL_SIMPLE`/Haiku (imported from `assistant.ts`'s existing constant, or a
small local equivalent — cheap-tier lookup, same tier discipline as elsewhere in the app). Input is
each candidate's array index plus subject + snippet only (no full body fetch) — same
cost-conscious "subject+snippet is enough" precedent as `reconciliation.ts`'s
`buildMatchNotification`.

One call per user per tick (only when candidates exist), regardless of how many candidates there
are — cost stays flat rather than scaling per-message.

### Message format

```
{emoji} {category label}: "{subject}" from {from}
{snippet}
```

e.g. `✈️ Flight change: "Your flight AA123 has been rescheduled" from no-reply@aa.com\n...`

### Settings — on by default, opt-out

New setting key `important_email_alerts_enabled`. Unlike `realtime_alerts_enabled` (checked as
`=== "true"`, opt-in), this is checked as **`getSetting(...) !== "false"`** — true unless
explicitly turned off. This is a deliberate, called-out-in-code deviation from the existing
opt-in precedent: flight cancellations and government mail are important enough that most users
want this immediately, with an easy off switch for the few who don't.

Routes: `GET`/`PUT /api/important-email-alerts/settings` added to the existing
`server/src/routes/alertRoutes.ts`, mirroring the existing pair exactly except for the inverted
default (`enabled: getSetting(...) !== "false"` instead of `=== "true"`).

Setup page: a second `check-row` checkbox next to the existing "Ping me when a real person
emails" toggle, defaulted to `true` client-side when the fetched value is `undefined` (covers the
gap between a user existing before this ships and their first settings fetch).

### Scheduler wiring

`server/src/services/scheduler.ts` gains a fourth per-user tick step,
`runImportantEmailAlertsCheckForUser`, gated on the setting and wrapped in the same
try/catch-per-user isolation as the other three:

```ts
async function runImportantEmailAlertsCheckForUser(ownerId: number): Promise<void> {
  if (getSetting(ownerId, "important_email_alerts_enabled") === "false") return;
  try {
    await checkForImportantEmails(ownerId);
  } catch (err) {
    console.error(`scheduler: important-email check failed for user ${ownerId}`, err);
  }
}
```

### Error handling

- `hubListMessages` failure → logged, function returns, everything stays unscanned for retry next
  tick (matches `reconciliation.ts`'s precedent).
- Classification call failure (API error) → logged, candidates stay unscanned (not marked), retried
  next tick — never silently drop a candidate because the classifier itself failed.
- A WhatsApp send failure for a matched message → not marked alerted, retried next tick (matches
  `memoryReminders.ts`'s precedent for anything more consequential than "an email arrived," which
  this is closer to than `alerts.ts`'s fire-and-forget).
- One user's failure at any step never blocks another user's tick (existing pattern, unchanged).

### Testing

Same split as every other LLM-backed feature in this codebase (no precedent anywhere for mocking
the Anthropic SDK in a unit test):

- **Unit-tested (mocked `hub.js`/`db/store.js`, same seam as `alerts.test.ts`/
  `reconciliation.test.ts`):** candidate filtering (unread + automated-sender only, inverse of
  `alerts.ts`'s filter), baseline-on-first-run behavior, dedupe-key namespacing (no collision with
  `alerts.ts`'s bare key or `reconciliation.ts`'s `recon-*` keys), per-tick cap + overflow-summary
  message, settings default-true/opt-out behavior (`GET` returns `true` when unset, `false` only
  once explicitly set), and scheduler gating.
- **Not unit-tested, verified manually against the real model:** whether the classifier actually
  picks the right category for a real email, and skips ambiguous/promotional automated mail
  correctly. Verification: send a handful of realistic automated emails (a flight-change notice,
  an invoice, a security alert, and a plain newsletter as a true-negative check) into a
  connected test account, wait for a tick, confirm the right ones fire with the right category and
  the newsletter doesn't. Same manual-verification shape as Feature 1's Task 5.

## Out of scope

- User-configurable categories or per-category on/off toggles — one fixed list, one on/off switch
  for v1.
- Full message-body fetch for classification — subject+snippet only, consistent with the rest of
  the app's cost discipline.
- Extending the grounding-eval framework (feature 2) to cover this path — that framework tests
  `runAssistantChat`'s conversational grounding, not this scheduler-tick classification path; not
  the same kind of correctness problem.
- A weak-match/fuzzy tier, or reusing `reconciliation.ts`'s matching machinery — already reviewed
  and rejected for this feature in the earlier scoping conversation: false positives on a
  wrong-category classification are more tolerable than `reconciliation.ts`'s wrong-booking-match
  risk, and this is a different mechanism (classification, not identifier matching) entirely.
