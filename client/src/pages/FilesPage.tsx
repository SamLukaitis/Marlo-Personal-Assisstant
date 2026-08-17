import { useEffect, useState } from "react";
import {
  fetchDocuments,
  fetchSearchAll,
  documentFileUrl,
  deleteDocument,
  type FileHit,
  type StoredDocument,
} from "../api/client";
import { IconSearch, IconTrash } from "../components/icons";

type Filter = "all" | "files" | "documents";

// Absorbs the old standalone Search page, scoped to files/documents only — mail and Teams chat
// search now happen by asking the Assistant directly (natural language), per the IA decision in
// docs/superpowers/specs/2026-08-17-modular-tool-toggles-design.md. Reuses the existing
// /api/search endpoint for the search-active state (it already returns files+documents
// alongside messages/chats — this page just doesn't render the latter two), so no new backend
// endpoint was needed for the merge itself.
export function FilesPage() {
  const [query, setQuery] = useState("");
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<FileHit[]>([]);
  const [documents, setDocuments] = useState<StoredDocument[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [expandedDoc, setExpandedDoc] = useState<number | null>(null);

  async function loadDocuments() {
    setDocuments(await fetchDocuments());
  }

  useEffect(() => {
    loadDocuments().catch(() => {});
  }, []);

  async function search() {
    const trimmed = query.trim();
    if (!trimmed) {
      setSearched(false);
      setFiles([]);
      loadDocuments().catch(() => {});
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const results = await fetchSearchAll(trimmed);
      setFiles(results.files);
      setDocuments(results.documents);
      setSearched(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const showFiles = filter === "all" || filter === "files";
  const showDocuments = filter === "all" || filter === "documents";

  return (
    <div className="main">
      <div className="main-inner">
        <div className="page-header">
          <h1 className="heading-font">Files &amp; Documents</h1>
          <div className="row">
            <button
              className={`filter-chip${filter === "all" ? " active" : ""}`}
              onClick={() => setFilter("all")}
            >
              All
            </button>
            <button
              className={`filter-chip${filter === "files" ? " active" : ""}`}
              onClick={() => setFilter("files")}
            >
              Files
            </button>
            <button
              className={`filter-chip${filter === "documents" ? " active" : ""}`}
              onClick={() => setFilter("documents")}
            >
              Documents
            </button>
          </div>
        </div>

        <form
          className="row"
          style={{ marginBottom: 16, position: "relative" }}
          onSubmit={(e) => {
            e.preventDefault();
            search();
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
              placeholder="Search your files and documents…"
            />
          </div>
          <button className="btn-primary" type="submit" disabled={loading}>
            Search
          </button>
        </form>

        {loading && <p className="muted">Searching…</p>}
        {error && <p className="error">{error}</p>}

        <div style={{ flex: 1, overflowY: "auto" }}>
          {showFiles && (
            <section style={{ marginBottom: 24 }}>
              <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
                <h2 style={{ margin: 0 }}>Cloud &amp; local files</h2>
              </div>
              <div className="card">
                {!searched && (
                  <p className="muted" style={{ padding: 16, margin: 0 }}>
                    Searches Google Drive, OneDrive, and any local folders you've added on the
                    Setup page — type above to find a file by name.
                  </p>
                )}
                {searched && files.length === 0 && (
                  <p className="muted" style={{ padding: 16, margin: 0 }}>
                    No files matched that search.
                  </p>
                )}
                {files.map((f) => (
                  <div key={`${f.accountId}-${f.id}`} className="list-item list-item-hover">
                    <a href={f.link} target="_blank" rel="noreferrer" style={{ padding: "0 16px" }}>
                      <div className="list-title">
                        <span>{f.name}</span>
                        <span className="badge-pill">{f.accountEmail}</span>
                      </div>
                      <div className="list-sub">
                        Modified {f.modifiedAt ? new Date(f.modifiedAt).toLocaleDateString() : "unknown"}
                      </div>
                    </a>
                  </div>
                ))}
              </div>
            </section>
          )}

          {showDocuments && (
            <section>
              <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
                <h2 style={{ margin: 0 }}>WhatsApp saved documents</h2>
              </div>
              <div className="card" style={{ padding: 16 }}>
                <p className="muted" style={{ marginTop: 0 }}>
                  Photos and files you've sent your assistant on WhatsApp (boarding passes,
                  licenses, tickets, receipts). Each one is analyzed once when sent, so you can
                  later ask things like "when did I fly to Berlin" or "what's the code on my
                  license".
                </p>
                {documents.length === 0 ? (
                  <p className="muted" style={{ marginTop: 12 }}>
                    {searched ? "No documents matched that search." : "Nothing saved yet — send a photo or document to your assistant on WhatsApp."}
                  </p>
                ) : (
                  documents.map((d) => (
                    <div key={d.id} className="list-item">
                      <div className="row" style={{ justifyContent: "space-between" }}>
                        <div>
                          <strong>{d.filename || d.caption || d.mimeType}</strong>{" "}
                          <span className="muted" style={{ fontSize: 12 }}>
                            {new Date(d.createdAt).toLocaleString()}
                          </span>
                        </div>
                        <div className="row" style={{ gap: 8 }}>
                          <a href={documentFileUrl(d.id)} target="_blank" rel="noreferrer">
                            <button className="btn-secondary">View</button>
                          </a>
                          <button
                            className="btn-secondary"
                            onClick={() => setExpandedDoc(expandedDoc === d.id ? null : d.id)}
                          >
                            {expandedDoc === d.id ? "Hide details" : "Details"}
                          </button>
                          <button
                            className="btn-danger"
                            onClick={async () => {
                              await deleteDocument(d.id);
                              loadDocuments();
                            }}
                          >
                            <IconTrash />
                          </button>
                        </div>
                      </div>
                      {expandedDoc === d.id && (
                        <p className="muted" style={{ fontSize: 12.5, marginTop: 10, whiteSpace: "pre-wrap" }}>
                          {d.extractedText}
                        </p>
                      )}
                    </div>
                  ))
                )}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
