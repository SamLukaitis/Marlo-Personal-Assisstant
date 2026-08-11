import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  fetchProviders,
  fetchAccounts,
  fetchWhatsAppAllowedNumbers,
  saveWhatsAppAllowedNumbers,
  loginUrl,
  type ProviderInfo,
  type Account,
} from "../api/client";

// First-run flow for a just-invited user with no connected accounts yet — reached right after
// login (see authRoutes.ts's callback: redirects here when listAccounts(user.id) is empty).
// Deliberately never blocks — "skip for now" always works, since the full Setup page covers the
// same ground later.
export function OnboardingPage() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [numbers, setNumbers] = useState<string[]>([]);
  const [newNumber, setNewNumber] = useState("");
  const [saving, setSaving] = useState(false);
  const [params] = useSearchParams();
  const navigate = useNavigate();

  useEffect(() => {
    Promise.all([fetchProviders(), fetchAccounts(), fetchWhatsAppAllowedNumbers()]).then(
      ([p, a, n]) => {
        setProviders(p);
        setAccounts(a);
        setNumbers(n);
      }
    );
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

  return (
    <div className="main">
      <h1>Let's set up your hub</h1>
      <p className="muted" style={{ marginTop: -12, marginBottom: 24 }}>
        Two quick steps — or skip straight to the assistant and do this later from Setup.
      </p>

      <h2>1. Connect an account</h2>
      {accounts.length > 0 && (
        <div className="banner">
          {accounts.length} account{accounts.length > 1 ? "s" : ""} connected.
        </div>
      )}
      {providers.map((p) => (
        <div key={p.provider} className="card row" style={{ justifyContent: "space-between" }}>
          <div>
            <strong>{p.label}</strong>
            <div className="muted">
              {p.configured ? "Ready to connect." : "Not available on this deployment."}
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

      <h2>2. Add your WhatsApp number</h2>
      <p className="muted" style={{ marginTop: -4 }}>
        So you can message your assistant from your phone — country code, no spaces or +, e.g.
        447911123456.
      </p>
      <div className="card">
        <div className="row">
          <input
            value={newNumber}
            onChange={(e) => setNewNumber(e.target.value)}
            placeholder="447911123456"
          />
          <button onClick={addNumber} disabled={saving || !newNumber.trim()}>
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

      <div className="row" style={{ marginTop: 24 }}>
        <button onClick={() => navigate("/assistant")}>Go to my assistant</button>
        <Link to="/assistant" className="muted" style={{ fontSize: 13.5 }}>
          skip for now
        </Link>
      </div>
    </div>
  );
}
