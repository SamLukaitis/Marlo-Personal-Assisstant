import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchChats, type ChatThread } from "../api/client";
import { IconSearch } from "../components/icons";
import { useTools } from "../context/ToolsContext";

export function ChatsPage() {
  const [chats, setChats] = useState<ChatThread[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { isEnabled, loaded } = useTools();
  const teamsEnabled = isEnabled("teams");

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
    if (loaded && teamsEnabled) load();
  }, [loaded, teamsEnabled]);

  if (!loaded) return null; // brief flash-avoidance, same pattern as RequireAuth

  if (!teamsEnabled) {
    return (
      <div className="main">
        <div className="main-inner">
          <div className="page-header">
            <h1 className="heading-font">Chats</h1>
          </div>
          <div className="card card-padded">
            <p className="muted" style={{ marginTop: 0 }}>
              Teams chat isn't switched on for your hub.
            </p>
            <Link to="/settings?section=tools">
              <button className="btn-primary">Turn it on</button>
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="main">
      <div className="main-inner">
        <div className="page-header">
          <h1 className="heading-font">Chats</h1>
        </div>

        <form
          className="row"
          style={{ marginBottom: 16 }}
          onSubmit={(e) => {
            e.preventDefault();
            load(query || undefined);
          }}
        >
          <div style={{ position: "relative", flex: 1 }}>
            <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "var(--text-faint)" }}>
              <IconSearch />
            </span>
            <input
              className="input-clean"
              style={{ paddingLeft: 40 }}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search Microsoft Teams messages…"
            />
          </div>
          <button className="btn-primary" type="submit">
            Search
          </button>
        </form>

        <div className="card" style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          {loading && <p className="muted" style={{ padding: 16 }}>Loading…</p>}
          {error && <p className="error" style={{ padding: 16 }}>{error}</p>}
          {!loading && !error && chats.length === 0 && (
            <p className="muted" style={{ padding: 16 }}>
              No Teams chats — connect a Microsoft account on the Setup page.
            </p>
          )}
          {chats.map((c) => (
            <div key={`${c.accountId}-${c.id}`} className="data-row data-row-hover">
              <a href={c.link} target="_blank" rel="noreferrer" style={{ padding: "0 16px" }}>
                <div className="list-title">
                  <span>{c.topic}</span>
                  <span className="badge-pill">{c.accountEmail}</span>
                </div>
                <div className="list-sub">{c.lastSender}</div>
                <div className="list-sub">{c.preview}</div>
              </a>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
