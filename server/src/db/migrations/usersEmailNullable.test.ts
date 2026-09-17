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

  it("does not overwrite or duplicate the backup across repeated runs against a rebuild that keeps failing", () => {
    // Regression for the crash-loop disk-fill bug: a persistently-failing rebuild (e.g. a stray
    // users_new left by a half-finished manual repair — see the migration's own CREATE TABLE
    // comment for why that fails loudly instead of silently) means the notnull guard above still
    // sees the unmigrated column on every subsequent boot, so this function runs again on every
    // restart. A Date.now()-suffixed path would write a fresh full-DB backup on every one of
    // those restarts; a fixed path plus "skip if it already exists" must cap it at one.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "users-email-nullable-"));
    const sourcePath = path.join(tmpDir, "source.db");
    const backupPath = path.join(tmpDir, "app.db.bak-users-email-nullable");

    const db = buildLegacyDb(sourcePath);
    db.prepare(`INSERT INTO users (id, email, created_at, is_admin) VALUES (?, ?, ?, ?)`).run(1, "owner@example.com", 1000, 1);
    // No IF NOT EXISTS on the migration's own CREATE TABLE users_new — this pre-existing table is
    // exactly what makes the rebuild fail on every single call below, reproducing the crash loop.
    db.exec(`CREATE TABLE users_new (id INTEGER PRIMARY KEY)`);

    expect(() => migrateUsersEmailNullable(db, backupPath)).toThrow();
    expect(fs.existsSync(backupPath)).toBe(true);
    const firstBackupContent = fs.readFileSync(backupPath);

    // A real database keeps accruing writes between crash-loop restarts — if the backup were
    // re-taken on a later call, this row would show up in it.
    db.prepare(`INSERT INTO users (id, email, created_at, is_admin) VALUES (?, ?, ?, ?)`).run(2, "second@example.com", 2000, 0);

    expect(() => migrateUsersEmailNullable(db, backupPath)).toThrow();
    expect(() => migrateUsersEmailNullable(db, backupPath)).toThrow();

    const backupFiles = fs.readdirSync(tmpDir).filter((f) => f.startsWith("app.db.bak"));
    expect(backupFiles).toEqual(["app.db.bak-users-email-nullable"]);
    expect(fs.readFileSync(backupPath)).toEqual(firstBackupContent);
  });

  it("throws when users has any column count other than the 4 the hardcoded copy list expects", () => {
    // Guards against a future users column landing ahead of this migration's call site in
    // store.ts and being silently dropped by the copy INSERT's hardcoded column list on the one
    // boot the rebuild fires — a scenario no other test can catch, since every other test's DB
    // (and the real one, post-migration) never re-enters this function with email still NOT NULL.
    const db = buildLegacyDb();
    db.exec(`ALTER TABLE users ADD COLUMN nickname TEXT`);

    expect(() => migrateUsersEmailNullable(db)).toThrow(/exactly 4 columns/);
  });

  it("throws when the rebuild introduces a new foreign key violation not present before it started", () => {
    // Real SQLite semantics can't actually trip this guard through normal use: the row-count
    // guard above already catches the only way a legitimate rebuild could orphan a child
    // reference (copying fewer rows than existed), and every surviving row's id is copied
    // verbatim, so no existing child reference is ever invalidated. Exercised the same way as the
    // row-count guard's own test above — through the `db` parameter's only seam, a Proxy that
    // fakes db.pragma('foreign_key_check')'s second (after) answer without touching its first
    // (before) one or any other pragma call.
    const db = buildLegacyDb();
    db.prepare(`INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)`).run(1, "owner@example.com", 1000);

    let foreignKeyCheckCalls = 0;
    const handler: ProxyHandler<Database.Database> = {
      get(target, prop) {
        if (prop === "pragma") {
          return (sql: string, opts?: Database.PragmaOptions) => {
            if (sql === "foreign_key_check") {
              foreignKeyCheckCalls += 1;
              // First call is violationsBefore — let it reflect reality (empty). Second is
              // violationsAfter — faked non-empty to simulate a violation this rebuild
              // "introduced", which nothing about this legitimate rebuild actually does.
              return foreignKeyCheckCalls === 1 ? [] : [{ table: "sessions", rowid: 1, parent: "users", fkid: 0 }];
            }
            return target.pragma(sql, opts as never);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    };
    const proxied = new Proxy(db, handler);

    expect(() => migrateUsersEmailNullable(proxied)).toThrow(/introduced 1 new foreign key violation/);
  });
});
