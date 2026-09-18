import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { migrateReplayParkMarker } from "./replayParkMarker.js";

// The shape store.ts produced while the park marker lived on the phone row: user_phone_numbers
// with the extra nullable column, plus the destination table (store.ts creates that in its opening
// CREATE TABLE block, so it always exists by the time this migration runs).
function buildDb(withColumn: boolean): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE user_phone_numbers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      phone TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE replay_parked_phones (
      phone TEXT PRIMARY KEY,
      owner_id INTEGER NOT NULL REFERENCES users(id),
      parked_at INTEGER NOT NULL
    );
  `);
  if (withColumn) db.exec(`ALTER TABLE user_phone_numbers ADD COLUMN unbound_for_replay_at INTEGER`);
  db.prepare(`INSERT INTO users (id, email, created_at) VALUES (1, 'kept@example.com', 1000)`).run();
  db.prepare(`INSERT INTO users (id, email, created_at) VALUES (2, NULL, 2000)`).run();
  return db;
}

function phoneRows(db: Database.Database) {
  return db.prepare(`SELECT user_id AS userId, phone FROM user_phone_numbers ORDER BY phone`).all();
}
function parkRows(db: Database.Database) {
  return db.prepare(`SELECT phone, owner_id AS ownerId, parked_at AS parkedAt FROM replay_parked_phones`).all();
}

describe("migrateReplayParkMarker", () => {
  it("moves a parked row into replay_parked_phones and frees the number", () => {
    const db = buildDb(true);
    db.prepare(
      `INSERT INTO user_phone_numbers (user_id, phone, created_at, unbound_for_replay_at) VALUES (2, '447900000001', 500, 1750000000000)`
    ).run();

    migrateReplayParkMarker(db);

    // The row is gone, so the number is genuinely unbound — that is the whole point: while the row
    // survived it held the UNIQUE phone slot and nothing could re-bind the number.
    expect(phoneRows(db)).toEqual([]);
    expect(parkRows(db)).toEqual([{ phone: "447900000001", ownerId: 2, parkedAt: 1750000000000 }]);
  });

  it("leaves live bindings alone", () => {
    const db = buildDb(true);
    db.prepare(`INSERT INTO user_phone_numbers (user_id, phone, created_at) VALUES (1, '447900000002', 500)`).run();

    migrateReplayParkMarker(db);

    expect(phoneRows(db)).toEqual([{ userId: 1, phone: "447900000002" }]);
    expect(parkRows(db)).toEqual([]);
  });

  it("drops the dead column so nothing can start reading it again", () => {
    const db = buildDb(true);

    migrateReplayParkMarker(db);

    const columns = (db.prepare(`PRAGMA table_info(user_phone_numbers)`).all() as { name: string }[]).map(
      (c) => c.name
    );
    expect(columns).not.toContain("unbound_for_replay_at");
  });

  it("is a no-op on a database that never had the column", () => {
    const db = buildDb(false);
    db.prepare(`INSERT INTO user_phone_numbers (user_id, phone, created_at) VALUES (1, '447900000003', 500)`).run();

    expect(() => migrateReplayParkMarker(db)).not.toThrow();

    expect(phoneRows(db)).toEqual([{ userId: 1, phone: "447900000003" }]);
    expect(parkRows(db)).toEqual([]);
  });

  it("is safe to run twice, which is what every boot after the first does", () => {
    const db = buildDb(true);
    db.prepare(
      `INSERT INTO user_phone_numbers (user_id, phone, created_at, unbound_for_replay_at) VALUES (2, '447900000004', 500, 1750000000000)`
    ).run();

    migrateReplayParkMarker(db);
    migrateReplayParkMarker(db);

    expect(parkRows(db)).toEqual([{ phone: "447900000004", ownerId: 2, parkedAt: 1750000000000 }]);
  });
});
