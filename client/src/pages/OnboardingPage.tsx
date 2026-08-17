import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  fetchProviders,
  fetchAccounts,
  fetchWhatsAppAllowedNumbers,
  saveWhatsAppAllowedNumbers,
  fetchBriefingSettings,
  saveBriefingSettings,
  loginUrl,
  DEFAULT_BRIEFING_SETTINGS,
  type ProviderInfo,
  type Account,
  type BriefingSettings,
} from "../api/client";
import { IconPlus, IconTrash } from "../components/icons";
import { BriefingSourcePicker } from "../components/BriefingSourcePicker";
import { useTools } from "../context/ToolsContext";

const STEPS = ["Accounts", "WhatsApp", "Your hub", "Briefing"] as const;

// First run for a just-invited user. Four steps, because picking your tools is the moment the
// product stops being generic — it's what decides which sections exist in the sidebar — and that
// decision was previously an afterthought at the bottom of one long scroll. Still never blocks:
// every step can be skipped and everything here stays editable in Settings.
export function OnboardingPage() {
  const [step, setStep] = useState(0);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [numbers, setNumbers] = useState<string[]>([]);
  const [newNumber, setNewNumber] = useState("");
  const [saving, setSaving] = useState(false);
  const [briefing, setBriefing] = useState<BriefingSettings>(DEFAULT_BRIEFING_SETTINGS);
  const [finishing, setFinishing] = useState(false);
  const [params] = useSearchParams();
  const navigate = useNavigate();

  const { tools, setEnabled } = useTools();

  const connectedParam = params.get("connected");
  const errorParam = params.get("error");

  useEffect(() => {
    Promise.all([
      fetchProviders(),
      fetchAccounts(),
      fetchWhatsAppAllowedNumbers(),
      fetchBriefingSettings(),
    ])
      .then(([p, a, n, b]) => {
        setProviders(p);
        setAccounts(a);
        setNumbers(n);
        setBriefing(b);
      })
      .catch(() => {});
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

  async function removeNumber(number: string) {
    const next = numbers.filter((n) => n !== number);
    setNumbers(next);
    await saveWhatsAppAllowedNumbers(next).catch(() => {});
  }

  async function handleToggleTool(key: (typeof tools)[number]["key"], enabled: boolean) {
    try {
      await setEnabled(key, enabled);
    } catch (err) {
      alert((err as Error).message);
    }
  }

  async function finish() {
    setFinishing(true);
    // Briefing choices are only persisted at the end — the picker edits local state, so bailing
    // out mid-flow leaves the saved settings untouched rather than half-applied.
    await saveBriefingSettings(briefing).catch(() => {});
    navigate("/assistant");
  }

  const isLast = step === STEPS.length - 1;

  return (
    <div className="main scrollable" style={{ background: "var(--bg)" }}>
      <div className="main-inner scrollable" style={{ maxWidth: 620 }}>
        <div className="page-header" style={{ marginTop: 24 }}>
          <h1 className="heading-font">Set up your hub</h1>
        </div>

        <ol className="stepper">
          {STEPS.map((label, i) => (
            <li
              key={label}
              className={`stepper-item${i === step ? " active" : ""}${i < step ? " done" : ""}`}
            >
              <span className="stepper-dot">{i + 1}</span>
              <span className="stepper-label">{label}</span>
            </li>
          ))}
        </ol>

        {step === 0 && (
          <section>
            <h2>Connect an account</h2>
            <p className="settings-section-intro">
              This is where your assistant reads your mail, calendar, and files from. You can add
              more later.
            </p>
            {connectedParam && (
              <div className="banner-note">Connected {connectedParam} successfully.</div>
            )}
            {errorParam && <p className="error">That connection didn't go through. Try again.</p>}
            {accounts.length > 0 && (
              <div className="banner-note">
                {accounts.length} account{accounts.length > 1 ? "s" : ""} connected.
              </div>
            )}
            {providers.map((p) => {
              // Signing in already connects whichever provider you used (see authRoutes.ts) — so
              // by the time someone lands here, that one's often already done. Show what's
              // actually connected instead of a bare "Connect" that looks like nothing happened
              // yet, and let "Connect" mean "add another" for a provider that supports more than
              // one account.
              const connectedEmails = accounts.filter((a) => a.provider === p.provider).map((a) => a.email);
              return (
                <div
                  key={p.provider}
                  className="card card-padded row"
                  style={{ justifyContent: "space-between", marginBottom: 8 }}
                >
                  <div>
                    <strong>{p.label}</strong>
                    <div className="muted">
                      {connectedEmails.length > 0
                        ? `Connected: ${connectedEmails.join(", ")}`
                        : p.configured
                        ? "Ready to connect."
                        : "Not available at the moment."}
                    </div>
                  </div>
                  {p.configured ? (
                    <a href={`${loginUrl(p.loginPath)}?from=onboarding`}>
                      <button className={connectedEmails.length > 0 ? "btn-secondary" : "btn-primary"}>
                        {connectedEmails.length > 0 ? "Connect another" : "Connect"}
                      </button>
                    </a>
                  ) : (
                    <button className="btn-secondary" disabled>
                      Unavailable
                    </button>
                  )}
                </div>
              );
            })}
          </section>
        )}

        {step === 1 && (
          <section>
            <h2>Message it from your phone</h2>
            <p className="settings-section-intro">
              Add your number and you can text your assistant on WhatsApp — ask it anything, or
              send it a boarding pass or receipt to file away. Include the country code, with no
              spaces or plus sign.
            </p>
            <div className="card card-padded" style={{ marginBottom: 12 }}>
              <div className="row">
                <input
                  value={newNumber}
                  onChange={(e) => setNewNumber(e.target.value)}
                  placeholder="447911123456"
                />
                <button
                  className="btn-primary"
                  onClick={addNumber}
                  disabled={saving || !newNumber.trim()}
                >
                  <IconPlus />
                  Add
                </button>
              </div>
              {numbers.length > 0 && (
                <div style={{ marginTop: 10 }}>
                  {numbers.map((n) => (
                    <div key={n} className="list-item row" style={{ justifyContent: "space-between" }}>
                      <span style={{ fontSize: 13.5 }}>{n}</span>
                      <button className="btn-danger" onClick={() => removeNumber(n)}>
                        <IconTrash />
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        )}

        {step === 2 && (
          <section>
            <h2>Build your hub</h2>
            <p className="settings-section-intro">
              Switch on what you actually need. Each one you pick becomes its own section in your
              sidebar — leave the rest off and they stay out of your way entirely.
            </p>
            <div className="card card-padded" style={{ marginBottom: 12 }}>
              {tools.map((t) => (
                <label key={t.key} className="check-row">
                  <input
                    type="checkbox"
                    checked={t.enabled}
                    onChange={(e) => handleToggleTool(t.key, e.target.checked)}
                  />
                  <span>
                    <span className="check-row-title">{t.label}</span>
                    <span className="check-row-desc">{t.description}</span>
                  </span>
                </label>
              ))}
              {tools.length === 0 && <p className="muted">Nothing available to add yet.</p>}
            </div>
            <p className="settings-field-hint">
              Assistant, Calendar, and Files are always there — these are the extras.
            </p>
          </section>
        )}

        {step === 3 && (
          <section>
            <h2>What should your daily briefing show?</h2>
            <p className="settings-section-intro">
              Your unread mail and today's calendar are always included. Add anything else you'd
              like waiting for you each morning.
            </p>
            <div className="card card-padded" style={{ marginBottom: 12 }}>
              <BriefingSourcePicker value={briefing} onChange={setBriefing} />
            </div>
          </section>
        )}

        <div className="row" style={{ marginTop: 24, marginBottom: 40, justifyContent: "space-between" }}>
          <div className="row">
            {step > 0 && (
              <button className="btn-secondary" onClick={() => setStep((s) => s - 1)}>
                Back
              </button>
            )}
          </div>
          <div className="row">
            {!isLast && (
              <button className="btn-primary" onClick={() => setStep((s) => s + 1)}>
                Continue
              </button>
            )}
            {isLast && (
              <button className="btn-primary" onClick={finish} disabled={finishing}>
                {finishing ? "Finishing…" : "Go to my assistant"}
              </button>
            )}
            <button className="link-button" onClick={finish}>
              Skip for now
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
