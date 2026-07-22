import { useEffect, useState } from "react";
import { fetchMessages, type UnifiedMessage } from "../api/client";

export function InboxPage() {
  const [messages, setMessages] = useState<UnifiedMessage[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load(q?: string) {
    setLoading(true);
    setError(null);
    try {
      setMessages(await fetchMessages(q));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <div className="main">
      <h1>Unified Inbox</h1>
      <form
        className="row"
        style={{ marginBottom: 16 }}
        onSubmit={(e) => {
          e.preventDefault();
          load(query || undefined);
        }}
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search across all connected mailboxes…"
        />
        <button type="submit">Search</button>
      </form>

      <div className="card">
        {loading && <p className="muted">Loading…</p>}
        {error && <p className="error">{error}</p>}
        {!loading && !error && messages.length === 0 && (
          <p className="muted">No messages — connect an account on the Setup page.</p>
        )}
        {messages.map((m) => (
          <div key={`${m.accountId}-${m.id}`} className="list-item">
            <a href={m.link} target="_blank" rel="noreferrer">
              <div className={`title${m.unread ? " unread" : ""}`}>
                <span>{m.subject}</span>
                <span className="badge">{m.accountEmail}</span>
              </div>
              <div className="sub">{m.from}</div>
              <div className="sub">{m.snippet}</div>
            </a>
          </div>
        ))}
      </div>
    </div>
  );
}
