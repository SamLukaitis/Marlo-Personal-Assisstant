# Marlo website: scenes match what Marlo really does, and a QR code to the chat

The website's three example conversations now only show things Marlo can actually do, and the page
has a QR code that opens the WhatsApp chat.

What changed (all in `website/`):
- **Travel scene replaced.** It showed Marlo holding a flight for 20 minutes and filling in booking
  details, which it can't do (it searches and links; nothing is booked). The three scenes are now
  inbox, documents (send a receipt photo, find it later) and trips (bookings spotted in email, with a
  reminder).
- **Email scene corrected.** Marlo asks before sending a reply, and only moves events on the user's
  own calendar, so it no longer says the invite was moved.
- **Itinerary scene removed.** Marlo can't send an itinerary to a person (only to Joyce's family) and
  doesn't check you in for flights.
- **QR code** in the hero and the closing section, drawn as inline SVG by `qrcode-generator` from
  the number in `src/config.ts`, linking to `https://wa.me/<number>`.
- Hero and page description copy no longer promise "plans your trips".

Conversation text is still in `website/src/script.ts` and is placeholder-quality.
