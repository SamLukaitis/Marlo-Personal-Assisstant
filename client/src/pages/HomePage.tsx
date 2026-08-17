import { useEffect } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { loginUrl } from "../api/client";

// Public marketing/sign-in page — no dedicated design mockup exists for this one (the redesign
// session covered the 5 authenticated pages only). Styled to match the rest of the app's system
// (same tokens/fonts/buttons) rather than left in the old look, so it doesn't feel like a
// different product on the way in.
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
    <div style={{ minHeight: "100vh", background: "var(--bg)", display: "flex", justifyContent: "center" }}>
      <div style={{ maxWidth: 640, width: "100%", textAlign: "center", padding: "14vh 24px 60px" }}>
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: 12,
            background: "var(--sidebar-bg)",
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 20,
            fontWeight: 900,
            margin: "0 auto 24px",
          }}
        >
          H
        </div>
        <h1 className="heading-font" style={{ fontSize: 34, marginBottom: 12, fontWeight: 700, letterSpacing: "-0.01em" }}>
          Your personal AI assistant hub
        </h1>
        <p className="muted" style={{ fontSize: 15, marginBottom: 36, lineHeight: 1.6 }}>
          One assistant across your email, calendar, files, and documents — reachable from a web
          chat or WhatsApp, anytime. Connect your own accounts and it's yours alone; nobody else's
          hub can see your data.
        </p>

        {notInvited && (
          <div className="banner-note danger">
            That account isn't invited yet — this is an invite-only preview. Ask whoever's running
            it to add your email.
          </div>
        )}
        {error && !notInvited && (
          <div className="banner-note danger">
            Sign-in didn't go through — try again.
          </div>
        )}

        <div className="row" style={{ justifyContent: "center", gap: 10, marginBottom: 48 }}>
          <a href={loginUrl("/auth/google/login-signin")}>
            <button className="btn-primary">Sign in with Google</button>
          </a>
          <a href={loginUrl("/auth/microsoft/login-signin")}>
            <button className="btn-secondary">Sign in with Microsoft</button>
          </a>
        </div>

        <div className="row" style={{ justifyContent: "center", gap: 20, textAlign: "left", alignItems: "stretch" }}>
          <div className="card card-padded" style={{ flex: 1, maxWidth: 190 }}>
            <strong style={{ fontSize: 13.5 }}>Connect your accounts</strong>
            <p className="muted" style={{ marginTop: 6 }}>Gmail, Outlook, Drive, OneDrive, Teams — as many as you need.</p>
          </div>
          <div className="card card-padded" style={{ flex: 1, maxWidth: 190 }}>
            <strong style={{ fontSize: 13.5 }}>Message it anywhere</strong>
            <p className="muted" style={{ marginTop: 6 }}>A web chat, or your own WhatsApp number for it.</p>
          </div>
          <div className="card card-padded" style={{ flex: 1, maxWidth: 190 }}>
            <strong style={{ fontSize: 13.5 }}>It's only yours</strong>
            <p className="muted" style={{ marginTop: 6 }}>Every hub is fully separate — your data, your assistant.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
