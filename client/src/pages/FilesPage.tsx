import { useEffect, useState } from "react";
import {
  fetchDocuments,
  fetchSearchAll,
  documentFileUrl,
  deleteDocument,
  documentLabel,
  DOCUMENT_CATEGORIES,
  DOCUMENT_CATEGORY_LABELS,
  type FileHit,
  type StoredDocument,
  type DocumentCategory,
} from "../api/client";
import { IconSearch, IconTrash } from "../components/icons";

type Filter = "all" | "files" | "documents";
type CategoryFilter = DocumentCategory | "all" | "uncategorized";

// "Uncategorized" isn't a real DocumentCategory (never assigned by extraction) — it's the
// display bucket for documents.category === null (predates this feature, or the file type
// couldn't be analyzed). Grouped last so the real categories lead.
const GROUP_ORDER: Array<DocumentCategory | "uncategorized"> = [...DOCUMENT_CATEGORIES, "uncategorized"];
const GROUP_LABELS: Record<DocumentCategory | "uncategorized", string> = {
  ...DOCUMENT_CATEGORY_LABELS,
  uncategorized: "Uncategorized",
};

function groupByCategory(docs: StoredDocument[]): Array<[DocumentCategory | "uncategorized", StoredDocument[]]> {
  const groups = new Map<DocumentCategory | "uncategorized", StoredDocument[]>();
  for (const doc of docs) {
    const key = doc.category ?? "uncategorized";
    const bucket = groups.get(key);
    if (bucket) bucket.push(doc);
    else groups.set(key, [doc]);
  }
  return GROUP_ORDER.filter((key) => groups.has(key)).map((key) => [key, groups.get(key)!]);
}

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
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");
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

  // Filtered client-side rather than re-fetched per chip click — `documents` already holds the
  // full set (capped at 200 by the API), whether from a plain load or a search, so this covers
  // both without a second round trip and without the "which mode am I in" bookkeeping that would
  // take to keep a server-side ?category= fetch in sync with search state too.
  const visibleDocuments =
    categoryFilter === "all"
      ? documents
      : categoryFilter === "uncategorized"
      ? documents.filter((d) => d.category === null)
      : documents.filter((d) => d.category === categoryFilter);
  const uncategorizedCount = documents.filter((d) => d.category === null).length;

  // Used by both the flat and grouped-by-category render paths below, hence pulled out rather
  // than inlined twice.
  function renderDocument(d: StoredDocument) {
    return (
      <div key={d.id} className="data-row">
        <div className="row" style={{ justifyContent: "space-between" }}>
          {/* The title comes from the extraction pass, so the list reads as a set of
              named documents rather than a dump of whatever was typed alongside the
              file. The original message stays visible underneath, trimmed. */}
          <div style={{ minWidth: 0 }}>
            <strong>{documentLabel(d)}</strong>{" "}
            <span className="muted" style={{ fontSize: 12 }}>
              {new Date(d.createdAt).toLocaleDateString(undefined, {
                day: "numeric",
                month: "short",
                year: "numeric",
              })}
            </span>
            {d.caption && <div className="doc-caption">“{d.caption}”</div>}
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
    );
  }

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
                    Searches Google Drive, OneDrive, and any folders you've added in Settings —
                    type above to find a file by name.
                  </p>
                )}
                {searched && files.length === 0 && (
                  <p className="muted" style={{ padding: 16, margin: 0 }}>
                    No files matched that search.
                  </p>
                )}
                {files.map((f) => (
                  <div key={`${f.accountId}-${f.id}`} className="data-row data-row-hover">
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
              <div className="row" style={{ marginBottom: 10, flexWrap: "wrap" }}>
                <button
                  className={`filter-chip${categoryFilter === "all" ? " active" : ""}`}
                  onClick={() => setCategoryFilter("all")}
                >
                  All
                </button>
                {DOCUMENT_CATEGORIES.map((c) => (
                  <button
                    key={c}
                    className={`filter-chip${categoryFilter === c ? " active" : ""}`}
                    onClick={() => setCategoryFilter(c)}
                  >
                    {DOCUMENT_CATEGORY_LABELS[c]}
                  </button>
                ))}
                {uncategorizedCount > 0 && (
                  <button
                    className={`filter-chip${categoryFilter === "uncategorized" ? " active" : ""}`}
                    onClick={() => setCategoryFilter("uncategorized")}
                  >
                    Uncategorized ({uncategorizedCount})
                  </button>
                )}
              </div>
              <div className="card" style={{ padding: 16 }}>
                <p className="muted" style={{ marginTop: 0 }}>
                  Photos and files you've sent your assistant on WhatsApp (boarding passes,
                  licenses, tickets, receipts). Each one is analyzed once when sent, so you can
                  later ask things like "when did I fly to Berlin" or "what's the code on my
                  license".
                </p>
                {visibleDocuments.length === 0 ? (
                  <p className="muted" style={{ marginTop: 12 }}>
                    {searched
                      ? "No documents matched that search."
                      : categoryFilter !== "all"
                      ? "Nothing in this category yet."
                      : "Nothing saved yet — send a photo or document to your assistant on WhatsApp."}
                  </p>
                ) : categoryFilter !== "all" ? (
                  visibleDocuments.map((d) => renderDocument(d))
                ) : (
                  groupByCategory(visibleDocuments).map(([key, docs]) => (
                    <div key={key} style={{ marginBottom: 14 }}>
                      <div className="muted" style={{ fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4, margin: "10px 0 4px" }}>
                        {GROUP_LABELS[key]} ({docs.length})
                      </div>
                      {docs.map((d) => renderDocument(d))}
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
