import type Database from "better-sqlite3";
import fs from "node:fs";

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
// every boot against a real database. `users` is the rebuild this module owns; it is not the only
// *parent*-table rebuild in the codebase — `documents` (store.ts:571-587) is a known latent
// instance of the exact same hazard, since document_match_keys.document_id REFERENCES
// documents(id) (store.ts:143) and that rebuild does not disable foreign_keys around it. Fixing
// that one is out of scope here. `defer_foreign_keys` does not help either way — the implicit
// delete still raises immediately, deferred or not.
//
// The fix is SQLite's own documented table-rebuild procedure: disable `foreign_keys` around the
// transaction (the pragma is a no-op *inside* one, so it has to be set before rebuild() opens it)
// and restore it in `finally` so a throw never leaves enforcement off. `PRAGMA foreign_key_check`
// after the rename is a second, independent guard beside the row-count check — it runs regardless
// of the enforcement pragma, so it still catches an orphaned reference even if the toggle above
// were ever wrong or removed. It is scoped to violations this rebuild introduced (see
// violationsBefore/violationsAfter below), not a bare unscoped scan — deleteUserCompletely has
// documented history of leaving owner-scoped rows behind (findRemainingOwnerReferences below), so
// a pre-existing orphan elsewhere in the database is plausible, and failing the migration over
// damage this rebuild didn't cause would turn an unrelated pre-existing problem into a boot
// crash-loop.
//
// backupPath is optional and only meaningful when a rebuild is actually about to happen — this
// runs once per boot at most in the success case (the guard below makes every later boot a no-op),
// and unit tests pass no path at all since they run against :memory: (VACUUM INTO requires a real
// source file). The backup is taken with VACUUM INTO rather than the async db.backup() API: it
// needs to finish before the synchronous rebuild below starts touching the schema, not race it.
//
// The caller (store.ts) is expected to pass a FIXED path, not one suffixed with Date.now() —
// this function trusts that and only checks existence, but the reason belongs here since it's
// this function's own repeated-boot behavior that motivates it. If the rebuild below throws
// (e.g. the loud CREATE TABLE failure when a stray users_new already exists), the notnull guard
// above still sees the unmigrated column on every subsequent restart, so this function runs again
// on every boot of a crash loop. A fresh filename each time would write a full copy of the
// database into the same volume on every one of those restarts; skipping when the fixed path
// already exists caps it at one pre-migration snapshot, which is the actual goal.
export function migrateUsersEmailNullable(db: Database.Database, backupPath?: string): void {
  const columns = db.prepare(`PRAGMA table_info(users)`).all() as { name: string; notnull: number }[];
  const email = columns.find((c) => c.name === "email");
  // Already nullable (or a fresh database created from the current schema) — nothing to do.
  if (!email || email.notnull === 0) return;

  // The copy below hardcodes exactly these four columns (id, email, created_at, is_admin) — the
  // only ones users had when this migration was written. A future column added to users in
  // store.ts, ahead of this migration's call site, would silently be dropped by that hardcoded
  // list on the one boot the rebuild actually fires — and no test would ever catch it, since
  // tests run against a fresh DB where this migration no-ops. Failing loudly here instead.
  if (columns.length !== 4) {
    throw new Error(
      `migrateUsersEmailNullable: expected users to have exactly 4 columns (id, email, created_at, is_admin) before the rebuild, found ${columns.length} — the copy list below (and this check) must be updated together`
    );
  }

  if (backupPath) {
    if (fs.existsSync(backupPath)) {
      // Already have the one pre-migration snapshot this is for — see the module comment above
      // for why re-taking it on every crash-loop restart is exactly what must not happen.
      console.log(`migrateUsersEmailNullable: backup already exists at ${backupPath}, skipping`);
    } else {
      // Best-effort: a failed backup must not stop the rebuild, since the rebuild itself is
      // transaction-safe on its own and does not depend on the backup succeeding.
      try {
        db.prepare(`VACUUM INTO ?`).run(backupPath);
      } catch (err) {
        console.error("migrateUsersEmailNullable: pre-migration backup failed", err);
      }
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

    // Scoped, not a bare foreign_key_check: see the module comment above for why a pre-existing
    // orphan elsewhere must not abort this migration. Captured before any of this rebuild's own
    // statements run, so it reflects the database's state walking in.
    const violationsBefore = (db.pragma(`foreign_key_check`) as unknown[]).length;

    // No IF NOT EXISTS. The whole rebuild below is one transaction, so a crash mid-window leaves
    // nothing behind — the only way users_new can already exist is that a human put it there (a
    // half-finished manual repair, a rehearsal against a copy of prod), which is exactly the
    // population most likely to have the wrong shape. Every guard in this function checks row
    // counts and FK references, not users_new's own column definitions — a stray 3-column
    // `users_new (id INTEGER PRIMARY KEY, email TEXT, created_at INTEGER, is_admin INTEGER)`
    // would pass every one of them while silently dropping UNIQUE off email, AUTOINCREMENT off
    // id, and NOT NULL off created_at. Failing loudly at CREATE is the correct behavior here.
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

    if (originalSeq) {
      const restored = db.prepare(`UPDATE sqlite_sequence SET seq = ? WHERE name = 'users'`).run(originalSeq.seq);
      // No row to UPDATE means the copy inserted zero rows (nothing gave users_new a
      // sqlite_sequence entry to rename), so insert the high-water mark instead.
      if (restored.changes === 0) {
        db.prepare(`INSERT INTO sqlite_sequence (name, seq) VALUES ('users', ?)`).run(originalSeq.seq);
      }
    }

    // Second guard alongside the row-count check above: confirms this rebuild didn't orphan any
    // child-table reference into users. Compared against violationsBefore, not zero — an
    // unscoped `violations.length > 0` would abort the migration over a pre-existing orphan this
    // rebuild had nothing to do with, and module-load code aborting is a boot crash-loop. Runs
    // independent of the foreign_keys pragma, so it still catches new damage even if the toggle
    // around this transaction were ever wrong.
    const violationsAfter = (db.pragma(`foreign_key_check`) as unknown[]).length;
    if (violationsAfter > violationsBefore) {
      throw new Error(
        `users rebuild introduced ${violationsAfter - violationsBefore} new foreign key violation(s)`
      );
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
