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
