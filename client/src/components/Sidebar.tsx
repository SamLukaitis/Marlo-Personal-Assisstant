import { NavLink } from "react-router-dom";
import { useEffect, useState } from "react";
import { fetchAccounts, type Account } from "../api/client";

export function Sidebar() {
  const [accounts, setAccounts] = useState<Account[]>([]);

  useEffect(() => {
    fetchAccounts().then(setAccounts).catch(() => {});
  }, []);

  const cls = ({ isActive }: { isActive: boolean }) => (isActive ? "active" : "");

  return (
    <nav className="sidebar">
      <div className="brand">Hub</div>
      <NavLink to="/" end className={cls}>
        💬 Assistant
      </NavLink>
      <NavLink to="/inbox" className={cls}>
        📥 Inbox
      </NavLink>
      <NavLink to="/calendar" className={cls}>
        📅 Calendar
      </NavLink>
      <NavLink to="/files" className={cls}>
        📁 Files
      </NavLink>
      <NavLink to="/setup" className={cls}>
        ⚙️ Setup
      </NavLink>
      <div className="footer">
        {accounts.length
          ? `${accounts.length} account${accounts.length > 1 ? "s" : ""} connected`
          : "No accounts connected"}
      </div>
    </nav>
  );
}
