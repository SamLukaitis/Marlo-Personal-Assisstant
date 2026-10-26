# Marlo public website — design

## Intent

A new public website that shows what Marlo does by scrolling, and gets people onto Marlo by one
route only: texting its WhatsApp number. Marlo is a personal assistant, so the page should feel
like a person made it, not like a generated SaaS template.

## Goals

- A visitor understands within one scroll what Marlo does, led by **email sorting and replying**,
  then **comparing travel options**, then **organising itineraries**.
- The **WhatsApp number is the biggest thing on the page**: huge at the top, pinned on screen the
  whole way down, and large again as the closing line.
- The scrolling itself is the demo: the page is one long WhatsApp-style conversation that plays
  out as you scroll.

## Non-goals

- No signup, login, forms, pricing, email capture or other buttons. The only action is messaging
  the number.
- Not a replacement for the existing app (`client/`) or its onboarding. It sits in front of it.
- No blog, docs, multiple pages or CMS.

## Anti-goals (a failure even if it works)

- Looking AI-generated: purple/indigo gradients, gradient headline text, liquid glass /
  glassmorphism, glows, Inter, three identical icon cards in a row, "Get Started" buttons, vague
  buzzword headlines. Also avoid the other common tells: cream background with a terracotta
  accent and a high-contrast serif; near-black page with one neon accent; identical rounded cards
  with the same soft shadow; tracked-out all-caps labels above every heading.
- Looking like a WhatsApp advert or a pixel copy of WhatsApp. It should be recognisably that
  world with its own writing and type.
- Fade-and-slide-up on every section, or hover effects on everything.

## Decided with the user

- **Structure:** option A — the page is one long text thread. Number pinned somewhere at all
  times (user: "keep the number pinned somewhere").
- **Look:** "looks like the app it lives in" — real WhatsApp feel: the green, bubbles, chat
  wallpaper texture.
- **Voice:** Marlo talks professionally, to the point, concise, like a good PA. User messages
  are short and natural. Copy is plain and specific, no marketing language.
- **Story order:** email first (most useful), then travel comparison, then itineraries.
- **Tooling:** Lenis (smooth scroll) + GSAP ScrollTrigger for the scroll. GSAP skills installed in
  `~/.claude/skills/`.

## My calls (the user has not seen or agreed to these — check them)

- **Folder:** a separate `website/` folder in this repo, plain HTML/CSS/JS built with Vite, kept
  out of `client/` and `server/`. Static output, so it can be hosted anywhere.
- **Phone vs desktop:** the number is +44 7552 639982, linked as `https://wa.me/447552639982`. On desktop it also shows
  as plain text, with a QR code to scan *(optional, builder's call)*.
- **Messages appear one by one as you scroll** over a chat-wallpaper background, rather than all
  at once. This is the page's one memorable motion; everything else stays still.
- **Reduced motion:** with `prefers-reduced-motion`, show the full thread statically.
- **Pinned bar:** a slim bar at the top with the number and a "Message" link.
- **Name:** the user writes "Marlo"; the repo and docs say "Marlowe". The site uses "Marlo" as the
  user wrote it; confirm before launch.

## Constraints

- Works well on phones first (most visitors arrive from a link on a phone), 16px gutters, no
  horizontal scroll, visible keyboard focus, readable contrast.
- Light and fast: no heavy video, no large images.
- The WhatsApp number is a single config value so it can change without touching the markup.

## Left to the builder

- Exact typefaces (distinctive, not Inter or a default system sans for display; a human-feeling
  choice that suits the WhatsApp world), colour values, spacing, and bubble styling.
- The actual conversation scripts (short, believable, specific: a real-looking inbox sort, a
  Lisbon-vs-Porto comparison, a day-by-day itinerary). Placeholder content is fine until reviewed.
- Whether to add a small closing line under the final number; hosting; the QR code.

## Open items

- Hosting location and domain.
