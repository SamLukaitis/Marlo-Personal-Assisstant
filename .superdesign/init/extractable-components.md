# Extractable Components (for Superdesign DraftComponents)

## Layout Components (appear on most/all pages)

## Sidebar
- Source: `client/src/components/Sidebar.tsx`
- Category: layout
- Description: Left nav shell for all authenticated pages — brand mark, 6 nav links, connected-account status footer, logout button
- Extractable props: `activeItem` (string — driven today by `NavLink`'s own active-match, not a prop), `accountCount` (number, from `fetchAccounts()`), `accountsConnected` (boolean, drives status dot color)
- Hardcoded: "Hub" brand text, "H" brand-mark letter, nav item labels/icons/order, "Log out" button text

## AuthedLayout
- Source: `client/src/components/AuthedLayout.tsx`
- Category: layout
- Description: Thin wrapper — renders `Sidebar` + `<Outlet/>` side by side via `#root`'s flex
- Extractable props: none (purely structural)

## PageShell (implicit — the `.main` div pattern, not its own file)
- Source: repeated inline in every page (`<div className="main">`)
- Category: layout
- Description: Centered content column (max-width 880px) used by every authenticated page except the chat page's full-height variant
- Extractable props: `maxWidth`, `title` (currently a bare `<h1>{title}</h1>` at the top of every page)
- Hardcoded: padding values

## Basic Components (used across pages)

## Card (CSS class `.card`, not a component)
- Source: `client/src/index.css` (`.card` rule) — every page wraps content sections in `<div className="card">`
- Category: basic
- Description: White bordered surface, the universal content container
- Extractable props: none currently (would benefit from becoming a real `<Card>` component with padding/elevation variants)

## ListItem (CSS class `.list-item`, not a component)
- Source: `client/src/index.css` (`.list-item`, `.title`, `.sub` rules) — repeated JSX shape across SearchPage, ChatsPage, CalendarPage, FilesPage, SetupPage
- Category: basic
- Description: A row with title (+ optional badge + unread dot) and one or two muted sub-lines, wrapped in a link
- Extractable props: `title`, `badge`, `subLines` (string[]), `unread` (boolean), `href`
- Hardcoded: layout structure duplicated per-page instead of a shared component — strong candidate to actually extract into a real `<ListItem>` component during the redesign, not just a Superdesign draft

## Badge (CSS class `.badge`, not a component)
- Source: `client/src/index.css`
- Category: basic
- Description: Small bordered pill, used for account email tags, provider names, source labels ("from document" / "phone")
- Extractable props: `children`, `tone` (currently always neutral/muted — no color variants exist)

## Banner (CSS class `.banner`, not a component)
- Source: `client/src/index.css`, with inline style overrides for the error variant (`background: var(--danger-soft); color: var(--danger)`) seen in `HomePage.tsx`
- Category: basic
- Description: Inline message strip — info (accent-tinted) or error (danger-tinted, via inline override)
- Extractable props: `tone` ("info" | "error" | "success" — success doesn't exist as a variant yet), `children`

## BriefingCard
- Source: `client/src/components/BriefingCard.tsx`
- Category: basic (page-specific but self-contained)
- Description: Fetches and displays the daily AI-generated briefing with a Refresh button; self-manages loading/error/empty states
- Extractable props: none needed — it's fully self-contained (fetches its own data)
- Hardcoded: "Today's briefing" title, "Refresh"/"Refreshing…" button text

## Chat message bubble (CSS classes `.bubble.user` / `.bubble.assistant`, not a component)
- Source: `client/src/index.css` + inline map in `AssistantPage.tsx`
- Category: basic
- Description: Asymmetric rounded message bubble, right-aligned/dark for user, left-aligned/light-bordered for assistant
- Extractable props: `role` ("user" | "assistant"), `content` (string)

## Buttons (plain `<button>` + className, not a component)
- Source: `client/src/index.css` (base + `.secondary` + `.danger` rules)
- Category: basic
- Description: 3 visual variants via className only — no `<Button>` component, no size variants, no icon-button variant (icon+text buttons just use inline `style={{display:"flex", gap:6}}`), no loading-state built in (buttons manually get `disabled` + label text swap)
- Extractable props (if formalized): `variant` ("primary" | "secondary" | "danger"), `loading`, `icon`

## Provider connect card (repeated inline JSX, not a component)
- Source: repeated in `OnboardingPage.tsx` and `SetupPage.tsx` — `<div className="card row">` with provider label + Connect/Not configured button
- Category: basic
- Description: Shows one OAuth provider (Google/Microsoft) with its connect CTA or "not configured" disabled state
- Extractable props: `label`, `configured` (boolean), `loginPath`
