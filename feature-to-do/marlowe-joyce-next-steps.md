# Marlowe–Joyce link: what comes next

The link itself (offer, consent, "send this to Joyce", settings, unlink) is built. See
`changelog/2026-10-19-marlowe-joyce-link.md` and
`docs/superpowers/specs/2026-10-19-marlowe-joyce-link-design.md`. Trips and availability (1 and 2
below) are built too: `changelog/2026-10-26-trips-and-availability.md` and
`docs/superpowers/specs/2026-10-26-joyce-trips-and-availability-design.md`. These are the later
projects Sam asked for, each of which uses the bridge in `server/src/bridge/`. Do them one at a time.

1. **DONE: Trip dates to Joyce.** Marlowe knows a person's flights and trips from their email. The family
   should be able to ask Joyce "when is Sam away?" and get dates and destination only (no booking
   references or prices). The setting (ask each time / automatic / off) is already stored; "ask each
   time" is the default. Switching it off should also remove trips already shared.
2. **DONE: Availability checks.** Joyce asks each linked member's Marlowe about proposed dates ("do these
   holiday dates work for everyone?") and tells the group who is free. The answer from Marlowe is
   only free / busy / not sure, never what is on the calendar, and never an open question like
   "what is Sam doing Tuesday?". (Built. Not done: letting members connect Google once, in Marlowe,
   instead of again in Joyce; Joyce's own calendar still needs its own connection.)
3. **Shared expenses and who-owes-who.** A payment the person deliberately hands over ("send this
   to Joyce") becomes a shared family expense so Joyce can total them and say who owes whom. Marlowe
   must never pull payment details out of email by itself.
4. **Forwarded group-chat messages.** People forward things from the family WhatsApp group to Joyce
   so they aren't lost in a long chat. Saving notes and files probably already works; the gap is
   recognising forwarded messages and filing them neatly.
5. **A gentle reminder for people who ignore the offer.** The first version asks once. If wanted, a
   single follow-up a few days later, sent through the attention gate (`services/attention.ts`).

Also open: Joyce members who don't use Marlowe get everything Joyce already did; nothing here
changes that, and it should stay true.
