# Marlo Website Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single-page public site where one long WhatsApp-style conversation plays out as you scroll, with Marlo's number as the biggest, always-visible thing.

**Architecture:** A static Vite site in `website/` (vanilla TypeScript, no framework). The conversation lives as data in one module; a small renderer turns it into DOM; a scroll module (Lenis + GSAP ScrollTrigger) reveals messages one at a time. Number and link come from one config value.

**Tech Stack:** Vite, TypeScript, `lenis`, `gsap` (ScrollTrigger), Vitest + jsdom.

**Spec:** `docs/superpowers/specs/2026-10-26-marlo-website-design.md`

## Global Constraints

- Number: `+44 7552 639982`, link `https://wa.me/447552639982`, defined once in `website/src/config.ts`.
- Name on the page is "Marlo". Marlo's lines are professional, to the point and concise.
- No signup, login, forms, pricing, email capture or any button other than the "Message" link.
- Story order: email sorting and replying, then comparing travel options, then itineraries.
- Look: real WhatsApp feel (green, bubbles, chat-wallpaper texture) with its own writing and type.
- Banned: purple/indigo gradients, gradient text, glassmorphism/glow, Inter, three identical icon cards, "Get Started" copy, cream + terracotta, near-black + neon accent, tracked-out all-caps labels above headings, fade-and-slide-up on every section, hover effects everywhere.
- Mobile first: 16px gutters, no horizontal scroll, visible keyboard focus, readable contrast.
- `prefers-reduced-motion`: show the full thread statically.
- Light: no video, no large images. Stays out of `client/` and `server/`.
- Before styling, invoke the `frontend-design` skill; before scroll code, use the `gsap-scrolltrigger` skill.

## Review Focus

- JavaScript disabled or failing to load: the full thread and the number must still be readable (script is progressive enhancement).
- Very narrow phone (320px) and very wide desktop: number never wraps awkwardly or overflows; thread stays a readable column.
- Reduced-motion visitor: every message visible immediately, no pinned/scrubbed behaviour.
- Fast scroll or jump (anchor, refresh mid-page, resize): messages above the viewport are already shown, none stuck hidden.
- Screen reader: conversation reads in order as a list of messages with who said it; the number link has a clear label.

---

### Task 1: Scaffold `website/` with config and tests

**Files:**
- Create: `website/package.json`, `website/index.html`, `website/tsconfig.json`, `website/vite.config.ts`, `website/src/main.ts`, `website/src/config.ts`
- Test: `website/src/config.test.ts`

**Interfaces:**
- Produces: `config.ts` exports `PHONE_DISPLAY: string`, `PHONE_E164_DIGITS: string`, `waLink(): string`.

- [ ] **Step 1: Write the failing test** in `config.test.ts`: `waLink()` equals `https://wa.me/447552639982`; `PHONE_DISPLAY` equals `+44 7552 639982`; `PHONE_E164_DIGITS` is digits only.
- [ ] **Step 2: Run** `npm test --prefix website` — expect FAIL (module missing).
- [ ] **Step 3: Scaffold** a Vite vanilla-ts project in `website/` (own `package.json`, own lockfile; deps `gsap`, `lenis`; dev deps `vitest`, `jsdom`, `typescript`, `vite`; scripts `dev`, `build`, `test`). Implement `config.ts`. `index.html` has a `<title>`, viewport meta, `lang="en"`, and an empty `<main id="thread">`.
- [ ] **Step 4: Run** `npm test --prefix website` and `npm run build --prefix website` — expect PASS and a `dist/` folder.
- [ ] **Step 5: Commit** `feat(website): scaffold Marlo site with number config`.

### Task 2: Conversation script as data

**Files:**
- Create: `website/src/script.ts`
- Test: `website/src/script.test.ts`

**Interfaces:**
- Produces: `type Message = { from: "you" | "marlo"; text: string; time: string }`; `type Scene = { id: "email" | "travel" | "itinerary"; messages: Message[] }`; `export const scenes: Scene[]` in that order.

- [ ] **Step 1: Write failing tests:** scene ids are exactly `["email","travel","itinerary"]` in order; every scene alternates starting with `you`; every `marlo` message is at most 220 characters and contains no exclamation mark and no emoji; `time` matches `/^\d{1,2}:\d{2}$/`.
- [ ] **Step 2: Run** the tests — expect FAIL.
- [ ] **Step 3: Write `scenes`:** email (ask to sort inbox, Marlo reports counts and the items needing a reply, user approves a drafted reply, Marlo sends it); travel (Lisbon vs Porto for 4 days, Marlo recommends one with price and reason, flights and hotel shortlist); itinerary (day-by-day plan, sent on to a named person). Specific and believable, concise professional voice, 4–6 messages each.
- [ ] **Step 4: Run** the tests — expect PASS.
- [ ] **Step 5: Commit** `feat(website): write the conversation script`.

### Task 3: Render the thread (no styling yet)

**Files:**
- Create: `website/src/render.ts`
- Modify: `website/src/main.ts`
- Test: `website/src/render.test.ts`

**Interfaces:**
- Consumes: `scenes`, `Message`, `Scene` from `script.ts`; `PHONE_DISPLAY`, `waLink` from `config.ts`.
- Produces: `renderThread(root: HTMLElement, scenes: Scene[]): void`. Each scene is `<section id="{scene.id}">`; each message is `<li class="msg msg--you|msg--marlo">` inside an `<ol>` with `aria-label`; each li contains the sender in visually hidden text ("You said", "Marlo said"), the text, and the time.

- [ ] **Step 1: Write failing tests** (jsdom): rendering the real `scenes` yields one section per scene and one `li` per message in order; sender text is present for screen readers; the output contains no `<button>`, `<form>` or `<input>`.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement `renderThread`;** `main.ts` calls it on `#thread`.
- [ ] **Step 4: Run** — expect PASS; `npm run build --prefix website` succeeds.
- [ ] **Step 5: Commit** `feat(website): render the conversation thread`.

### Task 4: Number, pinned bar and closing line

**Files:**
- Create: `website/src/numberBlocks.ts`
- Modify: `website/src/main.ts`, `website/index.html`
- Test: `website/src/numberBlocks.test.ts`

**Interfaces:**
- Consumes: `PHONE_DISPLAY`, `waLink` from `config.ts`.
- Produces: `renderNumberBlocks(): void` which fills three places: hero (`#hero`, number at the largest size on the page with one line of plain copy), pinned bar (`#bar`, `position: sticky` at the top with the number and a "Message" `<a>`), closing (`#close`, number large again). All three number links use `waLink()`, `href` set, `aria-label="Message Marlo on WhatsApp"`.

- [ ] **Step 1: Write failing tests:** all three blocks exist; each contains `+44 7552 639982`; every link `href` equals `waLink()`; the only interactive elements on the page are `<a>` links to that URL (no buttons, forms, inputs).
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** `renderNumberBlocks`; hero and closing copy short and plain (e.g. one sentence on what Marlo does; the closing line is the number alone).
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(website): number hero, pinned bar and closing line`.

### Task 5: Visual design (WhatsApp feel, own voice)

**Files:**
- Create: `website/src/styles.css`
- Modify: `website/index.html` (font links), `website/src/main.ts` (import css)

**Interfaces:**
- Consumes: classes from Tasks 3–4 (`.msg`, `.msg--you`, `.msg--marlo`, `#hero`, `#bar`, `#close`).

- [ ] **Step 1: Invoke the `frontend-design` skill,** then write a short design plan (4–6 named hex colours, type roles, layout sketch) and check it against the Global Constraints banned list; revise anything that reads as a default.
- [ ] **Step 2: Implement `styles.css`:** colour tokens on `:root`; chat-wallpaper texture as a subtle repeating pattern (CSS or small inline SVG); bubbles with tails and timestamps; a single readable column (max ~34rem) centred on wide screens; hero number sized by `clamp()` so it never wraps at 320px; sticky bar; `:focus-visible` outlines; `prefers-reduced-motion` respected.
- [ ] **Step 3: Verify in the browser** (`npm run dev --prefix website`, Claude in Chrome): screenshots at 320px, 390px and 1440px; no horizontal scroll; number the biggest element; text contrast at least AA. Fix and re-shoot until all three look right.
- [ ] **Step 4: Commit** `feat(website): WhatsApp-feel visual design`.

### Task 6: Scroll reveal with Lenis and ScrollTrigger

**Files:**
- Create: `website/src/scroll.ts`
- Modify: `website/src/main.ts`
- Test: `website/src/scroll.test.ts`

**Interfaces:**
- Consumes: `li.msg` elements from Task 3.
- Produces: `initScroll(root: HTMLElement): () => void` (returns cleanup). Pure helper `shouldAnimate(): boolean` returns false when `matchMedia("(prefers-reduced-motion: reduce)")` matches.

- [ ] **Step 1: Write failing tests:** `shouldAnimate()` is false under a mocked reduced-motion match and true otherwise; with reduced motion, `initScroll` leaves every `.msg` visible (no inline hidden state) and creates no ScrollTrigger.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement `initScroll`** following the `gsap-scrolltrigger` skill: Lenis driven from the GSAP ticker (`lenis.on("scroll", ScrollTrigger.update)`), one ScrollTrigger per message that reveals it as it nears the viewport middle, messages already above the viewport on load/refresh/resize shown immediately (`ScrollTrigger.refresh()` on resize), hidden state applied only by JS so no-JS visitors see everything. Use a quiet reveal (opacity plus small settle), not slide-up on everything else. Clean up on return.
- [ ] **Step 4: Run** tests — expect PASS. Then in the browser: scroll slowly, scroll fast, reload mid-page, resize, and toggle reduced motion; confirm no message stays hidden.
- [ ] **Step 5: Commit** `feat(website): scroll-driven message reveal with Lenis and GSAP`.

### Task 7: Docs and final checks

**Files:**
- Modify: `README.md` (add a short "Public website" section: what it is, `npm run dev|build --prefix website`)
- Create: `changelog/2026-10-26-marlo-website.md`

- [ ] **Step 1: Run** `npm test --prefix website`, `npm run build --prefix website`, and the server tests (`npm test --prefix server`) — all pass.
- [ ] **Step 2: Check each Review Focus line in the browser** (JS disabled via devtools, 320px, reduced motion, fast scroll, screen-reader order); fix any failure.
- [ ] **Step 3: Write the README section and changelog entry** (one-line summary first, then what and why).
- [ ] **Step 4: Commit** `docs: add Marlo website to README and changelog`.

---

## Self-review

- **Spec coverage:** thread structure (Tasks 2–3), huge number + pinned + closing (4), WhatsApp look and type (5), Lenis/GSAP and one-by-one reveal (6), reduced motion (5, 6), no-JS (6), `website/` folder and number in one config value (1), docs (7). QR code and hosting/domain are deliberately out (optional / open in the spec).
- **Types:** `Message`, `Scene`, `renderThread`, `renderNumberBlocks`, `initScroll`, `shouldAnimate`, `waLink`, `PHONE_DISPLAY` are named identically wherever used.
- **Proportion:** tasks give signatures, test names and assertions; bodies and CSS are left to the builder.
