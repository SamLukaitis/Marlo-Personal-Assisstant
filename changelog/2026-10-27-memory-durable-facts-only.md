# Marlo stops remembering passing details

Marlo's memory had filled up with things that were only true for a day: trip itineraries, where the
user was at 1am, emails that arrived, booking numbers, eSIM price comparisons, even a TikTok
verification code. Sam's account had dozens of these. They crowd out real facts and get recalled as
if still current.

Why: there are two ways a fact gets saved. Background extraction (`services/memoryExtraction.ts`)
already had a "durable facts only" rule, but the assistant's own `remember` tool was told to save
"whenever the user shares something worth recalling later", with no limit on what counts. Most of
the junk came through that path.

What changed:
- The `remember` tool description and the system prompt now say what NOT to save (one-off plans,
  current location, emails received, bookings, prices, reminders, codes), and "when in doubt, don't".
- The extraction prompt spells out the same list (`DURABILITY_RULES`, shared with the audit script).
- `services/memoryGuard.ts` rejects, in code, any fact containing a one-time code/PIN or precise GPS
  coordinates, on both paths. The `remember` tool returns an error so the model knows it wasn't saved.
- `npm run memory:audit -- PHONE` lists an account's existing facts that break these rules (the
  guard plus a Haiku pass), as a dry run. `--forget 12,15,...` then forgets the ids you choose, the
  same soft forget as the Setup page's Forget button. On production it runs over `railway ssh` as
  `node dist/scripts/memoryAudit.js PHONE`.
