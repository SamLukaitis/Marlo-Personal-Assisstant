import { NavLink } from "react-router-dom";
import { useEffect, useState } from "react";
import { fetchAccounts, type Account } from "../api/client";
import { IconChat, IconInbox, IconCalendar, IconFolder, IconSettings, IconUsers } from "./icons";

export function Sidebar() {
  const [accounts, setAccounts] = useState<Account[]>([]);

  useEffect(() => {
    fetchAccounts().then(setAccounts).catch(() => {});
  }, []);

  const cls = ({ isActive }: { isActive: boolean }) => (isActive ? "active" : "");

  return (
    <nav className="sidebar">
      <div className="brand">
        <span className="brand-mark">H</span>
        Hub
      </div>
      <NavLink to="/" end className={cls}>
        <IconChat />
        Assistant
      </NavLink>
      <NavLink to="/inbox" className={cls}>
        <IconInbox />
        Inbox
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
    </nav>
  );
}
