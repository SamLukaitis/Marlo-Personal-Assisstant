import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import {
  fetchAdminCandidates,
  grantAdmin,
  revokeAdmin,
  fetchUnmetRequests,
  resolveUnmetRequest,
  fetchServerLogs,
  explainServerLog,
  fetchUsageSummary,
  usagePurposeLabel,
  fetchAdminTodos,
  addAdminTodo,
  setAdminTodoDone,
  deleteAdminTodo,
  fetchPosterNotes,
  addPosterNote,
  deletePosterNote,
  fetchPortalVersion,
  type AdminCandidate,
  type UnmetRequest,
  type ServerLog,
  type ApiUsageRow,
  type ApiUsageByPurposeRow,
  type AdminTodo,
  type PosterNote,
} from "../api/client";
import { useAuth } from "../context/AuthContext";
import { IconTrash, IconPlus, IconRefresh } from "../components/icons";

const SECTIONS = [
  { key: "todos", label: "To-Do" },
  { key: "notes", label: "Poster Board" },
  { key: "requests", label: "Unmet Requests" },
  { key: "logs", label: "Logs" },
  { key: "usage", label: "Usage" },
  { key: "admins", label: "Admins" },
] as const;

type SectionKey = (typeof SECTIONS)[number]["key"];

function timeAgo(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Standalone page, not folded into Settings — enough content (to-dos, poster board, unmet
// requests, logs, usage, admin management) that it needs its own real estate. Only reachable via
// the sidebar for admins (Sidebar.tsx filters it out otherwise), but the actual gate is the
// server's requireAdmin middleware on every /api/portal/* route — this client-side check is just
// defense in depth against a typed-in URL.
export function PortalPage() {
  const { user } = useAuth();
  const [section, setSection] = useState<SectionKey>("todos");
  const [version, setVersion] = useState<string>("");

  useEffect(() => {
    fetchPortalVersion()
      .then((v) => setVersion(v.text))
      .catch(() => {});
  }, []);

  if (!user?.isAdmin) return <Navigate to="/assistant" replace />;

  return (
    <div className="main scrollable">
      <div className="main-inner scrollable">
        <div className="page-header">
          <h1 className="heading-font">Portal</h1>
        </div>
        {version && (
          <p className="muted" style={{ marginTop: -10, marginBottom: 18, fontSize: 12.5 }}>
            {version}
          </p>
        )}

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
            {section === "todos" && <TodosTab />}
            {section === "notes" && <NotesTab />}
            {section === "requests" && <RequestsTab />}
            {section === "logs" && <LogsTab />}
            {section === "usage" && <UsageTab />}
            {section === "admins" && <AdminsTab currentUserId={user.id} />}
          </div>
        </div>
      </div>
    </div>
  );
}

function TodosTab() {
  const [todos, setTodos] = useState<AdminTodo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [text, setText] = useState("");

  function load() {
    fetchAdminTodos()
      .then(setTodos)
      .finally(() => setLoaded(true));
  }

  useEffect(load, []);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setTodos(await addAdminTodo(text.trim()));
    setText("");
  }

  const open = todos.filter((t) => !t.done);
  const done = todos.filter((t) => t.done);

  return (
    <>
      <h2>Running to-do list</h2>
      <p className="settings-section-intro">Shared across every admin — refresh to see what others added.</p>
      <div className="card card-padded" style={{ marginBottom: 20 }}>
        <form className="row" onSubmit={handleAdd}>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Add something to build or fix" />
          <button className="btn-primary" type="submit">
            <IconPlus />
            Add
          </button>
        </form>
      </div>

      {!loaded ? (
        <p className="muted">Loading…</p>
      ) : todos.length === 0 ? (
        <p className="muted">Nothing on the list yet.</p>
      ) : (
        <>
          {open.map((t) => (
            <div key={t.id} className="list-item row" style={{ justifyContent: "space-between" }}>
              <label className="row" style={{ gap: 10, fontSize: 13.5 }}>
                <input
                  type="checkbox"
                  checked={false}
                  onChange={async () => setTodos(await setAdminTodoDone(t.id, true))}
                />
                {t.text}
                <span className="muted" style={{ fontSize: 12 }}>
                  — {t.createdByEmail}
                </span>
              </label>
              <button className="btn-danger" onClick={async () => setTodos(await deleteAdminTodo(t.id))}>
                <IconTrash />
              </button>
            </div>
          ))}
          {done.length > 0 && (
            <>
              <h2 style={{ marginTop: 24 }}>Done</h2>
              {done.map((t) => (
                <div key={t.id} className="list-item row" style={{ justifyContent: "space-between" }}>
                  <label className="row" style={{ gap: 10, fontSize: 13.5, opacity: 0.6 }}>
                    <input
                      type="checkbox"
                      checked
                      onChange={async () => setTodos(await setAdminTodoDone(t.id, false))}
                    />
                    <span style={{ textDecoration: "line-through" }}>{t.text}</span>
                  </label>
                  <button className="btn-danger" onClick={async () => setTodos(await deleteAdminTodo(t.id))}>
                    <IconTrash />
                  </button>
                </div>
              ))}
            </>
          )}
        </>
      )}
    </>
  );
}

function NotesTab() {
  const [notes, setNotes] = useState<PosterNote[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [text, setText] = useState("");

  function load() {
    fetchPosterNotes()
      .then(setNotes)
      .finally(() => setLoaded(true));
  }

  useEffect(load, []);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setNotes(await addPosterNote(text.trim()));
    setText("");
  }

  async function handleDelete(id: number) {
    await deletePosterNote(id);
    setNotes((prev) => prev.filter((n) => n.id !== id));
  }

  return (
    <>
      <h2>Poster board</h2>
      <p className="settings-section-intro">Leave a note for the other admins.</p>
      <div className="card card-padded" style={{ marginBottom: 20 }}>
        <form className="row" onSubmit={handleAdd}>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Leave a note…" />
          <button className="btn-primary" type="submit">
            <IconPlus />
            Post
          </button>
        </form>
      </div>

      {!loaded ? (
        <p className="muted">Loading…</p>
      ) : notes.length === 0 ? (
        <p className="muted">No notes yet.</p>
      ) : (
        notes.map((n) => (
          <div key={n.id} className="card card-padded" style={{ marginBottom: 10 }}>
            <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
              <p style={{ margin: 0, fontSize: 13.5, whiteSpace: "pre-wrap" }}>{n.text}</p>
              <button className="btn-danger" onClick={() => handleDelete(n.id)}>
                <IconTrash />
              </button>
            </div>
            <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>
              {n.authorEmail} — {timeAgo(n.createdAt)}
            </p>
          </div>
        ))
      )}
    </>
  );
}

function RequestsTab() {
  const [requests, setRequests] = useState<UnmetRequest[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [includeResolved, setIncludeResolved] = useState(false);

  function load(resolved: boolean) {
    setLoaded(false);
    fetchUnmetRequests(resolved)
      .then(setRequests)
      .finally(() => setLoaded(true));
  }

  useEffect(() => load(includeResolved), [includeResolved]);

  async function handleResolve(id: number) {
    await resolveUnmetRequest(id);
    setRequests((prev) => (includeResolved ? prev : prev.filter((r) => r.id !== id)));
  }

  return (
    <>
      <h2>Unmet requests</h2>
      <p className="settings-section-intro">
        Things users have asked Marlowe for that it couldn't do — a running signal of what to build next.
      </p>
      <div className="row" style={{ marginBottom: 14, justifyContent: "space-between" }}>
        <label className="row" style={{ gap: 8, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={includeResolved}
            onChange={(e) => setIncludeResolved(e.target.checked)}
          />
          Show resolved
        </label>
        <button className="btn-secondary" onClick={() => load(includeResolved)}>
          <IconRefresh /> Refresh
        </button>
      </div>

      {!loaded ? (
        <p className="muted">Loading…</p>
      ) : requests.length === 0 ? (
        <p className="muted">Nothing outstanding.</p>
      ) : (
        requests.map((r) => (
          <div key={r.id} className="list-item row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <p style={{ margin: 0, fontSize: 13.5 }}>{r.summary}</p>
              <p className="muted" style={{ margin: "4px 0 0", fontSize: 12 }}>
                <span className="badge-pill">{r.channel}</span> {timeAgo(r.createdAt)}
                {r.resolvedAt ? " — resolved" : ""}
              </p>
            </div>
            {!r.resolvedAt && (
              <button className="btn-secondary" onClick={() => handleResolve(r.id)}>
                Mark resolved
              </button>
            )}
          </div>
        ))
      )}
    </>
  );
}

function LogsTab() {
  const [logs, setLogs] = useState<ServerLog[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [explaining, setExplaining] = useState<Set<number>>(new Set());

  function load() {
    setLoaded(false);
    fetchServerLogs()
      .then(setLogs)
      .finally(() => setLoaded(true));
  }

  useEffect(load, []);

  async function handleExplain(id: number) {
    setExplaining((prev) => new Set(prev).add(id));
    try {
      const { explanation } = await explainServerLog(id);
      setLogs((prev) => prev.map((l) => (l.id === id ? { ...l, explanation } : l)));
    } catch (err) {
      setLogs((prev) =>
        prev.map((l) => (l.id === id ? { ...l, explanation: `Couldn't explain this: ${(err as Error).message}` } : l))
      );
    } finally {
      setExplaining((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  return (
    <>
      <h2>Server logs</h2>
      <p className="settings-section-intro">
        Recent errors and warnings from the server, newest first. Click Explain for a plain-English read on any of them.
      </p>
      <div className="row" style={{ marginBottom: 14, justifyContent: "flex-end" }}>
        <button className="btn-secondary" onClick={load}>
          <IconRefresh /> Refresh
        </button>
      </div>

      {!loaded ? (
        <p className="muted">Loading…</p>
      ) : logs.length === 0 ? (
        <p className="muted">No errors or warnings recorded — good sign.</p>
      ) : (
        logs.map((l) => (
          <div key={l.id} className="card card-padded" style={{ marginBottom: 10 }}>
            <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
              <span className="badge-pill" style={{ textTransform: "uppercase" }}>
                {l.level}
              </span>
              <span className="muted" style={{ fontSize: 12 }}>{timeAgo(l.createdAt)}</span>
            </div>
            <p style={{ margin: "8px 0", fontSize: 12.5, fontFamily: "monospace", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {l.message}
            </p>
            {l.explanation ? (
              <p className="muted" style={{ margin: 0, fontSize: 13, borderTop: "1px solid var(--border-soft)", paddingTop: 8 }}>
                {l.explanation}
              </p>
            ) : (
              <button className="btn-secondary" disabled={explaining.has(l.id)} onClick={() => handleExplain(l.id)}>
                {explaining.has(l.id) ? "Explaining…" : "Explain this"}
              </button>
            )}
          </div>
        ))
      )}
    </>
  );
}

function UsageTab() {
  const [rows, setRows] = useState<ApiUsageRow[]>([]);
  const [byPurpose, setByPurpose] = useState<ApiUsageByPurposeRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [days, setDays] = useState(30);

  function load(d: number) {
    setLoaded(false);
    fetchUsageSummary(d)
      .then((r) => {
        setRows(r.rows);
        setByPurpose(r.byPurpose);
      })
      .finally(() => setLoaded(true));
  }

  useEffect(() => load(days), [days]);

  const totalCalls = rows.reduce((sum, r) => sum + r.calls, 0);
  const totalTokens = rows.reduce((sum, r) => sum + r.inputTokens + r.outputTokens, 0);
  const totalCost = rows.reduce((sum, r) => sum + (r.estimatedCost ?? 0), 0);

  return (
    <>
      <h2>API usage</h2>
      <p className="settings-section-intro">
        Assistant calls across web and WhatsApp. Cost is an approximate estimate, not exact billing.
      </p>

      <div className="row" style={{ marginBottom: 14, justifyContent: "space-between" }}>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
        <button className="btn-secondary" onClick={() => load(days)}>
          <IconRefresh /> Refresh
        </button>
      </div>

      <div className="stat-row" style={{ marginBottom: 20 }}>
        <div className="stat-card">
          <span className="stat-label">Calls</span>
          <span className="stat-value">{totalCalls}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Tokens</span>
          <span className="stat-value">{totalTokens.toLocaleString()}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Est. cost</span>
          <span className="stat-value">${totalCost.toFixed(2)}</span>
          <span className="stat-note">Approximate, based on list pricing</span>
        </div>
      </div>

      {!loaded ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <h2 style={{ fontSize: 15, marginBottom: 10 }}>What it's being used for</h2>
          {byPurpose.length === 0 ? (
            <p className="muted">No assistant activity in this range.</p>
          ) : (
            <div className="card card-padded" style={{ marginBottom: 24 }}>
              {byPurpose.map((p) => {
                const tokens = p.inputTokens + p.outputTokens;
                const share = totalTokens > 0 ? Math.round((tokens / totalTokens) * 100) : 0;
                return (
                  <div key={p.purpose} style={{ marginBottom: 10 }}>
                    <div className="row" style={{ justifyContent: "space-between", fontSize: 13 }}>
                      <span>{usagePurposeLabel(p.purpose)}</span>
                      <span className="muted">
                        {p.calls} call{p.calls === 1 ? "" : "s"} · {tokens.toLocaleString()} tok.
                        {p.estimatedCost != null ? ` · $${p.estimatedCost.toFixed(3)}` : ""}
                      </span>
                    </div>
                    <div style={{ background: "var(--border-soft)", borderRadius: 4, height: 6, marginTop: 4 }}>
                      <div
                        style={{
                          width: `${share}%`,
                          background: "var(--accent)",
                          borderRadius: 4,
                          height: "100%",
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <h2 style={{ fontSize: 15, marginBottom: 10 }}>Day by day</h2>
          {rows.length === 0 ? (
            <p className="muted">No assistant activity in this range.</p>
          ) : (
            <div className="card" style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: "left" }}>
                    <th style={{ padding: "8px 12px" }}>Day</th>
                    <th style={{ padding: "8px 12px" }}>Purpose</th>
                    <th style={{ padding: "8px 12px" }}>Channel</th>
                    <th style={{ padding: "8px 12px" }}>Model</th>
                    <th style={{ padding: "8px 12px" }}>Calls</th>
                    <th style={{ padding: "8px 12px" }}>Input tok.</th>
                    <th style={{ padding: "8px 12px" }}>Output tok.</th>
                    <th style={{ padding: "8px 12px" }}>Est. cost</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} className="list-item">
                      <td style={{ padding: "8px 12px" }}>{r.day}</td>
                      <td style={{ padding: "8px 12px" }}>{usagePurposeLabel(r.purpose)}</td>
                      <td style={{ padding: "8px 12px" }}>{r.channel}</td>
                      <td style={{ padding: "8px 12px" }}>{r.model}</td>
                      <td style={{ padding: "8px 12px" }}>{r.calls}</td>
                      <td style={{ padding: "8px 12px" }}>{r.inputTokens.toLocaleString()}</td>
                      <td style={{ padding: "8px 12px" }}>{r.outputTokens.toLocaleString()}</td>
                      <td style={{ padding: "8px 12px" }}>{r.estimatedCost != null ? `$${r.estimatedCost.toFixed(3)}` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}

function AdminsTab({ currentUserId }: { currentUserId: number }) {
  const [candidates, setCandidates] = useState<AdminCandidate[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    fetchAdminCandidates()
      .then(setCandidates)
      .finally(() => setLoaded(true));
  }

  useEffect(load, []);

  async function handleToggle(c: AdminCandidate) {
    setError(null);
    try {
      setCandidates(c.isAdmin ? await revokeAdmin(c.id) : await grantAdmin(c.id));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <>
      <h2>Admins</h2>
      <p className="settings-section-intro">
        Anyone with Portal access can grant or remove it for anyone else who's been invited to the app.
      </p>
      {error && <p className="error">{error}</p>}
      {!loaded ? (
        <p className="muted">Loading…</p>
      ) : (
        candidates.map((c) => (
          <div key={c.id} className="list-item row" style={{ justifyContent: "space-between" }}>
            <span style={{ fontSize: 13.5 }}>
              {c.email}
              {c.id === currentUserId && <span className="muted"> (you)</span>}
              {c.isAppOwner && <span className="badge-pill" style={{ marginLeft: 8 }}>owner</span>}
              {c.isAdmin && !c.isAppOwner && <span className="badge-pill" style={{ marginLeft: 8 }}>admin</span>}
            </span>
            {!c.isAppOwner && (
              <button className={c.isAdmin ? "btn-danger" : "btn-primary"} onClick={() => handleToggle(c)}>
                {c.isAdmin ? "Revoke" : "Make admin"}
              </button>
            )}
          </div>
        ))
      )}
    </>
  );
}
