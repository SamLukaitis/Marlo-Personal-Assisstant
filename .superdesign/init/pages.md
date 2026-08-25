# Page Dependency Trees

## / (HomePage) — Public marketing/sign-in
Entry: `client/src/pages/HomePage.tsx`
Dependencies:
- `client/src/context/AuthContext.tsx` (`useAuth`)
- `client/src/api/client.ts` (`loginUrl`)
- react-router-dom (`Navigate`, `useSearchParams`)
- No sidebar/layout — renders standalone, centered column, no `.main` wrapper (custom inline styles)

## /onboarding (OnboardingPage) — First-run setup
Entry: `client/src/pages/OnboardingPage.tsx`
Dependencies:
- `client/src/api/client.ts` (`fetchProviders`, `fetchAccounts`, `fetchWhatsAppAllowedNumbers`, `saveWhatsAppAllowedNumbers`, `loginUrl`, types `ProviderInfo`, `Account`)
- No sidebar (rendered outside `AuthedLayout`)
- Uses `.main`, `.card`, `.row`, `.banner`, `.list-item` CSS classes

## /assistant (AssistantPage) — Main chat / in-app home
Entry: `client/src/pages/AssistantPage.tsx`
Dependencies:
- `client/src/components/icons.tsx` → `IconSend`
- `client/src/components/BriefingCard.tsx`
  - `client/src/api/client.ts` (`fetchBriefing`, `fetchBriefingSettings`, `refreshBriefing`, type `Briefing`)
- `client/src/api/client.ts` (`fetchSettings`, `sendChatMessage`, type `ChatMessage`)
- Rendered inside `AuthedLayout` → `Sidebar`
- Uses `.main`, `.chat-wrap`, `.chat-scroll`, `.bubble`, `.chips`, `.row`

## /search (SearchPage) — Unified search
Entry: `client/src/pages/SearchPage.tsx`
Dependencies:
- `client/src/api/client.ts` (`fetchSearchAll`, `fetchMessages`, `documentFileUrl`, types `SearchResults`, `UnifiedMessage`)
- Rendered inside `AuthedLayout` → `Sidebar`
- Uses `.main`, `.card`, `.list-item`, `.badge`, `.row`, `.title`/`.title.unread`, `.sub`

## /chats (ChatsPage) — Teams chat browse/search
Entry: `client/src/pages/ChatsPage.tsx`
Dependencies:
- `client/src/api/client.ts` (`fetchChats`, type `ChatThread`)
- Rendered inside `AuthedLayout` → `Sidebar`
- Uses `.main`, `.card`, `.list-item`, `.badge`, `.row`

## /calendar (CalendarPage) — Upcoming events
Entry: `client/src/pages/CalendarPage.tsx`
Dependencies:
- `client/src/api/client.ts` (`fetchEvents`, type `CalendarEvent`)
- Rendered inside `AuthedLayout` → `Sidebar`
- Uses `.main`, `.card`, `.list-item`, `.badge`, `.row`, day-range toggle buttons (`.secondary` variant for inactive)

## /files (FilesPage) — File search + WhatsApp documents
Entry: `client/src/pages/FilesPage.tsx`
Dependencies:
- `client/src/components/icons.tsx` → `IconTrash`
- `client/src/api/client.ts` (`fetchFiles`, `fetchDocuments`, `documentFileUrl`, `deleteDocument`, types `FileHit`, `StoredDocument`)
- Rendered inside `AuthedLayout` → `Sidebar`
- Uses `.main`, `.card`, `.list-item`, `.badge`, `.row`

## /setup (SetupPage) — Settings (largest page)
Entry: `client/src/pages/SetupPage.tsx`
Dependencies:
- `client/src/components/icons.tsx` → `IconTrash`, `IconPlus`
- `client/src/api/client.ts` — large surface: `fetchProviders`, `fetchAccounts`, `fetchSettings`, `saveSettings`, `disconnectAccount`, `loginUrl`, `fetchLocalFolders`, `addLocalFolder`, `removeLocalFolder`, `fetchBriefingSettings`, `saveBriefingSettings`, `fetchMemoryNotes`, `addMemoryNote`, `removeMemoryNote`, `fetchWhatsAppStatus`, `fetchWhatsAppAllowedNumbers`, `saveWhatsAppAllowedNumbers`, `fetchCheckins`, `fetchTravelDays`, `fetchAlertSettings`, `saveAlertSettings`, `NEWS_TOPIC_LABELS`, plus ~9 types
- Rendered inside `AuthedLayout` → `Sidebar`
- Uses `.main`, `.card`, `.banner`, `.error`, `.list-item`, `.badge`, `.row`, checkboxes, `<input type="time">`
- 9 sections, each its own `<h2>` + `.card`: assistant persona, connected accounts, add account, local folders, morning briefing (+ nested news topics), memory notes, WhatsApp, location check-ins (+ Schengen banner), real-time alerts, coming soon

## Shared across ALL authenticated pages
- `client/src/components/AuthedLayout.tsx` → `client/src/components/Sidebar.tsx` → `client/src/components/icons.tsx` (6 nav icons) + `client/src/context/AuthContext.tsx` + `client/src/api/client.ts` (`fetchAccounts`, `logout`)
- `client/src/index.css` (global, no per-component CSS files)

## Root
- `client/src/App.tsx` → `client/src/components/RequireAuth.tsx` (wraps every route except `/`) + `client/src/components/AuthedLayout.tsx` (wraps every route except `/` and `/onboarding`)
- `client/src/main.tsx` → `client/src/context/AuthContext.tsx` (`AuthProvider`) wraps `App`
