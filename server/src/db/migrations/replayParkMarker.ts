import type Database from "better-sqlite3";

// Moves the replay-onboarding park marker off the phone row it applies to and into
// replay_parked_phones.
//
// The first version of the park mechanism (shipped earlier on this same branch) kept the
// user_phone_numbers row and set a nullable unbound_for_replay_at on it, filtering those rows out
// of resolveOwnerByPhone and listPhoneNumbersForUser. That left the row invisible to every reader
// while it went on holding the UNIQUE phone slot against every writer — so a parked number showed
// as bound to nothing, Settings refused to add it ("This phone number is already registered to
// another account"), and reset-test-phone refused to clear it. Deleting the row and recording the
// owner beside it fixes that by construction; this carries any already-deployed DB across.
//
// A no-op on a database that never had the column (every fresh one), and on one where it exists
// but nothing is parked. Safe to run on every boot: the rows it converts stop matching afterwards.
export function migrateReplayParkMarker(db: Database.Database): void {
  const hasColumn = (db.prepare(`PRAGMA table_info(user_phone_numbers)`).all() as { name: string }[]).some(
    (c) => c.name === "unbound_for_replay_at"
  );
  if (!hasColumn) return;

  db.transaction(() => {
    // INSERT OR REPLACE, not plain INSERT: replay_parked_phones.phone is the primary key, and a
    // number could in principle already have an entry from a later replay.
    db.exec(
      `INSERT OR REPLACE INTO replay_parked_phones (phone, owner_id, parked_at)
         SELECT phone, user_id, unbound_for_replay_at FROM user_phone_numbers
         WHERE unbound_for_replay_at IS NOT NULL`
    );
    db.exec(`DELETE FROM user_phone_numbers WHERE unbound_for_replay_at IS NOT NULL`);
  })();

  try {
    db.exec(`ALTER TABLE user_phone_numbers DROP COLUMN unbound_for_replay_at`);
  } catch {
    // DROP COLUMN needs SQLite 3.35+. The drain above already emptied the column and no code reads
    // it any more, so a build that can't drop it is still correct — leaving a dead column behind
    // isn't worth failing boot over.
  }
}
