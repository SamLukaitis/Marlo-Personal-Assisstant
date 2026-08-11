import { useEffect } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { loginUrl } from "../api/client";

export function HomePage() {
  const { user, loading, refresh } = useAuth();
  const [params] = useSearchParams();
  const notInvited = params.get("not_invited") === "1";
  const error = params.get("error");

  // Coming back from a failed/rejected OAuth attempt shouldn't leave stale "loading" state —
  // re-check auth once in case something did change (e.g. a second tab already logged in).
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) return null;
  if (user) return <Navigate to="/assistant" replace />;

  return (
    <div className="main" style={{ maxWidth: 640, textAlign: "center", paddingTop: "14vh" }}>
      <div className="brand-mark" style={{ width: 44, height: 44, borderRadius: 12, fontSize: 20, margin: "0 auto 20px" }}>
        H
      </div>
      <h1 style={{ fontSize: 30, marginBottom: 10 }}>Your personal AI assistant hub</h1>
      <p className="muted" style={{ fontSize: 15, marginBottom: 36 }}>
        One assistant across your email, calendar, files, and documents — reachable from a web
        chat or WhatsApp, anytime. Connect your own accounts and it's yours alone; nobody else's
        hub can see your data.
      </p>

      {notInvited && (
        <div className="banner" style={{ background: "var(--danger-soft)", color: "var(--danger)" }}>
          That account isn't invited yet — this is an invite-only preview. Ask whoever's running
          it to add your email.
        </div>
      )}
      {error && !notInvited && (
        <div className="banner" style={{ background: "var(--danger-soft)", color: "var(--danger)" }}>
          Sign-in didn't go through — try again.
        </div>
      )}

      <div className="row" style={{ justifyContent: "center", gap: 10, marginBottom: 40 }}>
        <a href={loginUrl("/auth/google/login-signin")}>
          <button>Sign in with Google</button>
        </a>
        <a href={loginUrl("/auth/microsoft/login-signin")}>
          <button className="secondary">Sign in with Microsoft</button>
        </a>
      </div>

      <div className="row" style={{ justifyContent: "center", gap: 28, textAlign: "left" }}>
        <div className="card" style={{ flex: 1, maxWidth: 190 }}>
          <strong style={{ fontSize: 13.5 }}>Connect your accounts</strong>
          <p className="muted" style={{ marginTop: 6 }}>Gmail, Outlook, Drive, OneDrive, Teams — as many as you need.</p>
        </div>
        <div className="card" style={{ flex: 1, maxWidth: 190 }}>
          <strong style={{ fontSize: 13.5 }}>Message it anywhere</strong>
          <p className="muted" style={{ marginTop: 6 }}>A web chat, or your own WhatsApp number for it.</p>
        </div>
        <div className="card" style={{ flex: 1, maxWidth: 190 }}>
          <strong style={{ fontSize: 13.5 }}>It's only yours</strong>
          <p className="muted" style={{ marginTop: 6 }}>Every hub is fully separate — your data, your assistant.</p>
        </div>
      </div>
    </div>
  );
}
