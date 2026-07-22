import { useEffect, useState } from "react";
import { fetchChats, type ChatThread } from "../api/client";

export function ChatsPage() {
  const [chats, setChats] = useState<ChatThread[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load(q?: string) {
    setLoading(true);
    setError(null);
    try {
      setChats(await fetchChats(q));
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
      <h1>Chats</h1>
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
          placeholder="Search Microsoft Teams messages…"
        />
        <button type="submit">Search</button>
      </form>

      <div className="card">
        {loading && <p className="muted">Loading…</p>}
        {error && <p className="error">{error}</p>}
        {!loading && !error && chats.length === 0 && (
          <p className="muted">
            No Teams chats — connect a Microsoft account on the Setup page.
          </p>
        )}
        {chats.map((c) => (
          <div key={`${c.accountId}-${c.id}`} className="list-item">
            <a href={c.link} target="_blank" rel="noreferrer">
              <div className="title">
                <span>{c.topic}</span>
                <span className="badge">{c.accountEmail}</span>
              </div>
              <div className="sub">{c.lastSender}</div>
              <div className="sub">{c.preview}</div>
            </a>
          </div>
        ))}
      </div>
    </div>
  );
}
