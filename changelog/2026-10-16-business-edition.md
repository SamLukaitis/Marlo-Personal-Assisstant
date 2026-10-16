Marlowe now has a business edition for UK sole traders: receipts, bills and payments go into a simple set of books, sorted into HMRC's expense categories.

## What changed

Each user is now on an **edition**: `general` (everything Marlowe did before, unchanged) or
`business`. A business user gets a work-focused assistant. Calendar, email, reminders and memory stay;
travel, news, markets and the old expense tools are switched off. On top of that they get a ledger,
which is a list of money in and out:

- **Receipts and bills** they send on WhatsApp, or say yes to from an invoice email, go into the
  books automatically. Marlowe guesses the HMRC category (repairs, travel, phone and office, and so
  on), but a guess always waits for the user to check it. Once they've answered for a supplier
  ("Screwfix is repairs"), that supplier is never asked about again.
- **Payment emails** from Stripe, SumUp and PayPal, plus "invoice paid" and remittance emails, are
  logged as income waiting for a check. Marlowe doesn't send a message about them.
- **In chat:** "spent £32 on fuel" and "Dave paid me £450" go straight in. The user can ask for
  totals for this week, this month or the tax year.
- **The morning briefing** gives last week's money in and out on Mondays, and mentions anything that
  needs a check.

Nothing in the books is ever really deleted. Removing an entry hides it, and every change is kept
in its history, which an accountant can trust. Personal spending and entries that haven't been
checked are left out of the totals.

To put someone on it in the live app: tick **Business tester** when inviting them in Settings →
Admin, or press **Make business** next to them on the Portal's Admins tab (it takes effect on their
next message, and switching back never deletes their books). Locally there are also
`npm run invite -- <phone> --edition business` and `npm run set-edition -- <phone> business`.

## Why

An angel investor's feedback was that a general personal assistant competes head-on with ChatGPT,
Claude, Gemini and the phone makers, and that the wedge should be narrowed to something they won't
prioritise and where people will pay. UK sole traders' admin (receipts, bookkeeping, Making Tax
Digital) was the most promising option. This builds the bookkeeping half on the same codebase, so
WhatsApp, email, security and every fix stay shared.

## Notes

- GBP only. A receipt in another currency is skipped, not converted.
- No tax estimates or MTD reminders yet. That's phase C: `feature-to-do/business-edition-phase-c.md`.
- Business code lives in `server/src/business/` and is only reached through
  `server/src/editions/index.ts`. General code never imports it.

Design: `docs/superpowers/specs/2026-10-16-business-edition-design.md`.
Plan: `docs/superpowers/plans/2026-10-16-business-edition-phase-a.md`.
