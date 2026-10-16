import type Database from "better-sqlite3";

// Business edition ledger (docs/superpowers/specs/2026-10-16-business-edition-design.md §2).
// document_id and entry_id deliberately carry no REFERENCES to documents/ledger_entries, same
// reasoning as memoryGraph.ts: no new FK-ordering hazard for deleteUserCompletely or for a
// document being removed. owner_id does reference users, so findRemainingOwnerReferences checks it.
export function migrateBusinessLedger(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ledger_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL REFERENCES users(id),
      direction TEXT NOT NULL CHECK (direction IN ('in','out')),
      amount_pence INTEGER NOT NULL CHECK (amount_pence > 0),
      occurred_on TEXT NOT NULL,
      counterparty TEXT,
      description TEXT,
      category TEXT,
      business_use TEXT NOT NULL CHECK (business_use IN ('business','personal','unsure')),
      status TEXT NOT NULL CHECK (status IN ('confirmed','needs_review')),
      source TEXT NOT NULL CHECK (source IN ('whatsapp_doc','email','chat','bank')),
      document_id INTEGER,
      source_ref TEXT,
      deleted_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_owner_date ON ledger_entries(owner_id, occurred_on);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_source_ref
      ON ledger_entries(owner_id, source, source_ref) WHERE source_ref IS NOT NULL;
    CREATE TABLE IF NOT EXISTS ledger_entry_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id INTEGER NOT NULL,
      owner_id INTEGER NOT NULL REFERENCES users(id),
      changed_at INTEGER NOT NULL,
      changed_by TEXT NOT NULL,
      before_json TEXT NOT NULL,
      after_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_history_entry ON ledger_entry_history(entry_id);
    CREATE TABLE IF NOT EXISTS ledger_counterparty_choices (
      owner_id INTEGER NOT NULL REFERENCES users(id),
      counterparty_key TEXT NOT NULL,
      category TEXT,
      business_use TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (owner_id, counterparty_key)
    );
  `);
}
