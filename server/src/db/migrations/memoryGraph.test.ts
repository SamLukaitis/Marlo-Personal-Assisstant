import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { migrateMemoryGraph } from "./memoryGraph.js";

// The shape store.ts has by the time this migration runs: memory_notes already carries owner_id
// and the reminder columns, entities exists with remember-bridge rows holding data.notes[].
function buildDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE memory_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      trigger_at INTEGER,
      last_surfaced_at INTEGER,
      gave_up_at INTEGER
    );
    CREATE TABLE entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      data TEXT NOT NULL,
      confidence REAL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  return db;
}

function insertEntity(db: Database.Database, ownerId: number, type: string, data: unknown): number {
  return Number(
    db
      .prepare(`INSERT INTO entities (owner_id, type, data, created_at, updated_at) VALUES (?, ?, ?, 1, 1)`)
      .run(ownerId, type, JSON.stringify(data)).lastInsertRowid
  );
}

function notes(db: Database.Database) {
  return db
    .prepare(
      `SELECT id, owner_id AS ownerId, content, created_at AS createdAt, entity_id AS entityId, kind, source
       FROM memory_notes ORDER BY id`
    )
    .all() as { id: number; ownerId: number; content: string; createdAt: number; entityId: number | null; kind: string; source: string }[];
}

describe("migrateMemoryGraph", () => {
  it("adds the new memory_notes columns with defaults for existing rows", () => {
    const db = buildDb();
    db.prepare(`INSERT INTO memory_notes (owner_id, content, created_at) VALUES (1, 'Likes tea', 5)`).run();

    migrateMemoryGraph(db);

    const cols = (db.prepare(`PRAGMA table_info(memory_notes)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining(["entity_id", "kind", "source", "superseded_at", "superseded_by", "forgotten_at"])
    );
    expect(notes(db)).toEqual([
      { id: 1, ownerId: 1, content: "Likes tea", createdAt: 5, entityId: null, kind: "fact", source: "told" },
    ]);
  });

  it("creates the extraction cursor table", () => {
    const db = buildDb();
    migrateMemoryGraph(db);
    db.prepare(`INSERT INTO memory_extraction_cursors (phone, extracted_through_id, updated_at) VALUES ('44', 3, 1)`).run();
    expect(db.prepare(`SELECT extracted_through_id AS id FROM memory_extraction_cursors`).get()).toEqual({ id: 3 });
  });

  it("adopts the existing flat note for a legacy entity note instead of duplicating it", () => {
    const db = buildDb();
    // Old remember wrote the same text to memory_notes AND data.notes[].
    db.prepare(`INSERT INTO memory_notes (owner_id, content, created_at) VALUES (1, 'Handles invoicing', 10)`).run();
    const sarah = insertEntity(db, 1, "person", { name: "Sarah", notes: [{ text: "Handles invoicing", at: 10 }] });

    migrateMemoryGraph(db);

    expect(notes(db)).toEqual([
      { id: 1, ownerId: 1, content: "Handles invoicing", createdAt: 10, entityId: sarah, kind: "fact", source: "told" },
    ]);
    const data = JSON.parse((db.prepare(`SELECT data FROM entities WHERE id = ?`).get(sarah) as { data: string }).data);
    expect(data).toEqual({ name: "Sarah", aliases: [] });
  });

  it("inserts a legacy entity note that has no flat twin, keeping its timestamp", () => {
    const db = buildDb();
    const sarah = insertEntity(db, 1, "person", { name: "Sarah", notes: [{ text: "Prefers email", at: 42 }] });

    migrateMemoryGraph(db);

    expect(notes(db)).toEqual([
      expect.objectContaining({ ownerId: 1, content: "Prefers email", createdAt: 42, entityId: sarah }),
    ]);
  });

  it("never adopts another owner's identical note", () => {
    const db = buildDb();
    db.prepare(`INSERT INTO memory_notes (owner_id, content, created_at) VALUES (2, 'Handles invoicing', 10)`).run();
    const sarah = insertEntity(db, 1, "person", { name: "Sarah", notes: [{ text: "Handles invoicing", at: 10 }] });

    migrateMemoryGraph(db);

    const rows = notes(db);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.ownerId === 2)?.entityId).toBeNull();
    expect(rows.find((r) => r.ownerId === 1)?.entityId).toBe(sarah);
  });

  it("leaves non-remembered entities untouched", () => {
    const db = buildDb();
    const booking = insertEntity(db, 1, "booking", { kind: "hotel", name: "Hotel Eva" });
    migrateMemoryGraph(db);
    const data = JSON.parse((db.prepare(`SELECT data FROM entities WHERE id = ?`).get(booking) as { data: string }).data);
    expect(data).toEqual({ kind: "hotel", name: "Hotel Eva" });
  });

  it("lower-cases the type of remembered entities, including ones it just migrated, and nothing else", () => {
    const db = buildDb();
    const plain = insertEntity(db, 1, "Person", { name: "Sarah", aliases: [] });
    const legacy = insertEntity(db, 1, " Place ", { name: "Lisbon", notes: [{ text: "Sunny", at: 1 }] });
    const reserved = insertEntity(db, 1, "Booking", { name: "Hilton", aliases: [] });
    const document = insertEntity(db, 1, "Custom_Doc", { name: "Scan" });
    const typeOf = (id: number) => (db.prepare(`SELECT type FROM entities WHERE id = ?`).get(id) as { type: string }).type;

    migrateMemoryGraph(db);

    expect(typeOf(plain)).toBe("person");
    expect(typeOf(legacy)).toBe("place");
    // Lower-casing would move it into the booking pipeline's type, so it's left as it is.
    expect(typeOf(reserved)).toBe("Booking");
    // No aliases array: not a remembered entity.
    expect(typeOf(document)).toBe("Custom_Doc");

    migrateMemoryGraph(db);
    expect([typeOf(plain), typeOf(legacy), typeOf(reserved), typeOf(document)]).toEqual([
      "person",
      "place",
      "Booking",
      "Custom_Doc",
    ]);
  });

  it("is idempotent — a second run changes nothing", () => {
    const db = buildDb();
    insertEntity(db, 1, "person", { name: "Sarah", notes: [{ text: "Prefers email", at: 42 }] });
    migrateMemoryGraph(db);
    const before = notes(db);
    migrateMemoryGraph(db);
    expect(notes(db)).toEqual(before);
  });
});
