import { useEffect, useState } from "react";
import {
  fetchFiles,
  fetchDocuments,
  documentFileUrl,
  deleteDocument,
  type FileHit,
  type StoredDocument,
} from "../api/client";
import { IconTrash } from "../components/icons";

export function FilesPage() {
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<FileHit[]>([]);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [documents, setDocuments] = useState<StoredDocument[]>([]);
  const [expandedDoc, setExpandedDoc] = useState<number | null>(null);

  async function loadDocuments() {
    setDocuments(await fetchDocuments());
  }

  useEffect(() => {
    loadDocuments().catch(() => {});
  }, []);

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

      <h2 style={{ marginTop: 28 }}>Documents (from WhatsApp)</h2>
      <div className="card">
        <p className="muted" style={{ marginTop: 0 }}>
          Photos and files you've sent your assistant on WhatsApp (boarding passes, licenses,
          tickets, receipts). Each one is analyzed once when sent, so you can later ask things
          like "when did I fly to Berlin" or "what's the code on my license".
        </p>
        {documents.length === 0 ? (
          <p className="muted" style={{ marginTop: 12 }}>
            Nothing saved yet — send a photo or document to your assistant on WhatsApp.
          </p>
        ) : (
          documents.map((d) => (
            <div key={d.id} className="list-item" style={{ display: "block" }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div>
                  <strong>{d.filename || d.caption || d.mimeType}</strong>{" "}
                  <span className="muted" style={{ fontSize: 12.5 }}>
                    {new Date(d.createdAt).toLocaleString()}
                  </span>
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <a href={documentFileUrl(d.id)} target="_blank" rel="noreferrer">
                    <button>View file</button>
                  </a>
                  <button
                    style={{ display: "flex", alignItems: "center", gap: 6 }}
                    onClick={() => setExpandedDoc(expandedDoc === d.id ? null : d.id)}
                  >
                    {expandedDoc === d.id ? "Hide details" : "Show details"}
                  </button>
                  <button
                    className="danger"
                    style={{ display: "flex", alignItems: "center", gap: 6 }}
                    onClick={async () => {
                      await deleteDocument(d.id);
                      loadDocuments();
                    }}
                  >
                    <IconTrash />
                    Delete
                  </button>
                </div>
              </div>
              {expandedDoc === d.id && (
                <p
                  className="muted"
                  style={{ fontSize: 13, marginTop: 10, whiteSpace: "pre-wrap" }}
                >
                  {d.extractedText}
                </p>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
