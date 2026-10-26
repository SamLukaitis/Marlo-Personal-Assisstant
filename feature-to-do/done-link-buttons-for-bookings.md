# Booking links as WhatsApp buttons

Short `/go/` links (changelog/2026-10-19-short-links-and-chat-voice.md) made flight and hotel
replies tidier, but a link is still a link. WhatsApp can send a message with a single tappable
button under it, such as "View on Google Flights", and the URL then isn't shown at all. Marlo
already does this for phone actions ("Run on iPhone", `server/src/services/phoneActionButton.ts`
and `sendWhatsAppCtaUrl`).

The catch: a WhatsApp button message carries one button, and a flight or hotel reply can have
several links. One way would be to keep per-option links as short links in the text and put only
the main search link (`googleFlightsUrl` / `googleHotelsUrl`) on the button.

**Done 2026-10-20** (changelog/2026-10-20-search-link-buttons.md): the main search link is a
"View Google Flights" / "View Google Hotels" button; per-option links stay in the text.
