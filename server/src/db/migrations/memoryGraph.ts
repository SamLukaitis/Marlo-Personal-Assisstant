import type Database from "better-sqlite3";

// Brings memory_notes and the remember→entities bridge forward to the personal-memory-graph shape
// (docs/superpowers/specs/2026-09-23-personal-memory-graph-design.md):
//
// - memory_notes gains the columns that turn it into a structured fact store: which remembered
//   entity a fact is about (entity_id — deliberately no REFERENCES clause, so deleteUserCompletely
//   gains no new FK-ordering hazard), kind (core/fact/preference), source (told/extracted), and
//   soft supersede/forget markers.
// - memory_extraction_cursors records how far services/memoryExtraction.ts has read each phone's
//   WhatsApp transcript.
// - Remembered entities stop carrying their notes inline (data.notes[]): each note becomes a
//   memory_notes row with entity_id set, so a correction or "forget" has exactly one copy to act
//   on. The old remember tool wrote every entity note to BOTH places, so an identical flat row of
//   the same owner is adopted (entity_id set on it) rather than duplicated.
//
// Safe on every boot: columns/tables are guarded, and an entity is only rewritten while its data
// still has a notes array.
export function migrateMemoryGraph(db: Database.Database): void {
  const columns = (db.prepare(`PRAGMA table_info(memory_notes)`).all() as { name: string }[]).map((c) => c.name);
  const addColumn = (name: string, definition: string) => {
    if (!columns.includes(name)) db.exec(`ALTER TABLE memory_notes ADD COLUMN ${name} ${definition}`);
  };
  addColumn("entity_id", "INTEGER");
  addColumn("kind", "TEXT NOT NULL DEFAULT 'fact'");
  addColumn("source", "TEXT NOT NULL DEFAULT 'told'");
  addColumn("superseded_at", "INTEGER");
  addColumn("superseded_by", "INTEGER");
  addColumn("forgotten_at", "INTEGER");

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_notes_entity ON memory_notes (owner_id, entity_id);
    CREATE INDEX IF NOT EXISTS idx_memory_notes_kind ON memory_notes (owner_id, kind);
    CREATE TABLE IF NOT EXISTS memory_extraction_cursors (
      phone                TEXT PRIMARY KEY,
      extracted_through_id INTEGER NOT NULL,
      updated_at           INTEGER NOT NULL
    );
  `);

  const candidates = db
    .prepare(`SELECT id, owner_id AS ownerId, data FROM entities WHERE data LIKE '%"notes"%'`)
    .all() as { id: number; ownerId: number; data: string }[];

  const findTwin = db.prepare(
    `SELECT id FROM memory_notes WHERE owner_id = ? AND content = ? AND entity_id IS NULL ORDER BY id LIMIT 1`
  );
  const adopt = db.prepare(`UPDATE memory_notes SET entity_id = ? WHERE id = ?`);
  const insert = db.prepare(
    `INSERT INTO memory_notes (owner_id, content, created_at, entity_id, kind, source) VALUES (?, ?, ?, ?, 'fact', 'told')`
  );
  const rewrite = db.prepare(`UPDATE entities SET data = ? WHERE id = ?`);

  db.transaction(() => {
    for (const row of candidates) {
      let data: { name?: unknown; notes?: unknown; aliases?: unknown; [key: string]: unknown };
      try {
        data = JSON.parse(row.data);
      } catch {
        continue;
      }
      if (typeof data?.name !== "string" || !Array.isArray(data.notes)) continue;

      for (const note of data.notes as { text?: unknown; at?: unknown }[]) {
        if (typeof note?.text !== "string" || !note.text.trim()) continue;
        const twin = findTwin.get(row.ownerId, note.text) as { id: number } | undefined;
        if (twin) adopt.run(row.id, twin.id);
        else insert.run(row.ownerId, note.text, typeof note.at === "number" ? note.at : Date.now(), row.id);
      }

      const { notes: _notes, ...rest } = data;
      rewrite.run(JSON.stringify({ ...rest, aliases: Array.isArray(rest.aliases) ? rest.aliases : [] }), row.id);
    }
  })();
}
