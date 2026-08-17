import { NavLink, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { fetchAccounts, logout, type Account } from "../api/client";
import { useAuth } from "../context/AuthContext";
import {
  IconAssistant,
  IconChat,
  IconCalendar,
  IconFolder,
  IconSettings,
  IconLogOut,
} from "./icons";

const NAV_ITEMS = [
  { to: "/assistant", label: "Assistant", Icon: IconAssistant },
  { to: "/chats", label: "Chats", Icon: IconChat },
  { to: "/calendar", label: "Calendar", Icon: IconCalendar },
  { to: "/files", label: "Files", Icon: IconFolder },
  { to: "/setup", label: "Setup", Icon: IconSettings },
];

export function Sidebar() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const { refresh } = useAuth();
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

  return (
    <>
      {/* Desktop (>=1024px, labeled) / tablet (768-1023px, icon rail) sidebar — hidden below 768px */}
      <nav className="sidebar">
        <NavLink to="/assistant" className="sidebar-brand">
          <span className="sidebar-brand-mark">H</span>
          <span className="sidebar-label">Hub</span>
        </NavLink>

        {NAV_ITEMS.map(({ to, label, Icon }) => (
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
        {NAV_ITEMS.map(({ to, label, Icon }) => (
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
