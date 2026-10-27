# Marlo website now uses the pitch deck's colours and typeface

The website looks like the pitch deck: white and pale-blue backgrounds, cobalt blue accents and
DM Sans. Layout, copy and scroll behaviour are unchanged.

What changed (all in `website/src/styles.css`, plus the font link in `website/index.html`):
- **Palette from the deck:** cobalt blue `#1f4bd8` (replaces the WhatsApp green accent), near-black
  `#0b0b0c` text, grey `#4a4f57` secondary text, pale blues `#f3f6fb` and `#dce5f8` for section
  backgrounds. The dark green and cream backgrounds are gone.
- **Typeface:** DM Sans everywhere (was Archivo condensed plus Source Sans 3). The big "Marlo" and the
  number are blue / in a blue pill like the deck's title and tags.
- **Phone mock-up** matches the deck's: black frame, light grey chat screen, light header with a blue
  back arrow and avatar, outlined blue send circle. The bubbles stay green (you) and white (Marlo),
  as in the deck.

The colours are CSS variables at the top of `styles.css`, so tweaking them is one place.
