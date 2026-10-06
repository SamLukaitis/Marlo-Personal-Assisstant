# Marlowe messages less, says more, and reminds at the right time

Marlowe used to message the user about almost every booking, delivery, renewal and document match
the moment the email arrived, often several times for the same event, and some messages were vague
("an email about your booking came in — worth a look?"). It now behaves more like a PA: it
interrupts only for what can't wait, turns bookings and bills into reminders at the moment they
matter, and mentions everything else once, in the briefing or evening recap.

## What changed

- **One gatekeeper for every unprompted message** (`server/src/services/attention.ts`, rules in
  `attentionRules.ts`, rows in the new `attention_items` table). Each event gets one tier:
  - *interrupt now*: flight changes/cancellations, genuine security alerts, government mail that
    needs action, bills due within 2 days;
  - *scheduled reminder*: bookings (flight check-in the day before, hotel on check-in morning),
    subscription renewals (3 days before they charge), bills (2 days before they're due);
  - *briefing/recap*: refunds, delivery problems, anything not urgent;
  - *dropped*: routine delivery progress, repeats.
- **One event, one message.** The booking email, the venue's own confirmation and a saved document
  about the same booking merge by reference/flight number/merchant and date. A second, different
  change to the same flight is still sent.
- **At most 4 interrupting messages a day** (flight changes, security alerts and "ping me for every
  email" don't count). Over the cap, items wait for the next briefing or evening recap; nothing is
  dropped.
- **Quiet hours 22:00–07:00** in the user's timezone. Only flight changes break through. Anything
  held overnight goes out as one combined message in the morning, or inside the morning briefing if
  that's sent between 07:00 and 09:00.
- **Concrete or not at all.** A message without a specific (name, date, amount, reference) or with
  phrases like "worth a look" / "check your inbox" is never sent on its own; it goes to the briefing.
- **The briefing and evening recap acknowledge what Marlowe filed** ("noted your Netflix renewal on
  3 Oct — I'll remind you on the 30th"). Both keep the prose voice from the briefing rewrite; the
  attention items and each sender's gist ("wants to move Thursday's call; needs a reply") are fed to
  them as facts.
- Each flagged email now gets one small extra Haiku call that reads the full body, so reminders use
  the email's real dates and times.
- Removed: the "📎 an email about your X came in" ping, the separate trip-prep pings (now
  reminders), and the "N important-looking emails came in while we were setting up" message.

Design: `docs/superpowers/specs/2026-09-28-attention-gate-design.md`.

## Known gaps

- `attention_items` rows are never pruned.
- If a flight-change email arrives before that flight's booking confirmation, no check-in reminder is
  scheduled.
- Cap and quiet hours are fixed constants; there's no setting for them yet.
