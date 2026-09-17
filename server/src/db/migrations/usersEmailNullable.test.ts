import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateUsersEmailNullable } from "./usersEmailNullable.js";

// The pre-migration shape, exactly as store.ts created it before this migration existed —
// including the is_admin column that an earlier ALTER adds, since the rebuild must carry it.
function buildLegacyDb(dbPath = ":memory:"): Database.Database {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );
    ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
  `);
  return db;
}

function emailIsNullable(db: Database.Database): boolean {
  const cols = db.prepare(`PRAGMA table_info(users)`).all() as { name: string; notnull: number }[];
  return cols.find((c) => c.name === "email")?.notnull === 0;
}

describe("migrateUsersEmailNullable", () => {
  it("relaxes NOT NULL on email", () => {
    const db = buildLegacyDb();
    expect(emailIsNullable(db)).toBe(false);

    migrateUsersEmailNullable(db);

    expect(emailIsNullable(db)).toBe(true);
  });

  it("preserves every existing row verbatim, including ids and is_admin", () => {
    const db = buildLegacyDb();
    db.prepare(`INSERT INTO users (id, email, created_at, is_admin) VALUES (?, ?, ?, ?)`).run(1, "owner@example.com", 1000, 1);
    db.prepare(`INSERT INTO users (id, email, created_at, is_admin) VALUES (?, ?, ?, ?)`).run(7, "tester@example.com", 2000, 0);

    migrateUsersEmailNullable(db);

    const rows = db.prepare(`SELECT id, email, created_at AS createdAt, is_admin AS isAdmin FROM users ORDER BY id`).all();
    expect(rows).toEqual([
      { id: 1, email: "owner@example.com", createdAt: 1000, isAdmin: 1 },
      { id: 7, email: "tester@example.com", createdAt: 2000, isAdmin: 0 },
    ]);
  });

  it("accepts a NULL email after migrating, and still rejects a duplicate address", () => {
    const db = buildLegacyDb();
    migrateUsersEmailNullable(db);

    db.prepare(`INSERT INTO users (email, created_at) VALUES (?, ?)`).run(null, 1000);
    db.prepare(`INSERT INTO users (email, created_at) VALUES (?, ?)`).run(null, 2000);
    db.prepare(`INSERT INTO users (email, created_at) VALUES (?, ?)`).run("real@example.com", 3000);

    // Multiple NULLs are fine in a SQLite UNIQUE column — that is what makes this design work.
    expect(db.prepare(`SELECT count(*) AS n FROM users WHERE email IS NULL`).get()).toEqual({ n: 2 });
    expect(() =>
      db.prepare(`INSERT INTO users (email, created_at) VALUES (?, ?)`).run("real@example.com", 4000)
    ).toThrow();
  });

  it("is idempotent — a second run changes nothing", () => {
    const db = buildLegacyDb();
    db.prepare(`INSERT INTO users (email, created_at) VALUES (?, ?)`).run("owner@example.com", 1000);

    migrateUsersEmailNullable(db);
    migrateUsersEmailNullable(db);

    expect(emailIsNullable(db)).toBe(true);
    expect(db.prepare(`SELECT count(*) AS n FROM users`).get()).toEqual({ n: 1 });
  });

  it("rolls back and leaves the original table intact if the copy is short", () => {
    const db = buildLegacyDb();
    db.prepare(`INSERT INTO users (email, created_at) VALUES (?, ?)`).run("owner@example.com", 1000);
    // Force the row-count guard to trip by leaving a stale users_new behind with a conflicting
    // row, so the INSERT...SELECT cannot copy everything.
    db.exec(`CREATE TABLE users_new (id INTEGER PRIMARY KEY, email TEXT, created_at INTEGER, is_admin INTEGER)`);

    expect(() => migrateUsersEmailNullable(db)).toThrow();

    // The original table survived the failure — this is the property that matters most.
    expect(db.prepare(`SELECT count(*) AS n FROM users`).get()).toEqual({ n: 1 });
    expect(emailIsNullable(db)).toBe(false);
  });

  it("backs up the pre-migration rows to backupPath via VACUUM INTO, when given a file-backed source", () => {
    // VACUUM INTO needs a real source database, not :memory: — so this test alone uses a
    // temp file for both the source and the backup destination.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "users-email-nullable-"));
    const sourcePath = path.join(tmpDir, "source.db");
    const backupPath = path.join(tmpDir, "app.db.bak-test");

    const db = buildLegacyDb(sourcePath);
    db.prepare(`INSERT INTO users (id, email, created_at, is_admin) VALUES (?, ?, ?, ?)`).run(1, "owner@example.com", 1000, 1);
    db.prepare(`INSERT INTO users (id, email, created_at, is_admin) VALUES (?, ?, ?, ?)`).run(7, "tester@example.com", 2000, 0);

    migrateUsersEmailNullable(db, backupPath);

    expect(fs.existsSync(backupPath)).toBe(true);

    const backup = new Database(backupPath, { readonly: true });
    try {
      const rows = backup
        .prepare(`SELECT id, email, created_at AS createdAt, is_admin AS isAdmin FROM users ORDER BY id`)
        .all();
      expect(rows).toEqual([
        { id: 1, email: "owner@example.com", createdAt: 1000, isAdmin: 1 },
        { id: 7, email: "tester@example.com", createdAt: 2000, isAdmin: 0 },
      ]);
    } finally {
      backup.close();
    }
  });
});
