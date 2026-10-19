import { Outlet } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
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

// For public pages a signed-in user also reaches from the sidebar (/features): anyone can open
// them, but someone signed in keeps their sidebar rather than being dropped onto a bare page.
export function OptionalSidebarLayout() {
  const { user, loading } = useAuth();
  if (loading) return null; // same flash-avoidance as RequireAuth — don't pop the sidebar in
  return (
    <>
      {user && <Sidebar />}
      <Outlet />
    </>
  );
}
