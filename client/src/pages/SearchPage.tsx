import { useState } from "react";
import { fetchSearchAll, documentFileUrl, type SearchResults } from "../api/client";

export function SearchPage() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults | null>(null);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function search() {
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    try {
      setResults(await fetchSearchAll(query.trim()));
      setSearched(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const totalResults = results
    ? results.messages.length + results.files.length + results.chats.length + results.documents.length
    : 0;

  return (
    <div className="main">
      <h1>Search</h1>
      <form
        className="row"
        style={{ marginBottom: 16 }}
        onSubmit={(e) => {
          e.preventDefault();
          search();
        }}
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search email, files, Teams chats, and WhatsApp documents at once…"
        />
        <button type="submit" disabled={loading}>
          Search
        </button>
      </form>

      {loading && <p className="muted">Searching everywhere…</p>}
      {error && <p className="error">{error}</p>}
      {!loading && !error && !searched && (
        <p className="muted">
          Searches your connected inboxes, Drive/OneDrive/local files, Teams chats, and saved
          WhatsApp documents in one go.
        </p>
      )}
      {!loading && !error && searched && totalResults === 0 && (
        <p className="muted">No results anywhere for that search.</p>
      )}

      {results && results.messages.length > 0 && (
        <>
          <h2>Email ({results.messages.length})</h2>
          <div className="card">
            {results.messages.map((m) => (
              <div key={`msg-${m.accountId}-${m.id}`} className="list-item">
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
        </>
      )}

      {results && results.files.length > 0 && (
        <>
          <h2>Files ({results.files.length})</h2>
          <div className="card">
            {results.files.map((f) => (
              <div key={`file-${f.accountId}-${f.id}`} className="list-item">
                <a href={f.link} target="_blank" rel="noreferrer">
                  <div className="title">
                    <span>{f.name}</span>
                    <span className="badge">{f.accountEmail}</span>
                  </div>
                  <div className="sub">
                    Modified {f.modifiedAt ? new Date(f.modifiedAt).toLocaleDateString() : "unknown"}
                  </div>
                </a>
              </div>
            ))}
          </div>
        </>
      )}

      {results && results.chats.length > 0 && (
        <>
          <h2>Teams chats ({results.chats.length})</h2>
          <div className="card">
            {results.chats.map((c) => (
              <div key={`chat-${c.accountId}-${c.id}`} className="list-item">
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
        </>
      )}

      {results && results.documents.length > 0 && (
        <>
          <h2>WhatsApp documents ({results.documents.length})</h2>
          <div className="card">
            {results.documents.map((d) => (
              <div key={`doc-${d.id}`} className="list-item">
                <a href={documentFileUrl(d.id)} target="_blank" rel="noreferrer">
                  <div className="title">
                    <span>{d.filename || d.caption || d.mimeType}</span>
                    <span className="badge">{new Date(d.createdAt).toLocaleDateString()}</span>
                  </div>
                  <div className="sub">{d.extractedText.slice(0, 160)}</div>
                </a>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
