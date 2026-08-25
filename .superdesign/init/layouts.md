# Shared Layout Components

## `AuthedLayout` — `client/src/components/AuthedLayout.tsx`
Wraps every authenticated route with the sidebar. Rendered as the element of a layout `<Route>` in `App.tsx`; `<Outlet/>` renders the active page.

```tsx
import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";

// Replaces the old unconditional <Sidebar/> rendered as a sibling of <Routes> in App.tsx — the
// sidebar (and everything it implies: connected-account count, nav) must only show once there's
// an actual logged-in hub to navigate, not on the public homepage.
export function AuthedLayout() {
  return (
    <>
      <Sidebar />
      <Outlet />
    </>
  );
}
```

## `Sidebar` — `client/src/components/Sidebar.tsx`
Left nav, fixed width (216px), always visible on authenticated routes. Brand mark links to `/assistant` (the in-app "home"). Shows connected-account count as a status dot in the footer, plus a logout button.

```tsx
import { NavLink, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { fetchAccounts, logout, type Account } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { IconChat, IconCalendar, IconFolder, IconSettings, IconUsers, IconSearch } from "./icons";

export function Sidebar() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const { refresh } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    fetchAccounts().then(setAccounts).catch(() => {});
  }, []);

  const cls = ({ isActive }: { isActive: boolean }) => (isActive ? "active" : "");

  async function handleLogout() {
    await logout();
    await refresh();
    navigate("/");
  }

  return (
    <nav className="sidebar">
      <NavLink to="/assistant" className="brand" style={{ textDecoration: "none" }}>
        <span className="brand-mark">H</span>
        Hub
      </NavLink>
      <NavLink to="/assistant" className={cls}>
        <IconChat />
        Assistant
      </NavLink>
      <NavLink to="/search" className={cls}>
        <IconSearch />
        Search
      </NavLink>
      <NavLink to="/chats" className={cls}>
        <IconUsers />
        Chats
      </NavLink>
      <NavLink to="/calendar" className={cls}>
        <IconCalendar />
        Calendar
      </NavLink>
      <NavLink to="/files" className={cls}>
        <IconFolder />
        Files
      </NavLink>
      <NavLink to="/setup" className={cls}>
        <IconSettings />
        Setup
      </NavLink>
      <div className="footer">
        <span className={`status-dot${accounts.length ? " on" : ""}`} />
        {accounts.length
          ? `${accounts.length} account${accounts.length > 1 ? "s" : ""} connected`
          : "No accounts connected"}
      </div>
      <button className="secondary" style={{ marginTop: 8 }} onClick={handleLogout}>
        Log out
      </button>
    </nav>
  );
}
```

Nav items (icon + label), in order: Assistant (`/assistant`), Search (`/search`), Chats (`/chats`), Calendar (`/calendar`), Files (`/files`), Setup (`/setup`). No top bar, no breadcrumbs, no footer beyond the account-count/logout block. No mobile/collapsed variant exists yet — sidebar is always full-width, no responsive behavior at all currently (no media queries in `index.css`).

## `RequireAuth` — `client/src/components/RequireAuth.tsx`
Not a visual layout, but gates every authenticated route — redirects to `/` if not logged in.

```tsx
import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) return null; // brief flash-avoidance — /api/me hasn't resolved yet
  if (!user) return <Navigate to="/" replace />;
  return <>{children}</>;
}
```

## Page content wrapper — `.main` (CSS class, no component)
Every authenticated page's root div uses `className="main"`: `flex:1; padding:32px 40px; max-width:880px; margin:0 auto`. This is effectively the "page container" layout primitive — centers content in a readable column next to the sidebar. `HomePage` doesn't use `.main` — it inlines its own centered narrow layout (`maxWidth:640, textAlign:center`) since it renders with no sidebar at all.

## Root mount — `client/src/main.tsx`
```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { AuthProvider } from './context/AuthContext.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </StrictMode>,
)
```

`#root` is styled `display:flex; min-height:100vh` in `index.css` — sidebar + `.main` sit side by side as flex children.
