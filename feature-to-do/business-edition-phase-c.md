# Business edition: what's next after the bookkeeping

Phase A (done 2026-10-16) gave UK sole traders a set of books that fill themselves from receipts,
bills, payment emails and chat. These are the next pieces, roughly in order. The design for most of
them is in `docs/superpowers/specs/2026-10-16-business-edition-design.md` §5.

1. **"Put aside about £X for tax."** A running Income Tax + Class 4 NI estimate from the books, with
   the rates kept in a file per tax year and checked against gov.uk. Always called an estimate,
   never advice.
2. **Making Tax Digital.** Ask roughly what they earn to work out whether and when MTD applies to
   them. Remind them before each quarterly deadline, saying what still needs checking. Give a
   quarter summary (CSV + one-page PDF) for their bridging software or accountant.
3. **Bank feed.** Open Banking, so cash-free income and card spending arrive without anyone
   mentioning them. Start with a short spike to pick the provider (TrueLayer, GoCardless Bank
   Account Data, Plaid): cost, licensing, and the 90-day re-consent flow. Match bank lines to
   existing receipt entries so nothing is counted twice.
4. **A proper business onboarding.** For now the assistant asks what the business does and invites
   a first receipt through its prompt. The WhatsApp signup chain (postConnectSetup.ts) could do this
   in scripted steps instead.
5. **Switch edition from the admin Portal.** Today it's a command (`npm run set-edition`).
6. **Receipts in other currencies.** Currently skipped. Convert at the date's rate, or ask.
7. **Brand name and landing page** for the business edition (`brandName` in
   `server/src/editions/index.ts` is a placeholder).
8. **Later:** mileage/simplified expenses (45p a mile), VAT, invoicing and chasing, Xero API sync,
   read-only access for an accountant.
