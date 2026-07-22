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
  NEWS_TOPIC_LABELS,
  type ProviderInfo,
  type Account,
  type LocalFolder,
  type BriefingSettings,
  type NewsTopic,
  type MemoryNote,
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
  });
  const [briefingSaved, setBriefingSaved] = useState(false);
  const [memoryNotes, setMemoryNotes] = useState<MemoryNote[]>([]);
  const [newNote, setNewNote] = useState("");
  const [searchParams] = useSearchParams();

  async function load() {
    const [p, a, s, f, b, m] = await Promise.all([
      fetchProviders(),
      fetchAccounts(),
      fetchSettings(),
      fetchLocalFolders(),
      fetchBriefingSettings(),
      fetchMemoryNotes(),
    ]);
    setProviders(p);
    setAccounts(a);
    setAssistantName(s.assistantName);
    setPersona(s.persona);
    setFolders(f);
    setBriefing(b);
    setMemoryNotes(m);
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

      <h2>Coming soon</h2>
      <div className="card muted">
        WhatsApp is intentionally left out — there's no compliant API for reading personal
        chats without violating WhatsApp's Terms of Service and risking an account ban. Slack
        and iCloud sync are on the roadmap.
      </div>
    </div>
  );
}
