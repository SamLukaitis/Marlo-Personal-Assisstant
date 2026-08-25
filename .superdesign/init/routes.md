# Routes

Config-based routing via `react-router-dom` (`BrowserRouter`). Full router lives in `client/src/App.tsx`:

```tsx
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthedLayout } from "./components/AuthedLayout";
import { RequireAuth } from "./components/RequireAuth";
import { HomePage } from "./pages/HomePage";
import { OnboardingPage } from "./pages/OnboardingPage";
import { AssistantPage } from "./pages/AssistantPage";
import { SearchPage } from "./pages/SearchPage";
import { ChatsPage } from "./pages/ChatsPage";
import { CalendarPage } from "./pages/CalendarPage";
import { FilesPage } from "./pages/FilesPage";
import { SetupPage } from "./pages/SetupPage";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Public — the sidebar/nav must not render here, there's no hub to navigate yet */}
        <Route path="/" element={<HomePage />} />

        <Route
          path="/onboarding"
          element={
            <RequireAuth>
              <OnboardingPage />
            </RequireAuth>
          }
        />

        {/* Everything below requires a session and gets the normal sidebar layout */}
        <Route
          element={
            <RequireAuth>
              <AuthedLayout />
            </RequireAuth>
          }
        >
          <Route path="/assistant" element={<AssistantPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/inbox" element={<Navigate to="/search" replace />} />
          <Route path="/chats" element={<ChatsPage />} />
          <Route path="/calendar" element={<CalendarPage />} />
          <Route path="/files" element={<FilesPage />} />
          <Route path="/setup" element={<SetupPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

export default App;
```

## Route table

| Path | Component | Layout | Auth | Summary |
|---|---|---|---|---|
| `/` | `HomePage` | none (no sidebar) | public | Marketing/sign-in landing page. Redirects to `/assistant` if already logged in. |
| `/onboarding` | `OnboardingPage` | none (no sidebar) | required | First-run flow right after signup: connect an account + add a WhatsApp number. Always skippable. |
| `/assistant` | `AssistantPage` | `AuthedLayout` (sidebar) | required | Default landing page post-login. Chat with the AI assistant + daily briefing card. |
| `/search` | `SearchPage` | `AuthedLayout` | required | Unified search across mail/files/Teams chats/WhatsApp documents. Also the old "Inbox" (shows recent mail by default before a search). |
| `/inbox` | → redirects to `/search` | — | required | Legacy alias. |
| `/chats` | `ChatsPage` | `AuthedLayout` | required | Microsoft Teams chat search/browse. |
| `/calendar` | `CalendarPage` | `AuthedLayout` | required | Upcoming events across all connected accounts, day-range filter (7/14/30). |
| `/files` | `FilesPage` | `AuthedLayout` | required | Drive/OneDrive/local file search + saved WhatsApp documents list. |
| `/setup` | `SetupPage` | `AuthedLayout` | required | The big settings page: assistant persona, connected accounts, local folders, briefing config, memory notes, WhatsApp config, location check-ins/Schengen tracker, real-time alerts toggle. |

## Page summaries

- **HomePage** (`/`) — Centered, narrow (max 640px), no sidebar. Brand mark, headline, subhead, Google/Microsoft sign-in buttons, 3 feature cards, error/not-invited banners from query params.
- **OnboardingPage** (`/onboarding`) — Two numbered steps (connect account, add WhatsApp number) in cards, "Go to my assistant" CTA + "skip for now" link.
- **AssistantPage** (`/assistant`) — Full-height flex column: title, `BriefingCard`, then a chat scroll area (bubbles) + suggestion chips (shown only when empty) + message input form.
- **SetupPage** (`/setup`) — The longest/densest page: 9 stacked `<h2>` sections, each with its own `.card` — assistant persona, connected accounts, add-account, local folders, morning briefing (with nested news-topic checkboxes), memory notes, WhatsApp, location check-ins (with Schengen day counter banner), real-time alerts, "coming soon". This is the strongest redesign-priority candidate — currently one long undifferentiated scroll with no sub-navigation/tabs.
- **SearchPage** (`/search`) — Search bar, then either "Recent inbox" (default) or up to 4 grouped result sections (Email/Files/Teams chats/WhatsApp documents), each a `.card` of `.list-item` rows.
- **ChatsPage** / **CalendarPage** / **FilesPage** — Same shape: search/filter bar + one `.card` of `.list-item` rows (or day-range buttons for Calendar). FilesPage additionally has a second section listing saved WhatsApp documents with expand/delete actions.

Only 8 routes total, all top-level (no nesting beyond the two layout wrappers). No 404 route defined.
