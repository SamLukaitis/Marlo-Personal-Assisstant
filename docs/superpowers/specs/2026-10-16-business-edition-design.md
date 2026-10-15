# Business edition (UK sole traders) — design

**Date:** 2026-10-16
**Status:** Draft for review
**Why:** Angel investor feedback (Oct 2026) — the general personal-assistant thesis competes head-on with
Claude/ChatGPT/Gemini/Apple/Google. Narrow the wedge to something the giants won't prioritise and where
willingness to pay is higher: admin and bookkeeping for UK sole traders.

## Goal and success criteria

A sole trader messages Marlo on WhatsApp and their books keep themselves: every receipt, bill and
payment is captured, categorised against HMRC's self-employment categories, and turned into a running
"earned / spent / put aside for tax" picture with Making Tax Digital (MTD) deadlines handled.

Success (investor's kill criteria, 3–6 month window):
- 100 business-edition users
- 40%+ weekly active after 8 weeks
- A meaningful share willing to pay (target price £15–25/month, tested before charging)

## Decisions taken

| Question | Decision |
|---|---|
| Separate project/fork vs one codebase | **One codebase, editions.** Business code isolated in `server/src/business/`. |
| Core job | **Bookkeeping on autopilot first (phase A), then tax/MTD readiness (phase C).** Getting-paid/invoicing deferred. |
| Where the books live | **Marlo's own ledger**, Xero optional (existing email-forwarding stays). |
| General Marlowe | **Continues as the `general` edition for now**; may be frozen later (one-line change). |
| Edition vs add-on | **Separate edition**, keeping personal essentials (calendar, email, reminders). |
| Income capture | **Chat + email first; Open Banking bank feed in phase C.** |
| Edition mechanism | **Per-user `edition` column + edition registry** (not separate deploys). |

## Assumptions (confirmed)

- Not VAT-registered: MVP targets sole traders under the £90k VAT threshold. VAT tracking is later.
- No direct HMRC submission in this design. Phase C gives estimates, deadlines and an exportable
  quarterly summary. Becoming HMRC-recognised MTD software is its own later project.
- GBP only.

## Out of scope

Invoicing/chasing, VAT, direct HMRC submission, limited companies, payroll, Xero API (read/write books),
multiple businesses per user, separate WhatsApp number per brand, mileage/simplified-expense flat
rates (good follow-up — see "Later").

---

## 1. Edition layer

**Data:** `users.edition TEXT NOT NULL DEFAULT 'general'` — `'general' | 'business'`. Existing users
stay `general`. Admin portal can change it.

**Registry:** `server/src/editions/` holds one definition per edition:

```ts
interface Edition {
  id: "general" | "business";
  brandName: string;                     // "Marlowe" / business brand (name is a product decision)
  promptSection: (ownerId: number) => string;   // appended in buildSystemPrompt
  tools: { include?: string[]; exclude?: string[] };
  onboardingSteps: OnboardingStepId[];
  briefingDefaults: BriefingDefaults;    // business: no news/markets, adds a "money" block
}
export function getEdition(ownerId: number): Edition;
```

`getEdition(ownerId)` is the only way code asks which edition a user is on.

**Plug-in points:**
- `buildSystemPrompt` (`server/src/ai/assistant.ts`) appends the edition's prompt section.
- Tool assembly in `assistant.ts` filters by edition, then by the existing per-user `set_tool_enabled`.
- Onboarding, briefing and scheduler read edition defaults.

**Business edition tool set:** keeps email, calendar, reminders, memory, documents, contacts, web
search, phone actions, `connect_xero`, `respond_to_invoice_forward_prompt`; adds the ledger tools
(section 3); excludes travel check-ins/day counts, trips, news, markets.

**Boundary rule:** business-only code lives in `server/src/business/`. General code never imports it;
the registry is the only link (it loads business tools from `business/tools.ts`). Every business tool
handler also checks `getEdition(ownerId).id === "business"` and refuses otherwise (defence in depth).

**Assignment:** `npm run invite -- x@y.com --edition business`. A business signup link comes later.

**Tests:** business tool list includes ledger tools and excludes travel/news/markets; general user never
sees business tools; business tool called by a general user refuses; prompt section only appears for
business users.

## 2. Ledger

Dedicated tables (not the JSON `entities` table): money needs exact sums, constraints and an audit trail.

```
ledger_entries
  id               INTEGER PK
  owner_id         INTEGER NOT NULL → users(id)
  direction        TEXT NOT NULL  CHECK in ('in','out')
  amount_pence     INTEGER NOT NULL CHECK > 0      -- GBP only
  occurred_on      TEXT NOT NULL  (YYYY-MM-DD)     -- tax year derived: 6 Apr – 5 Apr
  counterparty     TEXT
  description      TEXT
  category         TEXT            -- SA103 key for 'out'; null for 'in'
  business_use     TEXT NOT NULL  CHECK in ('business','personal','unsure')
  status           TEXT NOT NULL  CHECK in ('confirmed','needs_review')
  source           TEXT NOT NULL  CHECK in ('whatsapp_doc','email','chat','bank')
  document_id      INTEGER NULL → documents(id)
  source_ref       TEXT NULL       -- email message id, bank txn id, etc.
  deleted_at       INTEGER NULL    -- soft delete only
  created_at, updated_at INTEGER NOT NULL
  -- partial unique indexes (CREATE UNIQUE INDEX ... WHERE):
  UNIQUE (owner_id, document_id) WHERE document_id IS NOT NULL
  UNIQUE (owner_id, source, source_ref, amount_pence) WHERE source_ref IS NOT NULL

ledger_entry_history
  id, entry_id → ledger_entries, owner_id, changed_at, changed_by ('user'|'assistant'|'system'),
  before_json, after_json
```

**Categories** (`business/categories.ts`): SA103S expense boxes — `cost_of_goods`, `car_van_travel`,
`staff`, `premises` (rent, rates, power, insurance), `repairs`, `phone_office` (phone, stationery,
office costs), `advertising`, `finance_charges` (interest, bank/card charges), `professional_fees`,
`other`. Each has plain-English hints used in the categoriser prompt ("Screwfix → repairs, or
cost_of_goods if resold"). Business entertainment is not allowable — record as `personal` with a note.

**Rules:**
- Never hard-delete. "Undo" sets `deleted_at`; every update writes a history row.
- Totals count only `business_use='business' AND status='confirmed' AND deleted_at IS NULL`.
- Dedupe via the unique indexes above; a duplicate insert returns the existing entry.
- `deleteUserCompletely` must delete both tables (history first). Explicit test — this function has a
  recurring owner-scoped-table FK bug.

**Existing expenses:** for business users, the receipt pipeline also writes the ledger entry (linked by
`document_id`). The ledger is the source of truth for money; the expense entity remains for the memory
graph. General users are unchanged.

**Tests:** tax-year boundary (5 vs 6 April); totals exclusions; dedupe; history on every edit; deletion
clears both tables.

## 3. Capture flows (phase A)

All flows end in `business/ledger.ts → recordEntry(...)`, which validates, dedupes, writes, and decides
whether a question is needed.

**a) Receipt photo/PDF on WhatsApp.** Existing extraction in `services/documents.ts` runs unchanged. For
business users, after a receipt saves, `business/receiptToLedger.ts` creates an `out` entry from the
extracted vendor/amount/date and runs the categoriser. Existing Xero forwarding still fires if connected.

**b) Bills and receipts in email.** The existing classifier already flags `invoice_due`; for business
users the existing "forward to Xero?" offer becomes "log it?" (and forward to Xero if connected), using
`ingestEmailAttachment` / `ingestEmailBodyReceipt`. Same one-slot pending-offer pattern as
`xeroInvoiceConfirmation.ts`.

**c) Income from email.** New lightweight detector `business/incomeDetector.ts` over automated mail:
payout/payment-received emails (Stripe, SumUp, PayPal, Square, "invoice paid", remittance advice).
It offers, never auto-logs: "Log £450 from Dave as income?" via `ask_user_choice`. Runs through the
attention gate (`services/attention.ts`) as a non-urgent item — batched into briefing/recap, never an
interruption.

**d) Chat.** "Dave paid me £450", "spent £32 on fuel" → `log_income` / `log_expense` tools.

**Categoriser** (`business/categorise.ts`): one small-model call with the category hints, the user's own
past categorisations for the same counterparty (counterparty memory beats the model), and the item. It
returns `{category, business_use, confidence}`. High confidence + known counterparty → `confirmed`
silently. Otherwise `needs_review`, and the user is asked once, with buttons: "Screwfix £48.20 —
repairs? [Yes] [Different category] [Personal]". Answers update counterparty memory, so the same
supplier is never asked about again.

**Ledger tools (assistant):** `log_expense`, `log_income`, `list_ledger` (filters: period, category,
direction, status), `update_ledger_entry`, `remove_ledger_entry` (soft, confirm first),
`get_money_summary` (period totals by category), `review_pending` (walks needs_review items).

**Tests:** each flow produces exactly one entry; Xero forwarding still fires; income offers go through
the attention gate and never auto-log; known counterparty skips the question; answering a review
updates counterparty memory.

## 4. Business onboarding and experience

**Onboarding (business edition steps):**
1. Name + what the business does (one line — feeds the categoriser prompt: "plumber", "photographer").
2. Connect email (existing flow) — "so I can catch bills and payments".
3. "Send me a photo of any receipt" — first win within minutes.
4. Optional: Xero forwarding address (existing `connect_xero`).
5. Optional: tax-year start — "anything from before today you want to add?" (bulk-forward old
   receipts; no backfill import in MVP).

**Prompt section:** Marlo is the user's admin assistant for their business. Plain English, no
accountancy jargon unless asked. Always says "estimate", never gives tax advice; suggests an accountant
for anything judgement-based (capital allowances, use-of-home, mixed-use splits).

**Briefing:** business defaults drop news/markets and add a money block: "This week: £1,240 in, £310
out. 3 receipts need a quick check." Weekly summary on Mondays by default; daily line only if there
are items to review.

**Brand:** brand name and landing page copy are product decisions, out of scope for this spec; the
registry carries `brandName` so the copy changes in one place.

## 5. Tax and MTD readiness (phase C)

**Tax estimate** (`business/taxEstimate.ts`): profit = confirmed business income − confirmed business
expenses for the tax year to date; applies Income Tax bands and Class 4 NI from a per-tax-year rates
file (`business/taxRates/2026-27.ts` — rates verified against gov.uk when written, never inlined).
Output: "Put aside about £X so far" plus a projection to year end from the run rate. Always labelled
an estimate; ignores other income (employment, property) unless the user tells Marlo about it, and
says so. Trading allowance (£1,000) shown when turnover is tiny.

**MTD for Income Tax:**
- Asks gross self-employment + property income band at onboarding to say whether/when MTD applies
  (mandatory from April 2026 above £50k, April 2027 above £30k, April 2028 above £20k — verified
  against gov.uk at build time).
- Quarterly deadlines as reminders through the existing reminder scheduler, two weeks and three days
  before each one; the reminder says what's unreviewed.
- `get_quarter_summary` / export: per-category totals for the quarter as CSV + a PDF one-pager,
  formatted to drop into the user's MTD bridging software or hand to their accountant.

**Bank feed (phase C):** Open Banking via an aggregator (provider choice — TrueLayer, GoCardless Bank
Account Data, Plaid — is its own short spike: cost, licensing as agent, 90-day re-consent UX).
Transactions land as `source='bank'` entries matched against existing receipt/email entries
(amount ± date window) so nothing is double-counted; unmatched ones go to review.

**Tests:** tax bands at each threshold; Class 4 NI; estimate excludes personal/review/deleted; quarter
boundaries; MTD applicability per income band; bank match doesn't double count.

## Build order

1. Edition layer (section 1) — invisible to users.
2. Ledger tables + `recordEntry` + chat tools (sections 2, 3d).
3. Receipt → ledger + categoriser + review questions (3a).
4. Email bills + income offers (3b, 3c).
5. Business onboarding + briefing money block (section 4). **→ Start recruiting the first users here.**
6. Tax estimate + MTD reminders + quarter export (section 5).
7. Bank feed spike, then integration.

Steps 1–5 form one implementation plan (phase A). Step 6 is a second plan; step 7 starts with a spike.

## Risks

- **Categorisation errors erode trust.** Mitigation: ask on doubt, counterparty memory, easy correction,
  audit history.
- **Tax estimates mistaken for advice.** Mitigation: always "estimate", disclaimers in the prompt,
  rates in reviewed files, accountant handoff.
- **Gmail restricted-scope verification** (investor point 5) still applies — unchanged by this design;
  budget for it before opening sign-ups beyond test users.
- **WhatsApp channel risk** — unchanged; the ledger and exports live in Marlo, so the data isn't
  hostage to the channel.

## Later

Mileage and simplified expenses (45p/mile), VAT, invoicing and chasing, Xero API sync, HMRC-recognised
MTD submission, separate WhatsApp number per brand, accountant read-only access.
