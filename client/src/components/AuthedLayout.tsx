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
