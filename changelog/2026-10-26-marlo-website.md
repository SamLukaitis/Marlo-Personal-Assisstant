# New public website: one scrolling conversation and the number to message

Marlo now has a public website in `website/` that shows what it does as a WhatsApp-style
conversation that plays out as you scroll: sorting email, comparing travel options, planning an
itinerary. There are no signup buttons or forms; the only way in is to message +44 7552 639982.

The number is the biggest thing on the page, pinned in a bar at the top, and repeated as the
closing line. Messages appear one at a time using Lenis (smooth scroll) and GSAP ScrollTrigger.
With reduced-motion settings on, everything shows at once; with JavaScript off, the number and a
line of explanation still show.

The look follows the WhatsApp app (green, bubbles, chat wallpaper) with Archivo for the numbers
and Source Sans 3 for messages. It is a static site (`npm run build --prefix website`); hosting
and domain are not decided yet. The conversation text is in `website/src/script.ts` and is
placeholder-quality copy to be reviewed.
