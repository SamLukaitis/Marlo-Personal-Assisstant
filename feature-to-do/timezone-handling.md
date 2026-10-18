# Timezone handling needs more work

Briefings, the email digest and reminders are meant to arrive at the right local time for each
user. They can still go wrong, and this needs a proper look.

## How it works today

A user's timezone comes from, in order:

1. what they picked in Settings;
2. otherwise the most recent location they shared on WhatsApp, or their latest travel check-in;
3. otherwise a guess from their phone number's country (US/Canada by area code).

## Where it falls short

- It doesn't follow someone who travels unless they share a location.
- The phone-number guess is wrong for people living outside their number's country, such as a UK
  number used by someone in Spain.
- When it's only guessing, the user is told which zone was assumed, but nothing prompts them to fix it.

The exact problems still need pinning down before planning a fix.
