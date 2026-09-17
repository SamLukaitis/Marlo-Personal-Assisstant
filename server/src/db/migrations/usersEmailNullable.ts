import type Database from "better-sqlite3";

// Phone-first accounts (docs/superpowers/specs/2026-09-17-phone-first-accounts-design.md) need a
// users row with no email, but the column shipped as `email TEXT NOT NULL UNIQUE` and SQLite
// cannot relax NOT NULL in place — the column has to be rebuilt.
//
// UNIQUE is kept deliberately: SQLite allows any number of NULLs in a unique column, so
// phone-only accounts coexist while two accounts still cannot share a real address.
//
// Unlike the api_usage rebuild in store.ts, this runs inside db.transaction(). That is not
// stylistic. CREATE -> copy -> DROP -> RENAME has a window where `users` does not exist, and
// these migrations run unattended at boot; a container killed inside that window would leave a
// database with no users table and 29 tables of rows keyed to owner ids that resolve to nothing.
// SQLite's DDL is transactional, so wrapping it makes a crash a no-op instead of a catastrophe.
//
// backupPath is optional and only meaningful when a rebuild is actually about to happen — this
// runs once per boot at most (the guard below makes every later boot a no-op), and unit tests
// pass no path at all since they run against :memory: (VACUUM INTO requires a real source file).
// The backup is taken with VACUUM INTO rather than the async db.backup() API: it needs to finish
// before the synchronous rebuild below starts touching the schema, not race it.
export function migrateUsersEmailNullable(db: Database.Database, backupPath?: string): void {
  const columns = db.prepare(`PRAGMA table_info(users)`).all() as { name: string; notnull: number }[];
  const email = columns.find((c) => c.name === "email");
  // Already nullable (or a fresh database created from the current schema) — nothing to do.
  if (!email || email.notnull === 0) return;

  if (backupPath) {
    // Best-effort: a failed backup must not stop the rebuild, since the rebuild itself is
    // transaction-safe on its own and does not depend on the backup succeeding.
    try {
      db.prepare(`VACUUM INTO ?`).run(backupPath);
    } catch (err) {
      console.error("migrateUsersEmailNullable: pre-migration backup failed", err);
    }
  }

  const rebuild = db.transaction(() => {
    const before = (db.prepare(`SELECT count(*) AS n FROM users`).get() as { n: number }).n;

    db.exec(`
      CREATE TABLE users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE,
        created_at INTEGER NOT NULL,
        is_admin INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO users_new (id, email, created_at, is_admin)
        SELECT id, email, created_at, is_admin FROM users;
    `);

    // Verified BEFORE the drop, inside the transaction: a short copy throws, the transaction
    // rolls back, and the original table is still there. Without this a silent partial copy
    // would be made permanent by the DROP on the next line.
    const after = (db.prepare(`SELECT count(*) AS n FROM users_new`).get() as { n: number }).n;
    if (after !== before) {
      throw new Error(`users rebuild copied ${after} of ${before} rows — refusing to drop the original`);
    }

    db.exec(`
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
    `);
  });

  rebuild();
}
