# 2026-10-04 — Catch-up: what changed from late August to early October

One-line version: Marlowe became much better on WhatsApp (phone-only sign-up, a daily email
digest, a proper memory, maps, a rewritten briefing), and a second assistant, Joyce, was built for
families.

This one entry covers about six weeks of work, because the changelog wasn't kept up during that
time. From here on, each feature gets its own entry as it ships. The commit history has the
detail behind every item.

---

## WhatsApp sign-up and phone-only accounts (late Aug – mid Sept)

- Setup happens through tap-to-answer buttons and lists instead of typed replies.
- Someone can sign up with **just a phone number** and connect a mailbox later, or never.
- Invites are by phone number, not email. Numbers that message without an invite go on a
  waitlist that admins can see in Settings.
- Smaller improvements: a typing indicator, emoji reactions, replies to quoted messages are
  understood, and quick bursts of messages are answered together.

## Email alerts, digest and Outlook (Sept)

- "A real person emailed you" alerts no longer fire for marketing mail or repeat confirmations.
- Emails from real people are now grouped into **one daily digest** by default, which can be
  switched from WhatsApp. Important automated mail (flights, bookings) still arrives straight away.
- Marlowe always shows an email before sending it. The confirmation now names the real recipient
  and warns when the address is one it hasn't seen before.
- **Outlook is at parity with Gmail**, including sending. It retries when Microsoft throttles the
  mailbox and only fetches new mail in the background.
- A new tool unsubscribes the user from promotional senders.

## Personal memory (23 Sept)

- The old memory notes became a structured store of facts about the user's life, with people,
  places and things linked together.
- Marlowe picks up lasting facts from WhatsApp chats in the background, keeps a short core
  profile, and brings up the facts relevant to each message.
- Users can correct or forget things from chat, including forgetting a whole person or thing.

## Reminders and time (mid – late Sept)

- Reminders can repeat, keep nudging until the user replies, and follow the user's timezone.
- Briefings and the digest run on the user's own clock instead of the server's.
- A timezone now comes only from a Settings pick, a shared location or a check-in, or a guess
  from the phone number. The assistant no longer guesses one itself, after a UK reminder fired an
  hour late. **This still needs work** (see `feature-to-do/timezone-handling.md`).

## Maps (26 Sept)

- With a Google Maps key, Marlowe finds real nearby places and travel times, and can ask for the
  user's location with a one-tap "Send location" button on WhatsApp.

## Briefing rewrite (30 Sept – 3 Oct)

- The morning briefing was rewritten to sound natural and to talk about people rather than email
  subject lines. The evening recap is now written the same way.
- Admins can judge drafts in the new **Briefing Lab** page, and send a briefing on demand from
  the **WhatsApp Simulator**, an admin tool for testing conversations without the live number.

## Joyce, the family assistant (3 Oct)

- A separate WhatsApp assistant for families, on her own number. She saves notes, photos and
  documents, and any member of the family can search them.
- Joyce shares nothing with Marlowe. Each family has its own database file and its own encryption
  key. She stays switched off until her settings are filled in.

## Also on 4 Oct

- A **Features page** in the web app explains what Marlowe can do, with example things to say.
- A **data safety review** (`feature-to-do/data-safety-review.md`) records what's encrypted and
  what isn't, the biggest risks, and what's needed before a wider launch.
