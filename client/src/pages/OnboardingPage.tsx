import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  fetchProviders,
  fetchAccounts,
  fetchWhatsAppAllowedNumbers,
  saveWhatsAppAllowedNumbers,
  fetchTools,
  setToolEnabled as apiSetToolEnabled,
  loginUrl,
  type ProviderInfo,
  type Account,
  type Tool,
} from "../api/client";
import { IconPlus } from "../components/icons";

// First-run flow for a just-invited user with no connected accounts yet — reached right after
// login (see authRoutes.ts's callback: redirects here when listAccounts(user.id) is empty).
// Deliberately never blocks — "skip for now" always works, since the full Setup page covers the
// same ground later. No dedicated design mockup exists for this page — styled to match the rest
// of the app's system (same cards/buttons/tokens) rather than left in the old look.
export function OnboardingPage() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [numbers, setNumbers] = useState<string[]>([]);
  const [newNumber, setNewNumber] = useState("");
  const [saving, setSaving] = useState(false);
  const [tools, setTools] = useState<Tool[]>([]);
  const [params] = useSearchParams();
  const navigate = useNavigate();

  useEffect(() => {
    Promise.all([
      fetchProviders(),
      fetchAccounts(),
      fetchWhatsAppAllowedNumbers(),
      fetchTools(),
    ]).then(([p, a, n, t]) => {
      setProviders(p);
      setAccounts(a);
      setNumbers(n);
      setTools(t);
    });
  }, [params]);

  async function addNumber() {
    const trimmed = newNumber.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      const next = [...numbers, trimmed];
      await saveWhatsAppAllowedNumbers(next);
      setNumbers(next);
      setNewNumber("");
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleTool(key: Tool["key"], enabled: boolean) {
    setTools((prev) => prev.map((t) => (t.key === key ? { ...t, enabled } : t)));
    try {
      await apiSetToolEnabled(key, enabled);
    } catch (err) {
      setTools((prev) => prev.map((t) => (t.key === key ? { ...t, enabled: !enabled } : t)));
      alert((err as Error).message);
    }
  }

  return (
    <div className="main scrollable" style={{ background: "var(--bg)" }}>
      <div className="main-inner scrollable" style={{ maxWidth: 640 }}>
        <div className="page-header" style={{ marginTop: 24 }}>
          <h1 className="heading-font">Let's set up your hub</h1>
        </div>
        <p className="muted" style={{ marginTop: -12, marginBottom: 24 }}>
          A few quick steps — or skip straight to the assistant and do this later from Setup.
        </p>

        <h2>1. Connect an account</h2>
        {accounts.length > 0 && (
          <div className="banner-note">
            {accounts.length} account{accounts.length > 1 ? "s" : ""} connected.
          </div>
        )}
        {providers.map((p) => (
          <div key={p.provider} className="card card-padded row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
            <div>
              <strong>{p.label}</strong>
              <div className="muted">
                {p.configured ? "Ready to connect." : "Not available on this deployment."}
              </div>
            </div>
            {p.configured ? (
              <a href={loginUrl(p.loginPath)}>
                <button className="btn-primary">Connect</button>
              </a>
            ) : (
              <button className="btn-secondary" disabled>Not configured</button>
            )}
          </div>
        ))}

        <h2>2. Add your WhatsApp number</h2>
        <p className="muted" style={{ marginTop: -4 }}>
          So you can message your assistant from your phone — country code, no spaces or +, e.g.
          447911123456.
        </p>
        <div className="card card-padded" style={{ marginBottom: 12 }}>
          <div className="row">
            <input
              value={newNumber}
              onChange={(e) => setNewNumber(e.target.value)}
              placeholder="447911123456"
            />
            <button className="btn-primary" onClick={addNumber} disabled={saving || !newNumber.trim()}>
              <IconPlus />
              Add
            </button>
          </div>
          {numbers.length > 0 && (
            <div style={{ marginTop: 10 }}>
              {numbers.map((n) => (
                <div key={n} className="list-item">
                  {n}
                </div>
              ))}
            </div>
          )}
        </div>

        <h2>3. Pick your tools (optional)</h2>
        <p className="muted" style={{ marginTop: -4 }}>
          Turn on whichever of these you want — you can change this anytime from Setup.
        </p>
        <div className="card card-padded" style={{ marginBottom: 12 }}>
          {tools.map((t) => (
            <label key={t.key} className="row" style={{ marginBottom: 10, textTransform: "none", fontWeight: 400, fontSize: 13.5 }}>
              <input
                type="checkbox"
                style={{ width: "auto" }}
                checked={t.enabled}
                onChange={(e) => handleToggleTool(t.key, e.target.checked)}
              />
              <span>
                <strong>{t.label}</strong> — <span className="muted">{t.description}</span>
              </span>
            </label>
          ))}
        </div>

        <div className="row" style={{ marginTop: 24, marginBottom: 32 }}>
          <button className="btn-primary" onClick={() => navigate("/assistant")}>Go to my assistant</button>
          <Link to="/assistant" className="muted" style={{ fontSize: 13.5 }}>
            skip for now
          </Link>
        </div>
      </div>
    </div>
  );
}
