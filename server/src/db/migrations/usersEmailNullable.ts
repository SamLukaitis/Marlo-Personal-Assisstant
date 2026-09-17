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
// better-sqlite3 enables `PRAGMA foreign_keys` by default and store.ts never disables it, so
// `DROP TABLE users` below performs an implicit `DELETE FROM users` that fires immediate FK
// checks against every one of the 29 child tables (sessions, user_phone_numbers, ...) — it throws
// "FOREIGN KEY constraint failed" even for a single row, and the server would crash-loop on
// every boot against a real database. `users` is the only *parent*-table rebuild in this file;
// the other rebuilds in store.ts (api_usage, accounts, ...) are children, so dropping them is
// legal with FKs on and this problem is specific to this migration. `defer_foreign_keys` does not
// help — the implicit delete still raises immediately, deferred or not.
//
// The fix is SQLite's own documented table-rebuild procedure: disable `foreign_keys` around the
// transaction (the pragma is a no-op *inside* one, so it has to be set before rebuild() opens it)
// and restore it in `finally` so a throw never leaves enforcement off. `PRAGMA foreign_key_check`
// after the rename is a second, independent guard beside the row-count check — it runs regardless
// of the enforcement pragma, so it still catches an orphaned reference even if the toggle above
// were ever wrong or removed.
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

    // AUTOINCREMENT tracks the highest id ever used in sqlite_sequence, keyed by table name.
    // DROP TABLE users deletes that row; RENAME installs users_new's row in its place, which
    // only reflects the max id actually copied — lower than the original high-water mark
    // whenever a user was ever deleted. Left alone, the next INSERT would reuse a dead user's
    // id, and every owner-scoped table (see findRemainingOwnerReferences below) would then read
    // as if the new account owned that dead user's leftover rows. Captured here, before the
    // drop, so it can be restored after the rename.
    const originalSeq = db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'users'`).get() as
      | { seq: number }
      | undefined;

    // IF NOT EXISTS: under normal operation users_new never pre-exists (the whole rebuild is one
    // transaction, so a crash mid-window leaves nothing behind), but treating a stray leftover as
    // fatal here would mean a human's old debugging artifact — or a test setting up a controlled
    // short-copy scenario for the row-count guard below — blocks the migration at CREATE, before
    // the copy even runs, which is a strictly worse failure mode than the guards that follow.
    db.exec(`
      CREATE TABLE IF NOT EXISTS users_new (
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

    if (originalSeq) {
      const restored = db.prepare(`UPDATE sqlite_sequence SET seq = ? WHERE name = 'users'`).run(originalSeq.seq);
      // No row to UPDATE means the copy inserted zero rows (nothing gave users_new a
      // sqlite_sequence entry to rename), so insert the high-water mark instead.
      if (restored.changes === 0) {
        db.prepare(`INSERT INTO sqlite_sequence (name, seq) VALUES ('users', ?)`).run(originalSeq.seq);
      }
    }

    // Second guard alongside the row-count check above: confirms every child-table reference
    // into users still resolves post-rebuild. Runs independent of the foreign_keys pragma, so
    // it still catches damage even if the toggle around this transaction were ever wrong.
    const violations = db.pragma(`foreign_key_check`) as unknown[];
    if (violations.length > 0) {
      throw new Error(`users rebuild left ${violations.length} foreign key violation(s): ${JSON.stringify(violations)}`);
    }
  });

  // Must be set outside the transaction — SQLite documents this pragma as a no-op once a
  // transaction is open — and restored in `finally` so a throw (row-count guard, FK-check guard,
  // or anything else) never leaves foreign key enforcement off for the rest of the process.
  const foreignKeysWereOn = db.pragma(`foreign_keys`, { simple: true }) === 1;
  db.pragma(`foreign_keys = OFF`);
  try {
    rebuild();
  } finally {
    db.pragma(`foreign_keys = ${foreignKeysWereOn ? "ON" : "OFF"}`);
  }
}
