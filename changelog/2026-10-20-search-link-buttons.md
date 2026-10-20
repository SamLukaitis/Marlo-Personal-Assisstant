On WhatsApp, flight and hotel replies now end with a "View Google Flights" or "View Google Hotels" button instead of the search link typed out.

## What changed

- `server/src/services/linkButton.ts` works out how to send it: the reply minus the line carrying
  the search link, with the button under it (WhatsApp's `cta_url` message, the same one the "Run on
  iPhone" button uses). A reply over WhatsApp's 1,024-character limit for button messages goes out
  as normal text first, followed by a short message with the button.
- `runAssistantChat` (`server/src/ai/assistant.ts`) remembers the `googleFlightsUrl` /
  `googleHotelsUrl` each search returned and attaches a `linkButton` to the reply when exactly one
  of them appears in the text. Comparing two dates gives two search links, and those stay as
  labelled links, because a WhatsApp message can carry only one button of this kind.
- Per-option links (Kiwi.com and Booking.com booking links, a hotel's own website) stay in the
  text as short links, each under its option.
- The flights and hotels rules now ask Marlowe to put the search link on its own last line after
  a short label ("All options:"), which is what the button replaces. If the link is in the middle
  of a sentence instead, the reply is sent as text rather than lose part of the sentence.
- The label is "View Google Flights" rather than "View on Google Flights" because WhatsApp limits
  button text to 20 characters.
- Chat history keeps the full text with the link, so Marlowe still knows what it sent. If the
  button send fails, the reply goes out as plain text. The web chat ignores the button and shows
  the link.
- Kiwi.com and lastminute.com backup results have no overall search link, so they get no button.
