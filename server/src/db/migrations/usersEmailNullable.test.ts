import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateUsersEmailNullable } from "./usersEmailNullable.js";

// The pre-migration shape, exactly as store.ts created it before this migration existed —
// including the is_admin column that an earlier ALTER adds, since the rebuild must carry it, and
// a real child table (store.ts's sessions) so the rebuild is exercised against the same
// foreign-key shape production has. better-sqlite3 enables PRAGMA foreign_keys by default, so a
// users-only schema here would never reproduce the "FOREIGN KEY constraint failed" the migration
// otherwise throws on DROP TABLE users — every test in this file used to run against exactly that
// blind spot.
function buildLegacyDb(dbPath = ":memory:"): Database.Database {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );
    ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
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

  it("rebuilds without a FOREIGN KEY constraint failure when a child table has rows referencing users", () => {
    // Regression for the actual production failure mode: better-sqlite3 enables PRAGMA
    // foreign_keys by default and store.ts never disables it, so DROP TABLE users performs an
    // implicit DELETE FROM users, which fires an immediate FK check against every child row.
    // Without the foreign_keys toggle in the migration, this insert-then-migrate sequence throws
    // "FOREIGN KEY constraint failed" and the migration never completes.
    const db = buildLegacyDb();
    db.prepare(`INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)`).run(1, "owner@example.com", 1000);
    db.prepare(`INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`).run("sess-1", 1, 1000, 9999);

    expect(() => migrateUsersEmailNullable(db)).not.toThrow();

    expect(db.prepare(`SELECT id, user_id AS userId FROM sessions`).all()).toEqual([{ id: "sess-1", userId: 1 }]);
    // Foreign key enforcement itself must come back on afterward — the toggle is restored, not
    // left off for the rest of the process.
    expect(db.pragma(`foreign_keys`, { simple: true })).toBe(1);
    expect(() =>
      db.prepare(`INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`).run("sess-2", 999, 1000, 9999)
    ).toThrow();
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

  it("restores the AUTOINCREMENT high-water mark so a deleted user's id is never reused", () => {
    const db = buildLegacyDb();
    db.prepare(`INSERT INTO users (email, created_at) VALUES (?, ?)`).run("a@example.com", 1000);
    db.prepare(`INSERT INTO users (email, created_at) VALUES (?, ?)`).run("b@example.com", 2000);
    db.prepare(`INSERT INTO users (email, created_at) VALUES (?, ?)`).run("c@example.com", 3000);
    db.prepare(`DELETE FROM users WHERE id IN (2, 3)`).run();

    migrateUsersEmailNullable(db);

    // Before the fix: DROP TABLE users deletes its sqlite_sequence row, and RENAME installs
    // users_new's own row in its place — which only reflects the max id actually copied (1),
    // not the original high-water mark (3). The next insert would then assign id 2, reusing a
    // deleted user's id — and per findRemainingOwnerReferences (store.ts), handing a brand-new
    // account any leftover rows still keyed to that dead owner_id across the owner-scoped tables.
    const inserted = db.prepare(`INSERT INTO users (email, created_at) VALUES (?, ?)`).run("d@example.com", 4000);
    expect(inserted.lastInsertRowid).toBe(4);
  });

  it("rolls back and leaves the original table (and its child rows) intact when the row-count guard trips", () => {
    // Pre-creating users_new (with a conflicting row, or a stray trigger) only tests that
    // CREATE TABLE fails before the copy ever runs — before the guard, before anything
    // destructive — and, tried against a real BEFORE INSERT trigger, is not even reachable:
    // SQLite refuses to CREATE TRIGGER against a table that doesn't exist yet, and users_new is
    // created by the function under test. A version of this test that pre-created users_new and
    // let CREATE TABLE IF NOT EXISTS no-op against it was reverted — an IF NOT EXISTS here means
    // a stray users_new with the wrong shape (no UNIQUE, no AUTOINCREMENT, no NOT NULL — exactly
    // what a half-finished manual repair would leave) would pass every guard silently, since none
    // of them inspect users_new's own column definitions.
    //
    // So the guard is exercised through the one seam the function actually exposes — its `db`
    // parameter — with a Proxy that forwards everything to the real Database except the
    // migration's own "before" snapshot (`SELECT count(*) AS n FROM users`, matched by exact SQL
    // text so the "after" query against users_new is untouched), which it inflates by one. The
    // copy itself is untouched and genuinely copies both real rows; it is the inflated "before"
    // that the guard's comparison catches.
    const db = buildLegacyDb();
    db.prepare(`INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)`).run(1, "owner@example.com", 1000);
    db.prepare(`INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)`).run(7, "second@example.com", 2000);
    db.prepare(`INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`).run("sess-1", 1, 1000, 9999);

    let intercepted = false;
    const handler: ProxyHandler<Database.Database> = {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            const stmt = target.prepare(sql);
            if (!intercepted && sql === `SELECT count(*) AS n FROM users`) {
              intercepted = true;
              return { get: () => ({ n: (stmt.get() as { n: number }).n + 1 }) };
            }
            return stmt;
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    };
    const proxied = new Proxy(db, handler);

    expect(() => migrateUsersEmailNullable(proxied)).toThrow(/copied 2 of 3 rows/);

    // The original table and its child rows survived the failure — this is the property that
    // matters most: a genuinely tripped guard still rolls back cleanly.
    expect(db.prepare(`SELECT count(*) AS n FROM users`).get()).toEqual({ n: 2 });
    expect(db.prepare(`SELECT count(*) AS n FROM sessions`).get()).toEqual({ n: 1 });
    expect(emailIsNullable(db)).toBe(false);
    // Restoration-on-throw is exactly what the `finally` around rebuild() exists for — the other
    // FK assertion (above) only ever exercised the success path.
    expect(db.pragma(`foreign_keys`, { simple: true })).toBe(1);
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
