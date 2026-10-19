Someone who uses both Marlowe and Joyce can now link them, and hand notes from Marlowe to their family.

## What changed

Until now Marlowe and Joyce shared nothing, on purpose. This adds an opt-in link between one
person's Marlowe and their Joyce family, built so that nothing private can cross by accident.

- **Offer.** When someone creates or joins a family on Joyce, and their number also has a Marlowe
  account that has messaged Marlowe at least once, Marlowe sends them a message offering to connect.
  Nothing is shared unless they say yes. The "has messaged Marlowe" check is there because a number
  can be attached to an account from the web Settings page without proving the holder uses it.
- **Linking** happens in the Marlowe chat. The person can set two preferences (share trip dates:
  ask each time / automatic / off; let Joyce check if they're free: on / off). Both are stored but
  do nothing yet, since trip sharing and availability checks aren't built.
- **"Send this to Joyce".** Once linked, the person can ask Marlowe to pass something on (a builder's
  number, payment details someone told them). It becomes a note in the family's Joyce space that any
  member can ask for, marked as coming from Marlowe. Marlowe only does this when the person asks in
  chat, never from the contents of an email or document, and never from the web chat.
- **See and undo.** They can ask what they've shared, change the settings, or unlink. Unlinking
  asks whether to also remove the notes they handed over. Leaving the family unlinks automatically
  (the notes stay with the family, like everything else a member added).

## How it's built

A new `server/src/bridge/` module is the only code that imports both products. Joyce still imports
nothing outside `src/joyce/`; she exposes two small hooks (someone joined, someone left) that the
bridge registers at startup. No bridge function or Marlowe tool takes a family or member id: the
family is whoever the person's own phone belongs to. Consent and settings live in Marlowe's database
(`family_links`), and an audit log of what was shared (`family_link_shares`) keeps titles and note
ids, never the content. Joyce stores only a "linked" flag on the member and a `source` marker on
notes. Both new Marlowe tables are cleared by `deleteUserCompletely`.

## Not built yet

Trip dates to Joyce, availability checks, shared expenses (who owes who), filing forwarded
group-chat messages, and a reminder to people who ignore the offer. See `feature-to-do/`.
Design: `docs/superpowers/specs/2026-10-19-marlowe-joyce-link-design.md`.
