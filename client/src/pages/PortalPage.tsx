import { Fragment, useEffect, useRef, useState } from "react";
import { Navigate } from "react-router-dom";
import {
  fetchAdminCandidates,
  grantAdmin,
  revokeAdmin,
  setUserEdition,
  fetchPhoneActions,
  usagePurposeLabel,
  usageOwnerLabel,
  marlowePortalApi,
  fetchPosterNotes,
  addPosterNote,
  deletePosterNote,
  fetchPortalVersion,
  fetchFeatureUsage,
  type FeatureUsage,
  type AdminCandidate,
  type UnmetRequest,
  type PortalPhoneAction,
  type ServerLog,
  type ApiUsageRow,
  type ApiUsageByPurposeRow,
  type ApiUsageByOwnerRow,
  type ApiUsageProjection,
  type ApiUsageCallRow,
  type AdminTodo,
  type PosterNote,
  type PortalSectionsApi,
} from "../api/client";
import { useAuth } from "../context/AuthContext";
import { IconTrash, IconPlus, IconRefresh, IconChat } from "../components/icons";

const SECTIONS = [
  { key: "todos", label: "To-Do" },
  { key: "notes", label: "Poster Board" },
  { key: "requests", label: "Unmet Requests" },
  { key: "phone", label: "Phone Actions" },
  { key: "logs", label: "Logs" },
  { key: "usage", label: "Usage" },
  { key: "features", label: "Feature use" },
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
interface Toast {
  id: string;
  text: string;
}

const TOAST_DURATION_MS = 5000;
// Cross-tab notification poll — separate from TodosTab's own REPLY_POLL_MS (below): this one
// runs regardless of which Portal section is open, since a reply to YOUR to-do should surface
// even while you're looking at Usage or Logs, not only while the To-Do tab itself is mounted.
const NOTIFY_POLL_MS = 15_000;

/**
 * Toasts when another admin replies to one of YOUR to-dos, whichever section is open. Shared by
 * Marlowe's Portal and Joyce's portal, each watching its own to-do list through `api`.
 */
export function useTodoReplyToasts(api: PortalSectionsApi): Toast[] {
  const { user } = useAuth();
  const [toasts, setToasts] = useState<Toast[]>([]);
  // null until the first poll completes — that first poll only baselines what's already there,
  // so opening the Portal with a backlog of old unread replies doesn't fire a toast for each one.
  const seenReplyIdsRef = useRef<Set<number> | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    async function poll() {
      let todos;
      try {
        todos = await api.fetchTodos();
      } catch {
        return; // transient network blip — next tick retries, nothing to notify about yet
      }
      if (cancelled) return;

      const currentIds = new Set<number>();
      const newlyArrived: { text: string; authorEmail: string | null }[] = [];
      for (const t of todos) {
        for (const r of t.replies) {
          currentIds.add(r.id);
          const isNew = seenReplyIdsRef.current && !seenReplyIdsRef.current.has(r.id);
          // Only the original poster gets pinged, and never for their own reply.
          if (isNew && t.createdBy === user!.id && r.authorId !== user!.id) {
            newlyArrived.push({ text: t.text, authorEmail: r.authorEmail });
          }
        }
      }

      if (seenReplyIdsRef.current) {
        for (const arrival of newlyArrived) {
          const id = `${Date.now()}-${Math.random()}`;
          setToasts((prev) => [
            ...prev,
            { id, text: `${arrival.authorEmail ?? "No email connected"} replied to "${arrival.text}"` },
          ]);
          setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), TOAST_DURATION_MS);
        }
      }
      seenReplyIdsRef.current = currentIds;
    }

    poll();
    const interval = setInterval(poll, NOTIFY_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [user, api]);

  return toasts;
}

export function ToastStack({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function PortalPage() {
  const { user } = useAuth();
  const [section, setSection] = useState<SectionKey>("todos");
  const [version, setVersion] = useState<string>("");
  const toasts = useTodoReplyToasts(marlowePortalApi);

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
            {section === "todos" && <TodosTab api={marlowePortalApi} />}
            {section === "notes" && <NotesTab />}
            {section === "requests" && (
              <RequestsTab
                api={marlowePortalApi}
                title="Unmet requests"
                intro="Things users have asked Marlowe for that it couldn't do — a running signal of what to build next."
              />
            )}
            {section === "phone" && <PhoneActionsTab />}
            {section === "logs" && <LogsTab api={marlowePortalApi} />}
            {section === "usage" && (
              <UsageTab
                api={marlowePortalApi}
                intro="Assistant calls across web and WhatsApp. Cost is an approximate estimate, not exact billing."
                showOwners
              />
            )}
            {section === "features" && <FeatureUseTab />}
            {section === "admins" && <AdminsTab currentUserId={user.id} />}
          </div>
        </div>
      </div>

      <ToastStack toasts={toasts} />
    </div>
  );
}

// Re-fetches every REPLY_POLL_MS while the To-Do tab is mounted, on top of the load-on-mount —
// keeps unread badges current if another admin replies while this tab is just sitting open,
// without needing a websocket for what's a handful-of-admins internal tool. Separate from
// PortalPage's own cross-tab poll (which drives the toast) — both hit the same cheap GET, and
// keeping them independent means neither has to know the other exists.
const REPLY_POLL_MS = 20_000;

function TodoRow({
  todo,
  done,
  onSetDone,
  onDelete,
  onReply,
  onMarkRead,
}: {
  todo: AdminTodo;
  done: boolean;
  onSetDone: (id: number, done: boolean) => void;
  onDelete: (id: number) => void;
  onReply: (id: number, text: string) => Promise<void>;
  onMarkRead: (id: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  function toggleExpanded() {
    const next = !expanded;
    setExpanded(next);
    // Mark read on OPEN, not close — opening is the moment the admin actually sees the thread.
    if (next && todo.unreadReplyCount > 0) onMarkRead(todo.id);
  }

  async function handleReplySubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      await onReply(todo.id, trimmed);
      setDraft("");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="todo-row">
      <div className="todo-checkbox-col">
        <input type="checkbox" checked={done} onChange={() => onSetDone(todo.id, !done)} />
      </div>

      <div className="todo-content">
        <div className="todo-title" style={done ? { textDecoration: "line-through", opacity: 0.6 } : undefined}>
          {todo.text}
        </div>
        <div className="muted todo-meta">— {todo.createdByEmail ?? "No email connected"}</div>

        <button className="todo-reply-toggle" onClick={toggleExpanded} type="button">
          <IconChat />
          {todo.replies.length === 0 ? "Reply" : `${todo.replies.length} repl${todo.replies.length === 1 ? "y" : "ies"}`}
          {todo.unreadReplyCount > 0 && <span className="todo-unread-badge">{todo.unreadReplyCount}</span>}
        </button>

        {expanded && (
          <div className="todo-thread">
            {todo.replies.map((r) => (
              <div key={r.id}>
                <div className="todo-reply-header">
                  <span className="todo-reply-author">{r.authorEmail ?? "No email connected"}</span>
                  <span className="muted todo-reply-time">{timeAgo(r.createdAt)}</span>
                </div>
                <div className="todo-reply-text">{r.text}</div>
              </div>
            ))}
            <form className="row todo-reply-form" onSubmit={handleReplySubmit}>
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Write a reply…"
                disabled={sending}
              />
              <button className="btn-secondary" type="submit" disabled={sending || !draft.trim()}>
                Reply
              </button>
            </form>
          </div>
        )}
      </div>

      <div className="todo-actions">
        <button className="btn-danger" onClick={() => onDelete(todo.id)}>
          <IconTrash />
        </button>
      </div>
    </div>
  );
}

export function TodosTab({ api }: { api: PortalSectionsApi }) {
  const [todos, setTodos] = useState<AdminTodo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [text, setText] = useState("");

  function load() {
    api
      .fetchTodos()
      .then(setTodos)
      .finally(() => setLoaded(true));
  }

  useEffect(() => {
    load();
    const interval = setInterval(load, REPLY_POLL_MS);
    return () => clearInterval(interval);
  }, [api]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setTodos(await api.addTodo(text.trim()));
    setText("");
  }

  async function handleReply(id: number, replyText: string) {
    setTodos(await api.addTodoReply(id, replyText));
  }

  async function handleMarkRead(id: number) {
    setTodos(await api.markTodoRepliesRead(id));
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
          <div className="card card-padded">
            {open.map((t) => (
              <TodoRow
                key={t.id}
                todo={t}
                done={false}
                onSetDone={async (id, d) => setTodos(await api.setTodoDone(id, d))}
                onDelete={async (id) => setTodos(await api.deleteTodo(id))}
                onReply={handleReply}
                onMarkRead={handleMarkRead}
              />
            ))}
            {open.length === 0 && <p className="muted">Nothing open — nice.</p>}
          </div>
          {done.length > 0 && (
            <>
              <h2 style={{ marginTop: 24 }}>Done</h2>
              <div className="card card-padded">
                {done.map((t) => (
                  <TodoRow
                    key={t.id}
                    todo={t}
                    done
                    onSetDone={async (id, d) => setTodos(await api.setTodoDone(id, d))}
                    onDelete={async (id) => setTodos(await api.deleteTodo(id))}
                    onReply={handleReply}
                    onMarkRead={handleMarkRead}
                  />
                ))}
              </div>
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
              {n.authorEmail ?? "No email connected"} — {timeAgo(n.createdAt)}
            </p>
          </div>
        ))
      )}
    </>
  );
}

function RequestRow({
  request,
  onResolve,
  onAddNote,
}: {
  request: UnmetRequest;
  onResolve: (id: number) => void;
  onAddNote: (id: number, text: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      await onAddNote(request.id, trimmed);
      setDraft("");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="data-row">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <p style={{ margin: 0, fontSize: 13.5 }}>{request.summary}</p>
          <p className="muted" style={{ margin: "4px 0 0", fontSize: 12 }}>
            <span className="badge-pill">{request.channel}</span> {timeAgo(request.createdAt)}
            {request.resolvedAt ? " — resolved" : ""}
          </p>
        </div>
        {!request.resolvedAt && (
          <button className="btn-secondary" onClick={() => onResolve(request.id)}>
            Mark resolved
          </button>
        )}
      </div>

      {request.notes.length > 0 && (
        <div style={{ marginTop: 10 }}>
          {request.notes.map((n) => (
            <div key={n.id} style={{ marginBottom: 6 }}>
              <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                {n.authorEmail ?? "No email connected"} — {timeAgo(n.createdAt)}
              </p>
              <p style={{ margin: "2px 0 0", fontSize: 13 }}>{n.text}</p>
            </div>
          ))}
        </div>
      )}

      <form className="row" style={{ marginTop: 8 }} onSubmit={handleSubmit}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Leave a note for other admins…"
          disabled={sending}
        />
        <button className="btn-secondary" type="submit" disabled={sending || !draft.trim()}>
          Reply
        </button>
      </form>
    </div>
  );
}

export function RequestsTab({ api, title, intro }: { api: PortalSectionsApi; title: string; intro: string }) {
  const [requests, setRequests] = useState<UnmetRequest[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [includeResolved, setIncludeResolved] = useState(false);

  function load(resolved: boolean) {
    setLoaded(false);
    api
      .fetchRequests(resolved)
      .then(setRequests)
      .finally(() => setLoaded(true));
  }

  useEffect(() => load(includeResolved), [includeResolved, api]);

  async function handleResolve(id: number) {
    await api.resolveRequest(id);
    setRequests((prev) => (includeResolved ? prev : prev.filter((r) => r.id !== id)));
  }

  async function handleAddNote(id: number, text: string) {
    setRequests(await api.addRequestNote(id, text, includeResolved));
  }

  return (
    <>
      <h2>{title}</h2>
      <p className="settings-section-intro">{intro}</p>
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
          <RequestRow key={r.id} request={r} onResolve={handleResolve} onAddNote={handleAddNote} />
        ))
      )}
    </>
  );
}

const PHONE_STATUS_LABEL: Record<PortalPhoneAction["status"], string> = {
  offered: "Not tapped",
  fetched: "Running",
  done: "Done",
  failed: "Failed",
};

function PhoneActionsTab() {
  const [rows, setRows] = useState<PortalPhoneAction[]>([]);
  const [loaded, setLoaded] = useState(false);

  function load() {
    setLoaded(false);
    fetchPhoneActions()
      .then(setRows)
      .finally(() => setLoaded(true));
  }

  useEffect(load, []);

  return (
    <>
      <h2>Phone actions</h2>
      <p className="settings-section-intro">
        One-tap actions Marlowe offered through the Marlowe Shortcut: what people tapped, and what broke on their phone.
      </p>
      <div className="row" style={{ marginBottom: 14, justifyContent: "flex-end" }}>
        <button className="btn-secondary" onClick={load}>
          <IconRefresh /> Refresh
        </button>
      </div>
      {!loaded ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted">None offered yet.</p>
      ) : (
        rows.map((r) => (
          <div key={r.id} className="data-row">
            <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
              <strong>{r.label}</strong>
              <span className="muted">{PHONE_STATUS_LABEL[r.status]}</span>
            </div>
            <div className="muted" style={{ fontSize: 13 }}>
              {r.email ?? "deleted user"} · {r.source} · {timeAgo(r.createdAt)}
            </div>
            <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
              {r.steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
            {r.failure && <p style={{ color: "var(--danger, #b42318)", margin: "8px 0 0" }}>{r.failure}</p>}
          </div>
        ))
      )}
    </>
  );
}

export function LogsTab({ api }: { api: PortalSectionsApi }) {
  const [logs, setLogs] = useState<ServerLog[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [explaining, setExplaining] = useState<Set<number>>(new Set());

  function load() {
    setLoaded(false);
    api
      .fetchLogs()
      .then(setLogs)
      .finally(() => setLoaded(true));
  }

  useEffect(load, [api]);

  async function handleExplain(id: number) {
    setExplaining((prev) => new Set(prev).add(id));
    try {
      const { explanation } = await api.explainLog(id);
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

// Shared cell styles for the usage tables. Numeric columns are right-aligned on BOTH the header
// and body cells — browsers give <th> its own default alignment rather than inheriting the row's
// textAlign, so setting it only on the <tr> leaves titles floating away from their numbers.
// Headers stick to the top of their scroll box (usageScrollBox below), so column names stay
// visible while scrolling a long table. The background stops rows showing through them.
const thSticky = { position: "sticky", top: 0, background: "var(--surface)", zIndex: 1 } as const;
const thText = { padding: "8px 12px", textAlign: "left", whiteSpace: "nowrap", ...thSticky } as const;
const thNum = { padding: "8px 12px", textAlign: "right", whiteSpace: "nowrap", ...thSticky } as const;
// The usage tables can run to hundreds of rows. Capping their height makes each one scroll inside
// its own box instead of making the whole page very long.
const usageScrollBox = { overflow: "auto", maxHeight: "min(480px, 60vh)" } as const;
const tdText = { padding: "8px 12px" } as const;
const tdNum = { padding: "8px 12px", textAlign: "right" } as const;

export function UsageTab({
  api,
  intro,
  showOwners = false,
}: {
  api: PortalSectionsApi;
  intro: string;
  // Off for Joyce, whose usage isn't recorded per family.
  showOwners?: boolean;
}) {
  const [rows, setRows] = useState<ApiUsageRow[]>([]);
  const [byPurpose, setByPurpose] = useState<ApiUsageByPurposeRow[]>([]);
  const [byOwner, setByOwner] = useState<ApiUsageByOwnerRow[]>([]);
  const [projection, setProjection] = useState<ApiUsageProjection | null>(null);
  const [recent, setRecent] = useState<ApiUsageCallRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [days, setDays] = useState(30);
  // Message text is only recorded for Marlowe admins' chats, so Joyce's tab never filters on it.
  const [messagesOnly, setMessagesOnly] = useState(showOwners);

  function load(d: number, onlyMessages: boolean) {
    setLoaded(false);
    api
      .fetchUsage(d, 50, onlyMessages)
      .then((r) => {
        setRows(r.rows);
        setByPurpose(r.byPurpose);
        setByOwner(r.byOwner);
        setProjection(r.projection);
        setRecent(r.recent);
      })
      .finally(() => setLoaded(true));
  }

  useEffect(() => load(days, messagesOnly), [days, messagesOnly, api]);

  const totalCalls = rows.reduce((sum, r) => sum + r.calls, 0);
  // "Tokens" everywhere on this tab means ALL tokens, cached included — matching what the
  // Anthropic console bills for. inputTokens alone excludes the cached prompt prefix, which is
  // usually the biggest share by count (though the cheapest per token).
  const totalTokens = rows.reduce(
    (sum, r) => sum + r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheCreationTokens,
    0
  );
  const totalCacheRead = rows.reduce((sum, r) => sum + r.cacheReadTokens, 0);
  const totalCacheWrite = rows.reduce((sum, r) => sum + r.cacheCreationTokens, 0);
  const totalCost = rows.reduce((sum, r) => sum + (r.estimatedCost ?? 0), 0);

  return (
    <>
      <h2>API usage</h2>
      <p className="settings-section-intro">{intro}</p>

      <div className="row" style={{ marginBottom: 14, justifyContent: "space-between" }}>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
        <button className="btn-secondary" onClick={() => load(days, messagesOnly)}>
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
          <span className="stat-note">
            {totalCacheRead + totalCacheWrite > 0
              ? `incl. ${totalCacheRead.toLocaleString()} cache reads (cheap) + ${totalCacheWrite.toLocaleString()} cache writes`
              : "No cached tokens in this range"}
          </span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Est. cost</span>
          <span className="stat-value">${totalCost.toFixed(2)}</span>
          <span className="stat-note">Approximate, based on list pricing</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">If every day looked like {projection ? projection.day : "yesterday"}</span>
          <span className="stat-value">{projection ? `$${projection.projectedMonthlyCost.toFixed(2)}/mo` : "—"}</span>
          <span className="stat-note">
            {projection ? `Based on $${projection.dayCost.toFixed(2)} that day × 30` : "Not enough history yet"}
          </span>
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
                const tokens = p.inputTokens + p.outputTokens + p.cacheReadTokens + p.cacheCreationTokens;
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

          {showOwners && <h2 style={{ fontSize: 15, marginBottom: 10 }}>Who's using it</h2>}
          {!showOwners ? null : byOwner.length === 0 ? (
            <p className="muted">No assistant activity in this range.</p>
          ) : (
            <div className="card card-padded" style={{ marginBottom: 24 }}>
              {byOwner.map((o) => {
                const tokens = o.inputTokens + o.outputTokens + o.cacheReadTokens + o.cacheCreationTokens;
                const share = totalTokens > 0 ? Math.round((tokens / totalTokens) * 100) : 0;
                return (
                  <div key={o.ownerId ?? "no-owner"} style={{ marginBottom: 10 }}>
                    <div className="row" style={{ justifyContent: "space-between", fontSize: 13 }}>
                      <span>{usageOwnerLabel(o)}</span>
                      <span className="muted">
                        {o.calls} call{o.calls === 1 ? "" : "s"} · {tokens.toLocaleString()} tok.
                        {o.estimatedCost != null ? ` · $${o.estimatedCost.toFixed(3)}` : ""}
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
            <div className="card" style={usageScrollBox}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr>
                    <th style={thText}>Day</th>
                    <th style={thText}>Purpose</th>
                    <th style={thText}>Channel</th>
                    <th style={thText}>Model</th>
                    <th style={thNum}>Calls</th>
                    <th style={thNum}>Input tok.</th>
                    <th style={thNum}>Output tok.</th>
                    <th style={thNum}>Cache read</th>
                    <th style={thNum}>Cache write</th>
                    <th style={thNum}>Est. cost</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} className="data-row">
                      <td style={tdText}>{r.day}</td>
                      <td style={tdText}>{usagePurposeLabel(r.purpose)}</td>
                      <td style={tdText}>{r.channel}</td>
                      <td style={tdText}>{r.model}</td>
                      <td style={tdNum}>{r.calls}</td>
                      <td style={tdNum}>{r.inputTokens.toLocaleString()}</td>
                      <td style={tdNum}>{r.outputTokens.toLocaleString()}</td>
                      <td style={tdNum}>{r.cacheReadTokens.toLocaleString()}</td>
                      <td style={tdNum}>{r.cacheCreationTokens.toLocaleString()}</td>
                      <td style={tdNum}>{r.estimatedCost != null ? `$${r.estimatedCost.toFixed(3)}` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h2 style={{ fontSize: 15, marginTop: 24, marginBottom: 10 }}>Recent calls</h2>
          <p className="muted" style={{ marginTop: -6, marginBottom: 10, fontSize: 12 }}>
            The last {recent.length} individual calls with an exact time — the day-by-day table
            above only groups down to the day. Admins' own chats show the message and reply under
            the cost; nobody else's messages are ever shown.
          </p>
          {showOwners && (
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, marginBottom: 10 }}>
              <input type="checkbox" checked={messagesOnly} onChange={(e) => setMessagesOnly(e.target.checked)} />
              Only admins' own messages
            </label>
          )}
          {recent.length === 0 ? (
            <p className="muted">
              {messagesOnly
                ? "No messages yet. Message text is saved from this update onwards, so send Marlowe something and refresh."
                : "No assistant activity yet."}
            </p>
          ) : (
            <div className="card" style={usageScrollBox}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr>
                    <th style={thText}>When</th>
                    <th style={thText}>Purpose</th>
                    {showOwners && <th style={thText}>Who</th>}
                    <th style={thText}>Channel</th>
                    <th style={thText}>Model</th>
                    <th style={thNum}>Input tok.</th>
                    <th style={thNum}>Output tok.</th>
                    <th style={thNum}>Cache read</th>
                    <th style={thNum}>Cache write</th>
                    <th style={thNum}>Est. cost</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((r) => (
                    <Fragment key={r.id}>
                    <tr className="data-row">
                      <td style={{ ...tdText, whiteSpace: "nowrap" }}>{timeAgo(r.createdAt)}</td>
                      <td style={tdText}>{usagePurposeLabel(r.purpose)}</td>
                      {showOwners && <td style={tdText}>{usageOwnerLabel(r)}</td>}
                      <td style={tdText}>{r.channel}</td>
                      <td style={tdText}>{r.model}</td>
                      <td style={tdNum}>{r.inputTokens.toLocaleString()}</td>
                      <td style={tdNum}>{r.outputTokens.toLocaleString()}</td>
                      <td style={tdNum}>{r.cacheReadTokens.toLocaleString()}</td>
                      <td style={tdNum}>{r.cacheCreationTokens.toLocaleString()}</td>
                      <td style={tdNum}>{r.estimatedCost != null ? `$${r.estimatedCost.toFixed(3)}` : "—"}</td>
                    </tr>
                    {r.userMessage != null && (
                      <tr>
                        <td colSpan={showOwners ? 10 : 9} style={{ padding: "0 12px 10px", fontSize: 12 }}>
                          <div style={{ whiteSpace: "pre-wrap" }}>
                            <strong>Message:</strong> {r.userMessage}
                          </div>
                          <div className="muted" style={{ whiteSpace: "pre-wrap", marginTop: 2 }}>
                            <strong>Reply:</strong> {r.replyText || "—"}
                          </div>
                        </td>
                      </tr>
                    )}
                    </Fragment>
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

// A thin bar for the "what it's being used for" lists, same look as the Usage tab's.
function ShareBar({ share }: { share: number }) {
  return (
    <div style={{ background: "var(--border-soft)", borderRadius: 4, height: 6, marginTop: 4 }}>
      <div style={{ width: `${share}%`, background: "var(--accent)", borderRadius: 4, height: "100%" }} />
    </div>
  );
}

// What people use Marlowe for, and what they don't. Built from which tools each message used —
// never the message text — so it covers every user, not just admins.
function FeatureUseTab() {
  const [data, setData] = useState<FeatureUsage | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [days, setDays] = useState(30);
  const [testersOnly, setTestersOnly] = useState(false);

  function load(d: number, onlyTesters: boolean) {
    setLoaded(false);
    fetchFeatureUsage(d, onlyTesters)
      .then(setData)
      .finally(() => setLoaded(true));
  }

  useEffect(() => load(days, testersOnly), [days, testersOnly]);

  const totals = data?.totals ?? { messages: 0, people: 0, messagesWithTools: 0 };
  const usedAreas = data?.areas.filter((a) => a.messages > 0) ?? [];
  const unusedAreas = data?.areas.filter((a) => a.messages === 0) ?? [];
  const usedTools = data?.tools.filter((t) => t.uses > 0) ?? [];
  // Grouped by area, so "nobody's touched Calendar's delete" reads next to the rest of Calendar.
  const unusedByArea = new Map<string, { tool: string; switchedOn: boolean }[]>();
  for (const t of data?.tools ?? []) {
    if (t.uses > 0 || t.area === "helper") continue;
    const list = unusedByArea.get(t.areaLabel) ?? [];
    list.push({ tool: t.label, switchedOn: t.switchedOn });
    unusedByArea.set(t.areaLabel, list);
  }

  return (
    <>
      <h2>Feature use</h2>
      <p className="settings-section-intro">
        What people use Marlowe for, and what they don't, worked out from which tools each message used. Only tool
        names are recorded, never what anyone said. Counting started with this update.
      </p>

      <div className="row" style={{ marginBottom: 14, justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
          {/* The settings panel's labels are small caps headings; this one is a normal checkbox label. */}
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 13,
              fontWeight: 400,
              textTransform: "none",
              letterSpacing: "normal",
              color: "var(--text)",
              margin: 0,
              whiteSpace: "nowrap",
            }}
          >
            <input
              type="checkbox"
              style={{ width: "auto" }}
              checked={testersOnly}
              onChange={(e) => setTestersOnly(e.target.checked)}
            />
            Leave out admins
          </label>
        </div>
        <button className="btn-secondary" onClick={() => load(days, testersOnly)}>
          <IconRefresh /> Refresh
        </button>
      </div>

      <div className="stat-row" style={{ marginBottom: 20 }}>
        <div className="stat-card">
          <span className="stat-label">Messages answered</span>
          <span className="stat-value">{totals.messages}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">People</span>
          <span className="stat-value">{totals.people}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Used a feature</span>
          <span className="stat-value">
            {totals.messages > 0 ? `${Math.round((totals.messagesWithTools / totals.messages) * 100)}%` : "—"}
          </span>
          <span className="stat-note">The rest were just conversation</span>
        </div>
      </div>

      {!loaded || !data ? (
        <p className="muted">Loading…</p>
      ) : totals.messages === 0 ? (
        <p className="muted">No messages in this range yet. Counting started with this update.</p>
      ) : (
        <>
          <h2 style={{ fontSize: 15, marginBottom: 10 }}>What people use Marlowe for</h2>
          <p className="muted" style={{ marginTop: -6, marginBottom: 10, fontSize: 12 }}>
            Share of messages that touched each area. One message can touch more than one, so these add up to more
            than 100%.
          </p>
          <div className="card card-padded" style={{ marginBottom: 24 }}>
            {usedAreas.map((a) => {
              const share = Math.round((a.messages / totals.messages) * 100);
              return (
                <div key={a.area} style={{ marginBottom: 10 }}>
                  <div className="row" style={{ justifyContent: "space-between", fontSize: 13 }}>
                    <span>{a.label}</span>
                    <span className="muted">
                      {a.messages} message{a.messages === 1 ? "" : "s"} · {a.people} {a.people === 1 ? "person" : "people"}{" "}
                      · {share}%
                    </span>
                  </div>
                  <ShareBar share={share} />
                </div>
              );
            })}
          </div>

          <h2 style={{ fontSize: 15, marginBottom: 10 }}>Not used in this range</h2>
          {unusedAreas.length === 0 && unusedByArea.size === 0 ? (
            <p className="muted" style={{ marginBottom: 24 }}>Every tool got used at least once.</p>
          ) : (
            <div className="card card-padded" style={{ marginBottom: 24, fontSize: 13 }}>
              {unusedAreas.length > 0 && (
                <p style={{ margin: "0 0 12px" }}>
                  <strong>Whole areas nobody used:</strong> {unusedAreas.map((a) => a.label).join(", ")}
                </p>
              )}
              {[...unusedByArea.entries()].map(([area, tools]) => (
                <div key={area} style={{ marginBottom: 8 }}>
                  <strong>{area}:</strong>{" "}
                  {tools.map((t, i) => (
                    <Fragment key={t.tool}>
                      {i > 0 && ", "}
                      <code style={{ fontSize: 12 }}>{t.tool}</code>
                      {!t.switchedOn && <span className="muted"> (not set up on this server)</span>}
                    </Fragment>
                  ))}
                </div>
              ))}
            </div>
          )}

          <h2 style={{ fontSize: 15, marginBottom: 10 }}>By tool</h2>
          <div className="card" style={{ ...usageScrollBox, marginBottom: 24 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={thText}>Tool</th>
                  <th style={thText}>Area</th>
                  <th style={thNum}>Uses</th>
                  <th style={thNum}>Messages</th>
                  <th style={thNum}>People</th>
                  <th style={thText}>Last used</th>
                </tr>
              </thead>
              <tbody>
                {usedTools.map((t) => (
                  <tr key={t.tool} className="data-row">
                    <td style={tdText}>
                      {/* Real tools show their code name; "Sent a photo or document" and the like read as words. */}
                      {t.label === t.tool ? <code style={{ fontSize: 12 }}>{t.label}</code> : t.label}
                    </td>
                    <td style={tdText}>{t.areaLabel}</td>
                    <td style={tdNum}>{t.uses}</td>
                    <td style={tdNum}>{t.messages}</td>
                    <td style={tdNum}>{t.people}</td>
                    <td style={{ ...tdText, whiteSpace: "nowrap" }}>{t.lastUsedAt ? timeAgo(t.lastUsedAt) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2 style={{ fontSize: 15, marginBottom: 10 }}>By person</h2>
          <div className="card" style={usageScrollBox}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={thText}>Person</th>
                  <th style={thNum}>Messages</th>
                  <th style={thText}>Mostly uses</th>
                  <th style={thText}>Last active</th>
                </tr>
              </thead>
              <tbody>
                {data.people.map((p) => (
                  <tr key={p.ownerId ?? "no-owner"} className="data-row">
                    <td style={tdText}>
                      {p.label}
                      {p.isAdmin && (
                        <span className="badge-pill" style={{ marginLeft: 6 }}>
                          Admin
                        </span>
                      )}
                    </td>
                    <td style={tdNum}>{p.messages}</td>
                    <td style={tdText}>{p.topAreas.map((a) => `${a.label} (${a.messages})`).join(", ")}</td>
                    <td style={{ ...tdText, whiteSpace: "nowrap" }}>{timeAgo(p.lastActiveAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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

  async function handleEdition(c: AdminCandidate) {
    const next = c.edition === "business" ? "general" : "business";
    const who = c.email ?? c.phone ?? `#${c.id}`;
    if (!window.confirm(`Switch ${who} to the ${next} edition? It takes effect on their next message.`)) return;
    setError(null);
    try {
      setCandidates(await setUserEdition(c.id, next));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <>
      <h2>Admins</h2>
      <p className="settings-section-intro">
        Anyone with Portal access can grant or remove it for anyone else who's been invited to the app.
        This is also where you move someone between the general and business (UK sole trader)
        editions. Switching never deletes anything: business books come back if they're switched back.
      </p>
      {error && <p className="error">{error}</p>}
      {!loaded ? (
        <p className="muted">Loading…</p>
      ) : (
        candidates.map((c) => (
          <div key={c.id} className="data-row row" style={{ justifyContent: "space-between" }}>
            <span style={{ fontSize: 13.5 }}>
              {/* Matches usageOwnerLabel (api/client.ts): a beta that's mostly phone-first would
                  otherwise render every phone-only row identically, with no way to tell them
                  apart or audit who holds a live "Make admin" button. */}
              {c.email ?? (c.phone ? `${c.phone} (no email)` : `No email connected (#${c.id})`)}
              {c.id === currentUserId && <span className="muted"> (you)</span>}
              {c.isAppOwner && <span className="badge-pill" style={{ marginLeft: 8 }}>owner</span>}
              {c.isAdmin && !c.isAppOwner && <span className="badge-pill" style={{ marginLeft: 8 }}>admin</span>}
              {c.edition === "business" && <span className="badge-pill" style={{ marginLeft: 8 }}>business</span>}
            </span>
            <span className="row" style={{ gap: 8 }}>
              <button className="btn-secondary" onClick={() => handleEdition(c)}>
                {c.edition === "business" ? "Make general" : "Make business"}
              </button>
              {!c.isAppOwner && (
                <button className={c.isAdmin ? "btn-danger" : "btn-primary"} onClick={() => handleToggle(c)}>
                  {c.isAdmin ? "Revoke" : "Make admin"}
                </button>
              )}
            </span>
          </div>
        ))
      )}
    </>
  );
}
