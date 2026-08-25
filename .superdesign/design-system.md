# Design System — Personal AI Assistant Hub

## Product context
A multi-tenant personal AI assistant that sits in front of a user's email (Gmail/Outlook), calendar, files (Drive/OneDrive), Teams chats, and WhatsApp. Users connect their own accounts; the assistant (Claude, with tool-calling) answers questions, drafts email, manages calendar events, extracts data from uploaded documents (boarding passes, licenses, receipts), and tracks travel days. Reachable via a web chat or a dedicated WhatsApp number.

## Jobs to be done
- "What do I need to know right now?" — morning briefing (unread mail, today's calendar, needs-attention flags).
- "Find X across everything I have" — unified search across mail/files/chats/documents.
- "Do this for me" — draft a reply, move a meeting, archive mail, remember a preference.
- "Where's my paperwork" — ask about a previously-sent boarding pass/license/receipt.
- Trust: the tool touches sensitive personal/business accounts, so it must read as **secure, competent, and transparent** — never gimmicky or toy-like. Explicit safety boundaries exist (never sends email, never invites people to events) and should be legible in the UI, not just the README.

## Key pages & architecture
- **Public marketing/sign-in homepage** (`/`) — the only page a logged-out visitor sees. Job: explain the product in one glance and convert to sign-in (Google/Microsoft OAuth, no password).
- **App shell** — persistent sidebar (Assistant, Search, Chats, Calendar, Files, Setup) + a centered content column. Every authenticated page lives inside this shell.
- **Assistant page** (`/assistant`) — the in-app home. Chat interface with the AI assistant, plus a daily briefing card above the chat.
- **Setup page** (`/setup`) — the dense settings page: assistant persona, connected accounts, local folders, briefing config, memory notes, WhatsApp config, location/travel tracking, real-time alerts. Currently one long undifferentiated scroll — the biggest structural opportunity in the redesign.
- Full current-state inventory (routes, components, exact CSS) is in `.superdesign/init/`.

## Visual direction — established brand (as of the `/assistant` redesign round)
The placeholder blue/system-UI identity described in earlier revisions of this file has been
**replaced**. The app now has a real, implemented brand, live in `client/src/index.css` and
already used across the marketing homepage and the redesigned `/assistant`, `/chats`,
`/calendar`, `/files`, `/setup` drafts:

- **Colors**: bg `#fafafa`, surface `#fff`, text `#1a1a1a`, muted `#6b7280`, faint `#9ca3af`,
  brand accent **forest green `#1e3a34`** on mint-foreground `#ecfdf5`, danger `#b91c1c`,
  success `#16a34a`. Sidebar is a separate dark shell: bg `#0d1117`, text `#8b949e`.
- **Fonts**: **General Sans** (400/500/600/700) for body/UI, **Zodiak** (serif, via
  `.heading-font`) for display headings — both loaded as real webfonts (Fontshare), not
  system-UI fallback.
- **Radius**: 4px (sm) / 8px (md) / pill (999px) for fully-rounded controls.
- **Shadows**: subtle — `0 1px 2px rgba(0,0,0,.04)` (sm), `0 4px 16px rgba(0,0,0,.06)` (md).
- **Brand mark**: a lowercase/uppercase "M" wordmark (`Marlowe`), not an icon/logo asset.
- Light mode only today; dark-mode tokens are not yet implemented.

**Treat these as the hard constraint for this round** (per DESIGN SYSTEM FIDELITY) — this is a
real, already-shipped brand now, not an open placeholder. `client/` also has shadcn/ui +
Tailwind v4 wired in, plus two extra shadcn-compatible component registries (`@bklit` for
data-viz, `@kokonutui` for general UI/animation components) and the Motion animation library
installed but not yet used in any page's interaction layer — available as implementation
ingredients once a design is approved, not inputs to the HTML draft itself.

## Requirements for the redesign
- **Trustworthy, capable tone** — this manages real email/calendar/documents. Avoid anything
  playful/toy-like (bright rainbow gradients, cartoon illustration, novelty fonts). Confident
  and clean reads better than loud.
- **Component depth** — button variants, card elevation levels, list-item pattern, badge/tag
  tones, empty states, loading states should stay consistent with what's already established
  rather than reinvented per page.
- **Homepage-specific**: this round is exploring a fully alternate direction for the public `/`
  marketing page specifically — see the per-round brief for whether that exploration stays
  within this brand system or is free to diverge.
