# Marlo website redesign: a real landing page, with the conversation playing inside a phone

The website is now its own page rather than a WhatsApp clone. It opens on a landing hero (the name
Marlo, a one-line description and the number at a sensible size), and as you scroll a phone slides
in and stays on screen while the conversation plays out inside it.

What changed and why:
- **Bubbles swapped.** You are the green bubbles on the right, Marlo is white on the left (they were
  the wrong way round).
- **No WhatsApp wallpaper.** The page uses a dark green and cream palette of its own; only the
  phone screen looks like WhatsApp.
- **Landing hero** with the name, description and number, then a "scroll to see it work" cue.
- **Phone section.** The phone is pinned (CSS sticky) and the page scroll drives a GSAP ScrollTrigger
  timeline that reveals each message and moves the chat up inside the phone. Captions beside or above
  the phone change per conversation (inbox, travel, itinerary).
- **Smoother scroll.** Lenis is softer (lerp 0.085) and the timeline is scrubbed with a short lag.
- **More built out:** a top bar, a "what Marlo does" section and a closing number block.
- Reduced motion or no JavaScript: nothing is pinned; the phone shows a scrollable chat.

Copy for the captions and sections is in `website/src/script.ts` and `website/src/numberBlocks.ts`
and is placeholder-quality, to be reviewed.
