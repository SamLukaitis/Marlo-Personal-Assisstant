import { NavLink, useNavigate } from "react-router-dom";
import { useEffect, useState, type ReactElement } from "react";
import { fetchAccounts, logout, type Account, type Tool } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { useTools } from "../context/ToolsContext";
import {
  IconAssistant,
  IconChat,
  IconCalendar,
  IconFolder,
  IconTravel,
  IconSettings,
  IconLogOut,
  IconPortal,
} from "./icons";

interface NavItem {
  to: string;
  label: string;
  Icon: () => ReactElement;
  /** When set, this item only appears if the user has that tool switched on. */
  requiresTool?: Tool["key"];
  /** When set, this item only appears for admins (see AuthContext's user.isAdmin). */
  requiresAdmin?: boolean;
}

// The nav is a function of which tools the user picked, not a fixed list. Someone who never
// connects Teams shouldn't have a Chats tab sitting there doing nothing, and someone who turns
// the travel tracker on should get somewhere to actually look at it.
const NAV_ITEMS: NavItem[] = [
  { to: "/assistant", label: "Assistant", Icon: IconAssistant },
  { to: "/chats", label: "Chats", Icon: IconChat, requiresTool: "teams" },
  { to: "/calendar", label: "Calendar", Icon: IconCalendar },
  { to: "/files", label: "Files", Icon: IconFolder },
  { to: "/travel", label: "Travel", Icon: IconTravel, requiresTool: "travel" },
  { to: "/settings", label: "Settings", Icon: IconSettings },
  { to: "/portal", label: "Portal", Icon: IconPortal, requiresAdmin: true },
];

export function Sidebar() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const { user, refresh } = useAuth();
  const { isEnabled, loaded } = useTools();
  const navigate = useNavigate();

  useEffect(() => {
    fetchAccounts().then(setAccounts).catch(() => {});
  }, []);

  const cls = ({ isActive }: { isActive: boolean }) => `nav-link${isActive ? " active" : ""}`;

  async function handleLogout() {
    await logout();
    await refresh();
    navigate("/");
  }

  // Render the un-gated items during the first load rather than nothing, so the nav doesn't
  // flash empty; gated items appear once we actually know whether they belong.
  const items = NAV_ITEMS.filter((item) => {
    if (item.requiresAdmin && !user?.isAdmin) return false;
    if (item.requiresTool && !(loaded && isEnabled(item.requiresTool))) return false;
    return true;
  });

  return (
    <>
      {/* Desktop (>=1024px, labeled) / tablet (768-1023px, icon rail) sidebar — hidden below 768px */}
      <nav className="sidebar">
        <NavLink to="/assistant" className="sidebar-brand">
          <span className="sidebar-brand-mark">M</span>
          <span className="sidebar-label">Marlowe</span>
        </NavLink>

        {items.map(({ to, label, Icon }) => (
          <NavLink key={to} to={to} className={cls}>
            <Icon />
            <span className="sidebar-label">{label}</span>
          </NavLink>
        ))}

        <div className="sidebar-footer">
          <div className="sidebar-status">
            <span className={`status-dot${accounts.length ? " on" : ""}`} />
            <span className="sidebar-label">
              {accounts.length
                ? `${accounts.length} account${accounts.length > 1 ? "s" : ""} connected`
                : "No accounts connected"}
            </span>
          </div>
          <button className="sidebar-logout" onClick={handleLogout}>
            <IconLogOut />
            <span className="sidebar-label">Sign out</span>
          </button>
        </div>
      </nav>

      {/* Mobile (<768px) bottom tab bar */}
      <nav className="mobile-tabbar">
        {items.map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) => `mobile-tab-link${isActive ? " active" : ""}`}
          >
            <Icon />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
    </>
  );
}
