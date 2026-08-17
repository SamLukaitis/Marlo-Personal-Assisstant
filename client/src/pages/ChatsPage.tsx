import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchChats, fetchTools, type ChatThread } from "../api/client";

export function ChatsPage() {
  const [chats, setChats] = useState<ChatThread[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [teamsEnabled, setTeamsEnabled] = useState<boolean | null>(null);

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
    fetchTools()
      .then((tools) => setTeamsEnabled(tools.find((t) => t.key === "teams")?.enabled ?? false))
      .catch(() => setTeamsEnabled(false));
  }, []);

  useEffect(() => {
    if (teamsEnabled) load();
  }, [teamsEnabled]);

  if (teamsEnabled === null) return null; // brief flash-avoidance, same pattern as RequireAuth

  if (!teamsEnabled) {
    return (
      <div className="main">
        <h1>Chats</h1>
        <div className="card">
          <p className="muted" style={{ marginTop: 0 }}>
            Teams chat isn't enabled for your account.
          </p>
          <Link to="/setup">
            <button>Turn it on in Setup</button>
          </Link>
        </div>
      </div>
    );
  }

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
