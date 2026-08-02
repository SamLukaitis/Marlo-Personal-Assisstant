import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  fetchProviders,
  fetchAccounts,
  fetchSettings,
  saveSettings,
  disconnectAccount,
  loginUrl,
  fetchLocalFolders,
  addLocalFolder,
  removeLocalFolder,
  fetchBriefingSettings,
  saveBriefingSettings,
  fetchMemoryNotes,
  addMemoryNote,
  removeMemoryNote,
  fetchWhatsAppStatus,
  fetchWhatsAppAllowedNumbers,
  saveWhatsAppAllowedNumbers,
  fetchCheckins,
  fetchTravelDays,
  fetchAlertSettings,
  saveAlertSettings,
  NEWS_TOPIC_LABELS,
  type ProviderInfo,
  type Account,
  type LocalFolder,
  type BriefingSettings,
  type NewsTopic,
  type MemoryNote,
  type WhatsAppStatus,
  type TravelCheckin,
  type TravelDaysResult,
  type AlertSettings,
} from "../api/client";
import { IconTrash, IconPlus } from "../components/icons";

const ERROR_TEXT: Record<string, string> = {
  google_not_configured:
    "Google isn't configured yet — add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to server/.env (see README).",
  microsoft_not_configured:
    "Microsoft isn't configured yet — add MS_CLIENT_ID and MS_CLIENT_SECRET to server/.env (see README).",
  oauth_failed: "The sign-in flow failed — check the server logs and try again.",
  missing_code: "The sign-in flow was cancelled.",
};

const ALL_TOPICS = Object.keys(NEWS_TOPIC_LABELS) as NewsTopic[];

export function SetupPage() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [assistantName, setAssistantName] = useState("Assistant");
  const [persona, setPersona] = useState("");
  const [saved, setSaved] = useState(false);
  const [folders, setFolders] = useState<LocalFolder[]>([]);
  const [newFolder, setNewFolder] = useState("");
  const [folderError, setFolderError] = useState<string | null>(null);
  const [briefing, setBriefing] = useState<BriefingSettings>({
    enabled: true,
    includeNews: false,
    topics: [],
    proactive: false,
    sendTime: "07:30",
  });
  const [briefingSaved, setBriefingSaved] = useState(false);
  const [memoryNotes, setMemoryNotes] = useState<MemoryNote[]>([]);
  const [newNote, setNewNote] = useState("");
  const [whatsAppStatus, setWhatsAppStatus] = useState<WhatsAppStatus>({
    configured: false,
    signatureConfigured: false,
  });
  const [allowedNumbers, setAllowedNumbers] = useState<string[]>([]);
  const [newNumber, setNewNumber] = useState("");
  const [numbersSaved, setNumbersSaved] = useState(false);
  const [checkins, setCheckins] = useState<TravelCheckin[]>([]);
  const [schengenDays, setSchengenDays] = useState<TravelDaysResult | null>(null);
  const [alertSettings, setAlertSettings] = useState<AlertSettings>({ enabled: false });
  const [alertSaved, setAlertSaved] = useState(false);
  const [searchParams] = useSearchParams();

  async function load() {
    const [p, a, s, f, b, m, ws, nums, ci, sd, al] = await Promise.all([
      fetchProviders(),
      fetchAccounts(),
      fetchSettings(),
      fetchLocalFolders(),
      fetchBriefingSettings(),
      fetchMemoryNotes(),
      fetchWhatsAppStatus(),
      fetchWhatsAppAllowedNumbers(),
      fetchCheckins(),
      fetchTravelDays("schengen", 180),
      fetchAlertSettings(),
    ]);
    setProviders(p);
    setAccounts(a);
    setAssistantName(s.assistantName);
    setPersona(s.persona);
    setFolders(f);
    setBriefing(b);
    setMemoryNotes(m);
    setWhatsAppStatus(ws);
    setAlertSettings(al);
    setAllowedNumbers(nums);
    setCheckins(ci);
    setSchengenDays(sd);
  }

  async function handleAddFolder(e: React.FormEvent) {
    e.preventDefault();
    if (!newFolder.trim()) return;
    setFolderError(null);
    try {
      await addLocalFolder(newFolder.trim());
      setNewFolder("");
      load();
    } catch (err) {
      setFolderError((err as Error).message);
    }
  }

  async function handleAddNote(e: React.FormEvent) {
    e.preventDefault();
    if (!newNote.trim()) return;
    await addMemoryNote(newNote.trim());
    setNewNote("");
    load();
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

  async function handleSaveBriefing() {
    await saveBriefingSettings(briefing);
    setBriefingSaved(true);
    setTimeout(() => setBriefingSaved(false), 2500);
  }

  async function handleToggleAlerts(enabled: boolean) {
    const next = { enabled };
    setAlertSettings(next);
    await saveAlertSettings(next);
    setAlertSaved(true);
    setTimeout(() => setAlertSaved(false), 2500);
  }

  async function handleAddNumber(e: React.FormEvent) {
    e.preventDefault();
    if (!newNumber.trim()) return;
    const next = [...allowedNumbers, newNumber.trim()];
    setAllowedNumbers(next);
    setNewNumber("");
    await saveWhatsAppAllowedNumbers(next);
    setNumbersSaved(true);
    setTimeout(() => setNumbersSaved(false), 2500);
    load();
  }

  async function handleRemoveNumber(number: string) {
    const next = allowedNumbers.filter((n) => n !== number);
    setAllowedNumbers(next);
    await saveWhatsAppAllowedNumbers(next);
  }

  function toggleTopic(topic: NewsTopic) {
    setBriefing((prev) => ({
      ...prev,
      topics: prev.topics.includes(topic)
        ? prev.topics.filter((t) => t !== topic)
        : [...prev.topics, topic],
    }));
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
      {accounts.length > 0 && (
        <div className="banner">
          Calendar write, email archiving/labels, and contacts search were just added — they
          need extra permissions. Disconnect and reconnect each account below to grant them.
        </div>
      )}
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

      <h2>Local computer folders</h2>
      <div className="card">
        <p className="muted" style={{ marginTop: 0 }}>
          Search files on this computer by name — no account needed, since the app already
          runs on your machine. Add any folder (e.g. Documents, Desktop).
        </p>
        <form className="row" onSubmit={handleAddFolder}>
          <input
            value={newFolder}
            onChange={(e) => setNewFolder(e.target.value)}
            placeholder="C:\Users\you\Documents"
          />
          <button type="submit" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <IconPlus />
            Add
          </button>
        </form>
        {folderError && (
          <p className="error" style={{ marginTop: 8 }}>
            {folderError}
          </p>
        )}
        {folders.length === 0 ? (
          <p className="muted" style={{ marginTop: 12 }}>
            No folders added yet.
          </p>
        ) : (
          folders.map((f) => (
            <div
              key={f.id}
              className="list-item row"
              style={{ justifyContent: "space-between" }}
            >
              <span style={{ fontSize: 13.5 }}>{f.path}</span>
              <button
                className="danger"
                style={{ display: "flex", alignItems: "center", gap: 6 }}
                onClick={async () => {
                  await removeLocalFolder(f.id);
                  load();
                }}
              >
                <IconTrash />
                Remove
              </button>
            </div>
          ))
        )}
      </div>

      <h2>Morning briefing</h2>
      <div className="card">
        <label className="row" style={{ marginBottom: 10 }}>
          <input
            type="checkbox"
            style={{ width: "auto" }}
            checked={briefing.enabled}
            onChange={(e) => setBriefing((prev) => ({ ...prev, enabled: e.target.checked }))}
          />
          <span>Show a daily briefing (unread mail, today's calendar, needs-attention) on the Assistant page</span>
        </label>
        <label className="row" style={{ marginBottom: 10 }}>
          <input
            type="checkbox"
            style={{ width: "auto" }}
            checked={briefing.includeNews}
            onChange={(e) => setBriefing((prev) => ({ ...prev, includeNews: e.target.checked }))}
          />
          <span>Include news headlines</span>
        </label>
        {briefing.includeNews && (
          <div className="row" style={{ flexWrap: "wrap", marginBottom: 10, marginLeft: 24 }}>
            {ALL_TOPICS.map((topic) => (
              <label key={topic} className="row" style={{ gap: 5 }}>
                <input
                  type="checkbox"
                  style={{ width: "auto" }}
                  checked={briefing.topics.includes(topic)}
                  onChange={() => toggleTopic(topic)}
                />
                <span className="muted">{NEWS_TOPIC_LABELS[topic]}</span>
              </label>
            ))}
          </div>
        )}
        <p className="muted" style={{ fontSize: 12.5 }}>
          News comes from free public RSS feeds — no account or API key needed. The briefing
          regenerates once per day; use Refresh on the Assistant page to update it sooner.
        </p>

        <label className="row" style={{ marginTop: 14, marginBottom: 10 }}>
          <input
            type="checkbox"
            style={{ width: "auto" }}
            checked={briefing.proactive}
            onChange={(e) => setBriefing((prev) => ({ ...prev, proactive: e.target.checked }))}
          />
          <span>
            Send it to me automatically on WhatsApp each day (also includes a Schengen day-limit
            warning if you're getting close)
          </span>
        </label>
        {briefing.proactive && (
          <div className="row" style={{ marginLeft: 24, marginBottom: 10 }}>
            <span className="muted">at</span>
            <input
              type="time"
              value={briefing.sendTime}
              onChange={(e) => setBriefing((prev) => ({ ...prev, sendTime: e.target.value }))}
              style={{ maxWidth: 130 }}
            />
          </div>
        )}
        {briefing.proactive && (
          <p className="muted" style={{ fontSize: 12.5 }}>
            Requires WhatsApp to be configured with at least one allowed number, and the server
            to actually be running at that time — it checks every few minutes and catches up
            later in the day if it missed the exact time.
          </p>
        )}

        <div className="row" style={{ marginTop: 8 }}>
          <button onClick={handleSaveBriefing}>Save</button>
          {briefingSaved && <span className="muted">Saved ✓</span>}
        </div>
      </div>

      <h2>Assistant memory</h2>
      <div className="card">
        <p className="muted" style={{ marginTop: 0 }}>
          Things your assistant remembers across conversations — it adds to this on its own,
          or you can add a note directly.
        </p>
        <form className="row" onSubmit={handleAddNote}>
          <input
            value={newNote}
            onChange={(e) => setNewNote(e.target.value)}
            placeholder="e.g. The Acme account is my priority business"
          />
          <button type="submit" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <IconPlus />
            Add
          </button>
        </form>
        {memoryNotes.length === 0 ? (
          <p className="muted" style={{ marginTop: 12 }}>
            Nothing remembered yet.
          </p>
        ) : (
          memoryNotes.map((n) => (
            <div
              key={n.id}
              className="list-item row"
              style={{ justifyContent: "space-between" }}
            >
              <span style={{ fontSize: 13.5 }}>{n.content}</span>
              <button
                className="danger"
                style={{ display: "flex", alignItems: "center", gap: 6 }}
                onClick={async () => {
                  await removeMemoryNote(n.id);
                  load();
                }}
              >
                <IconTrash />
                Forget
              </button>
            </div>
          ))
        )}
      </div>

      <h2>WhatsApp (message your assistant)</h2>
      <div className="card">
        <p className="muted" style={{ marginTop: 0 }}>
          Message your assistant on WhatsApp using Meta's official Cloud API — a compliant
          bot channel, not a reader of your existing personal chats. Requires setup in Meta
          for Developers (see README) plus the env vars below in <code>server/.env</code>.
        </p>
        {!whatsAppStatus.configured && (
          <p className="error">
            Not configured — add WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, and
            WHATSAPP_VERIFY_TOKEN to server/.env (see README).
          </p>
        )}
        {whatsAppStatus.configured && !whatsAppStatus.signatureConfigured && (
          <p className="error">
            WHATSAPP_APP_SECRET is not set — the webhook will refuse to process messages
            until it's added. Without it, incoming messages can't be verified as genuinely
            from Meta.
          </p>
        )}
        {whatsAppStatus.configured && whatsAppStatus.signatureConfigured && (
          <div className="banner">Configured and ready.</div>
        )}

        <label className="muted" style={{ display: "block", marginBottom: 6, marginTop: 14 }}>
          Allowed numbers — only these can message your assistant (WhatsApp format, e.g.
          447911123456 including country code, no spaces or +)
        </label>
        <form className="row" onSubmit={handleAddNumber}>
          <input
            value={newNumber}
            onChange={(e) => setNewNumber(e.target.value)}
            placeholder="447911123456"
          />
          <button type="submit" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <IconPlus />
            Add
          </button>
        </form>
        {numbersSaved && (
          <span className="muted" style={{ display: "block", marginTop: 6 }}>
            Saved ✓
          </span>
        )}
        {allowedNumbers.length === 0 ? (
          <p className="muted" style={{ marginTop: 12 }}>
            No numbers allowed yet — add your own number above once you've set up the Meta
            test number and added it as a recipient there too.
          </p>
        ) : (
          allowedNumbers.map((n) => (
            <div key={n} className="list-item row" style={{ justifyContent: "space-between" }}>
              <span style={{ fontSize: 13.5 }}>{n}</span>
              <button
                className="danger"
                style={{ display: "flex", alignItems: "center", gap: 6 }}
                onClick={() => handleRemoveNumber(n)}
              >
                <IconTrash />
                Remove
              </button>
            </div>
          ))
        )}
      </div>

      <h2>Location check-ins</h2>
      <div className="card">
        <p className="muted" style={{ marginTop: 0 }}>
          Logged automatically by a phone automation (iOS Shortcuts / Android Tasker) that
          POSTs to <code>/api/checkin</code> when you land somewhere or cross a border — not
          sent via WhatsApp, since that would need a manual tap each time. See the README for
          how to set up the phone-side automation; the shared secret it needs is
          <code> CHECKIN_SECRET</code> in <code>server/.env</code>.
        </p>
        {schengenDays && (
          <div className="banner" style={{ marginBottom: 14 }}>
            Schengen: <strong>{schengenDays.daysPresent} / 90</strong> days used in the last
            180 days ({schengenDays.sinceDate} to {schengenDays.untilDate})
          </div>
        )}
        {checkins.length === 0 ? (
          <p className="muted" style={{ marginTop: 12 }}>
            No check-ins logged yet.
          </p>
        ) : (
          checkins.map((c) => (
            <div key={c.id} className="list-item row" style={{ justifyContent: "space-between" }}>
              <span style={{ fontSize: 13.5 }}>
                {c.city ? `${c.city}, ` : ""}
                {c.country ?? `${c.latitude.toFixed(3)}, ${c.longitude.toFixed(3)}`}
              </span>
              <span className="muted" style={{ fontSize: 12.5 }}>
                {new Date(c.checkedInAt).toLocaleString()}
              </span>
            </div>
          ))
        )}
      </div>

      <h2>Real-time alerts</h2>
      <div className="card">
        <label className="row" style={{ marginBottom: 10 }}>
          <input
            type="checkbox"
            style={{ width: "auto" }}
            checked={alertSettings.enabled}
            onChange={(e) => handleToggleAlerts(e.target.checked)}
          />
          <span>
            Ping me on WhatsApp the moment an email from a real person (not a newsletter or
            notification) arrives — instead of waiting for the next morning's briefing
          </span>
        </label>
        {alertSaved && <span className="muted">Saved ✓</span>}
        <p className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>
          Checks every few minutes while the server is running. The first check after turning
          this on just records a baseline — it won't alert on everything already unread in your
          inbox, only on what arrives after that. Requires WhatsApp to be configured with at
          least one allowed number.
        </p>
      </div>

      <h2>Coming soon</h2>
      <div className="card muted">Slack and iCloud sync are on the roadmap.</div>
    </div>
  );
}
