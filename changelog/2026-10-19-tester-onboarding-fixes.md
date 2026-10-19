# New testers get a working help link, honest copy and things to try

Before more family members were invited, an audit of the first-run experience found that the
"help" link didn't open for WhatsApp users, several bits of copy promised features Marlowe doesn't
have, and onboarding ended without telling people what to ask.

**Help link:** texting "help" sends a link to `/features`, but that page sat behind sign-in, so a
signed-out visitor was bounced to the homepage, and phone-only users can't sign in at all. The
page is now public (`client/src/App.tsx`). Signed-out visitors see it without the sidebar and
without the on/off tags for optional tools or the "Turn it on in Settings" note, since they have
no tools to switch. Signed-in users still get their sidebar (`OptionalSidebarLayout` in
`client/src/components/AuthedLayout.tsx`).

**Copy that over-promised:**
- Declining to connect email (the phone-only path) promised "to-dos", which Marlowe doesn't have.
  It now lists four things that work with no mailbox: a reminder, a flight search, sending a photo
  of a receipt or booking, and a weather question. The assistant's own instructions for phone-only
  users no longer mention to-dos either.
- The homepage said attachments go to "your dedicated Marlowe inbox" (there isn't one) and that
  documents get filed "into your linked cloud storage" (nothing uploads to Drive or OneDrive). It
  now says you send documents on WhatsApp or ask Marlowe to save an email attachment, and that
  Marlowe saves the details with the original.
- The homepage said "Pick your tools when you sign up". Sign-up happens on WhatsApp and doesn't
  offer that; it now says optional tools stay off until you ask Marlowe or switch them on in
  Settings.

**Features page:** added topics, with example phrases, for flight search, places to stay (Google
Maps plus a Booking.com or Airbnb link with the dates filled in; it says nothing either way about
live hotel prices, which are added separately), app hand-off links (Uber, Lyft, OpenTable, Resy, Spotify, Google Maps), muting one sender
or kind of email, and sending things to Joyce for people linked to a family.

**End of onboarding:** the last message after connecting email was "Anything you need help with
right now, or any questions?", which left new testers guessing. It's now four things to try: the
calendar this week, a flight search, a photo of a receipt or booking, and a reminder
(`sendClosingMessage` in `server/src/services/postConnectSetup.ts`).
