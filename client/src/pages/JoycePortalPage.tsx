import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { fetchJoyceSettings, joycePortalApi, updateJoyceSettings, type JoyceSettings } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { LogsTab, RequestsTab, TodosTab, ToastStack, UsageTab, useTodoReplyToasts } from "./PortalPage";
import "./joyce-portal.css";

// Joyce's admin portal: the Portal's sections that apply to the family assistant, rendered by the
// same components against /api/joyce-portal (server/src/routes/joycePortalRoutes.ts), in Joyce's
// terracotta instead of Marlowe's green. Admin-gated on the server; this check only stops a
// typed-in URL from showing an empty page.

const SECTIONS = [
  { key: "requests", label: "Flagged Requests" },
  { key: "todos", label: "To-Do" },
  { key: "logs", label: "Logs" },
  { key: "usage", label: "Usage" },
  { key: "settings", label: "Settings" },
] as const;

type SectionKey = (typeof SECTIONS)[number]["key"];

export function JoycePortalPage() {
  const { user } = useAuth();
  const [section, setSection] = useState<SectionKey>("requests");
  const toasts = useTodoReplyToasts(joycePortalApi);

  if (!user?.isAdmin) return <Navigate to="/assistant" replace />;

  return (
    <div className="main scrollable joyce-theme">
      <div className="main-inner scrollable">
        <div className="page-header">
          <h1 className="heading-font">Joyce</h1>
        </div>
        <p className="muted joyce-portal-subtitle">The family assistant</p>

        <div className="settings-layout">
          <nav className="settings-nav">
            {SECTIONS.map((s) => (
              <button
                key={s.key}
                className={`settings-nav-item${s.key === section ? " active" : ""}`}
                onClick={() => setSection(s.key)}
              >
                {s.label}
              </button>
            ))}
          </nav>

          <div className="settings-panel">
            {section === "requests" && (
              <RequestsTab
                api={joycePortalApi}
                title="Flagged requests"
                intro="Things families asked Joyce for that she couldn't do. Joyce writes each summary without names or personal details; the badge is an anonymous family label, so you can tell when requests come from the same family without knowing which one."
              />
            )}
            {section === "todos" && <TodosTab api={joycePortalApi} />}
            {section === "logs" && <LogsTab api={joycePortalApi} />}
            {section === "usage" && (
              <UsageTab
                api={joycePortalApi}
                intro="Joyce's Claude calls: replying to families and reading the photos and files they send. Totals only — usage isn't recorded per family. Cost is an approximate estimate, not exact billing."
              />
            )}
            {section === "settings" && <SettingsSection />}
          </div>
        </div>
      </div>

      <ToastStack toasts={toasts} />
    </div>
  );
}

/** Switches that apply to every family at once. */
function SettingsSection() {
  const [settings, setSettings] = useState<JoyceSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchJoyceSettings()
      .then(setSettings)
      .catch(() => setError("Couldn't load Joyce's settings."));
  }, []);

  function setBuiltInCalendar(on: boolean) {
    setSaving(true);
    setError(null);
    updateJoyceSettings({ builtInCalendar: on })
      .then(setSettings)
      .catch(() => setError("Couldn't save that. Try again."))
      .finally(() => setSaving(false));
  }

  return (
    <>
      <h2>Settings</h2>
      <p className="settings-section-intro">These apply to every family straight away.</p>
      {error && <p className="error">{error}</p>}
      {settings && (
        <div className="card card-padded">
          <label className="check-row">
            <input
              type="checkbox"
              checked={settings.builtInCalendar}
              disabled={saving}
              onChange={(e) => setBuiltInCalendar(e.target.checked)}
            />
            <span>
              <span className="check-row-title">Joyce's own calendar for families without Google</span>
              <span className="check-row-desc">
                Each family only ever has one calendar. Once anyone in a family connects Google
                Calendar, Joyce uses Google for that family. This switch only affects families where
                nobody has connected Google: when it's on, Joyce keeps their calendar herself, with a
                link they can subscribe to; when it's off, they have no calendar and Joyce asks them
                to connect Google instead. Turning it off doesn't delete anything, and turning it back
                on brings their old events back.
              </span>
            </span>
          </label>
        </div>
      )}
    </>
  );
}
