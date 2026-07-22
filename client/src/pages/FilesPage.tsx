import { useState } from "react";
import { fetchFiles, type FileHit } from "../api/client";

export function FilesPage() {
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<FileHit[]>([]);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function search() {
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    try {
      setFiles(await fetchFiles(query.trim()));
      setSearched(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="main">
      <h1>Files</h1>
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
          placeholder="Search Drive, OneDrive, and local folders by name…"
        />
        <button type="submit" disabled={loading}>
          Search
        </button>
      </form>

      <div className="card">
        {loading && <p className="muted">Searching…</p>}
        {error && <p className="error">{error}</p>}
        {!loading && !error && !searched && (
          <p className="muted">
            Searches Google Drive, OneDrive, and any local folders you've added on the Setup
            page.
          </p>
        )}
        {!loading && !error && searched && files.length === 0 && (
          <p className="muted">No files matched that search.</p>
        )}
        {files.map((f) => (
          <div key={`${f.accountId}-${f.id}`} className="list-item">
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
    </div>
  );
}
