import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  fetchProviders,
  fetchAccounts,
  fetchSettings,
  saveSettings,
  disconnectAccount,
  loginUrl,
  type ProviderInfo,
  type Account,
} from "../api/client";

const ERROR_TEXT: Record<string, string> = {
  google_not_configured:
    "Google isn't configured yet — add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to server/.env (see README).",
  microsoft_not_configured:
    "Microsoft isn't configured yet — add MS_CLIENT_ID and MS_CLIENT_SECRET to server/.env (see README).",
  oauth_failed: "The sign-in flow failed — check the server logs and try again.",
  missing_code: "The sign-in flow was cancelled.",
};

export function SetupPage() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [assistantName, setAssistantName] = useState("Assistant");
  const [persona, setPersona] = useState("");
  const [saved, setSaved] = useState(false);
  const [searchParams] = useSearchParams();

  async function load() {
    const [p, a, s] = await Promise.all([fetchProviders(), fetchAccounts(), fetchSettings()]);
    setProviders(p);
    setAccounts(a);
    setAssistantName(s.assistantName);
    setPersona(s.persona);
  }

  useEffect(() => {
    load().catch(() => {});
  }, []);

  const connected = searchParams.get("connected");
  const errorKey = searchParams.get("error");

  async function handleSave() {
    await saveSettings({ assistantName, persona });
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  return (
    <div className="main">
      <h1>Setup</h1>

      {connected && <div className="banner">Connected {connected} successfully.</div>}
      {errorKey && <p className="error">{ERROR_TEXT[errorKey] ?? `Error: ${errorKey}`}</p>}

      <h2>Your assistant</h2>
      <div className="card">
        <label className="muted" style={{ display: "block", marginBottom: 6 }}>
          Assistant name
        </label>
        <input
          value={assistantName}
          onChange={(e) => setAssistantName(e.target.value)}
          style={{ maxWidth: 300, marginBottom: 14 }}
        />
        <label className="muted" style={{ display: "block", marginBottom: 6 }}>
          Describe what you want your assistant to be like — its tone, priorities, what it
          should know about you and your work.
        </label>
        <textarea
          rows={5}
          value={persona}
          onChange={(e) => setPersona(e.target.value)}
          placeholder="e.g. I run three businesses (Acme Ltd, Beta Co, ...). Be brief and direct. When I ask about invoices, check the Acme account first. Flag anything from my accountant as urgent."
        />
        <div className="row" style={{ marginTop: 12 }}>
          <button onClick={handleSave}>Save</button>
          {saved && <span className="muted">Saved ✓</span>}
        </div>
      </div>

      <h2>Connected accounts</h2>
      <div className="card">
        {accounts.length === 0 && <p className="muted">No accounts connected yet.</p>}
        {accounts.map((a) => (
          <div key={a.id} className="list-item row" style={{ justifyContent: "space-between" }}>
            <div>
              <strong>{a.email}</strong>{" "}
              <span className="badge" style={{ textTransform: "capitalize" }}>
                {a.provider}
              </span>
            </div>
            <button
              className="danger"
              onClick={async () => {
                await disconnectAccount(a.id);
                load();
              }}
            >
              Disconnect
            </button>
          </div>
        ))}
      </div>

      <h2>Add an account</h2>
      {providers.map((p) => (
        <div key={p.provider} className="card row" style={{ justifyContent: "space-between" }}>
          <div>
            <strong>{p.label}</strong>
            <div className="muted">
              {p.configured
                ? "Ready to connect — you can link multiple accounts."
                : "Needs API credentials in server/.env first (see README)."}
            </div>
          </div>
          {p.configured ? (
            <a href={loginUrl(p.loginPath)}>
              <button>Connect</button>
            </a>
          ) : (
            <button disabled>Not configured</button>
          )}
        </div>
      ))}

      <h2>Coming soon</h2>
      <div className="card muted">
        WhatsApp (blocked by platform API limits for personal accounts), Microsoft Teams,
        OneDrive file search, Slack.
      </div>
    </div>
  );
}
