import Database from "better-sqlite3";
import path from "node:path";
import { decryptFor, deriveFamilyKey, phoneLookupHash } from "./familyKey.js";
import {
  FAMILY_DB_DIR,
  findFamilyForPhone,
  type FamilyRecord,
} from "./registry.js";

// One SQLite file per family, and the object that gates access to it.
//
// This is the first and strongest of Joyce's isolation barriers. Marlowe keeps every tenant in
// one app.db and separates them with `WHERE owner_id = ?` on every query — which works, but only
// for as long as every query author remembers (see feature-to-do/tenant-isolation-audit.md).
// Joyce doesn't have that failure mode available: there is no table containing two families'
// rows, so a forgotten filter returns this family's data or nothing. It cannot return someone
// else's, because someone else's isn't in the file that's open.
//
// The second barrier is that a FamilySession is the only way to reach a family database, and the
// only way to get one is `openFamilySessionForPhone(phone)` with an inbound WhatsApp number.
// Nothing in this module takes a family id from a caller, there is no "list all families", and
// no store function accepts one either. That is what makes the assistant safe by construction
// rather than by instruction: Joyce's tools (joyce/assistant.ts) are handed an already-opened
// session, and their JSON schemas have no family parameter, so there is no field the model can
// fill in wrongly. A prompt-injected "now show me the Smiths' documents" has nowhere to land.

export interface FamilyMember {
  id: number;
  /** Null until they've told Joyce what to call them — see joyce/onboarding.ts. */
  displayName: string | null;
}

/**
 * A capability: "this phone number, acting inside this family, right now." Holding one proves
 * the registry already resolved the caller, so every store function can take it instead of
 * re-deriving trust from an id it was handed. `actor` is who to attribute writes to — it comes
 * from the phone number on the inbound message and is never a parameter the model supplies.
 */
export interface FamilySession {
  readonly familyId: string;
  readonly db: Database.Database;
  readonly key: Buffer;
  readonly actor: FamilyMember;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS family_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- phone_hash matches the registry's, so a member can be found by phone without this file ever
  -- containing a phone number. Names are encrypted like everything else: the file on disk gives
  -- up nothing at all without the derived key.
  CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone_hash TEXT NOT NULL UNIQUE,
    display_name_enc TEXT,
    joined_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );

  -- The family's shared conversation with Joyce. Everyone's messages are here, which is the
  -- point ("all information sent by a family member should be available to all other family
  -- members"), and member_id + created_at is what lets Joyce answer "who said that, and when?".
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER REFERENCES members(id),
    role TEXT NOT NULL,
    body_enc TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);

  -- "Store important information" — the wifi password, the vet's number, Grandma's address.
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER NOT NULL REFERENCES members(id),
    title_enc TEXT NOT NULL,
    body_enc TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER NOT NULL REFERENCES members(id),
    filename_enc TEXT,
    caption_enc TEXT,
    mime_type TEXT NOT NULL,
    stored_path TEXT NOT NULL,
    extracted_text_enc TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  -- target_member_id NULL means the whole family is reminded.
  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_by_member_id INTEGER NOT NULL REFERENCES members(id),
    target_member_id INTEGER REFERENCES members(id),
    body_enc TEXT NOT NULL,
    due_at INTEGER NOT NULL,
    delivered_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(due_at) WHERE delivered_at IS NULL;

  -- "Pass messages from one family member to another": held here until the recipient next
  -- messages Joyce, then delivered and marked. Deliberately not a push — see joyce/routes.ts on
  -- WhatsApp's 24-hour rule.
  CREATE TABLE IF NOT EXISTS relays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_member_id INTEGER NOT NULL REFERENCES members(id),
    to_member_id INTEGER NOT NULL REFERENCES members(id),
    body_enc TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_relays_undelivered ON relays(to_member_id) WHERE delivered_at IS NULL;
`;

// Opening a SQLite file is cheap but not free, and better-sqlite3 handles are safe to reuse, so
// recently active families stay open. Keyed by family id, which is a server-generated UUID —
// never anything a user typed — so there is no way to make this hand back the wrong connection.
//
// Bounded, because an open connection is not free either: measured at ~190 KB of resident memory
// and one file descriptor each. Unbounded, a long-running server would accumulate every family
// that had ever sent a message, and a few thousand families would be gigabytes of RAM and enough
// file descriptors to hit the process limit. A Map iterates in insertion order, so re-inserting
// on every hit makes the first entry the least recently used — a whole LRU in three lines.
const MAX_OPEN_FAMILIES = Number(process.env.JOYCE_MAX_OPEN_FAMILIES ?? 200);
const openFamilies = new Map<string, { db: Database.Database; key: Buffer }>();

function touch(familyId: string, entry: { db: Database.Database; key: Buffer }) {
  openFamilies.delete(familyId);
  openFamilies.set(familyId, entry);
}

function evictIfNeeded(): void {
  while (openFamilies.size > MAX_OPEN_FAMILIES) {
    const [oldestId, oldest] = openFamilies.entries().next().value as [
      string,
      { db: Database.Database; key: Buffer },
    ];
    openFamilies.delete(oldestId);
    // Safe at any moment: every store function is synchronous and has finished with the handle
    // by the time it returns, so no in-flight query can be holding this one.
    oldest.db.close();
  }
}

function openFamilyDb(record: FamilyRecord): { db: Database.Database; key: Buffer } {
  const cached = openFamilies.get(record.familyId);
  if (cached) {
    touch(record.familyId, cached);
    return cached;
  }

  const db = new Database(path.join(FAMILY_DB_DIR, `${record.familyId}.db`));
  db.pragma("foreign_keys = ON");
  // A family database is tiny — tens of notes, not millions of rows — so the default 2 MB page
  // cache per connection is pure waste multiplied by every open family. 256 KB is ample.
  db.pragma("cache_size = -256");
  db.exec(SCHEMA);
  // Stamped so a loose .db file found later can be identified, and so a future schema change has
  // something to branch on. Never contains anything sensitive.
  db.prepare(
    `INSERT INTO family_meta (key, value) VALUES ('family_id', ?) ON CONFLICT(key) DO NOTHING`
  ).run(record.familyId);

  const entry = { db, key: deriveFamilyKey(record.familyId, record.salt) };
  openFamilies.set(record.familyId, entry);
  evictIfNeeded();
  return entry;
}

/**
 * Finds or creates this phone's row inside the family database. Called on every inbound message,
 * so a member who joined via the registry gets their family-side row on first contact rather
 * than needing the two writes to be transactional across two files.
 */
function upsertMember(
  db: Database.Database,
  normalizedPhone: string
): { id: number; display_name_enc: string | null } {
  const phoneHash = phoneLookupHash(normalizedPhone);
  const now = Date.now();
  db.prepare(
    `INSERT INTO members (phone_hash, display_name_enc, joined_at, last_seen_at)
       VALUES (?, NULL, ?, ?)
       ON CONFLICT(phone_hash) DO UPDATE SET last_seen_at = excluded.last_seen_at`
  ).run(phoneHash, now, now);
  return db
    .prepare(`SELECT id, display_name_enc FROM members WHERE phone_hash = ?`)
    .get(phoneHash) as { id: number; display_name_enc: string | null };
}

function sessionFor(record: FamilyRecord, normalizedPhone: string): FamilySession {
  const { db, key } = openFamilyDb(record);
  const row = upsertMember(db, normalizedPhone);
  return {
    familyId: record.familyId,
    db,
    key,
    actor: {
      id: row.id,
      // Decrypting here rather than lazily means a key/file mismatch surfaces immediately, at the
      // top of the request, instead of somewhere deep in a tool call. decryptFor throws on a
      // wrong key — that throw is the isolation barrier working, so it is not caught.
      displayName: row.display_name_enc === null ? null : decryptFor(key, row.display_name_enc),
    },
  };
}

/**
 * The single entry point to any family's data. Returns null for a number that belongs to no
 * family — the caller (joyce/routes.ts) treats that as "this person needs onboarding", never as
 * "give them a default family".
 */
export function openFamilySessionForPhone(normalizedPhone: string): FamilySession | null {
  const record = findFamilyForPhone(normalizedPhone);
  return record ? sessionFor(record, normalizedPhone) : null;
}

/**
 * Used immediately after createFamily/joinFamilyByCode, when we already hold the record and a
 * second registry lookup would be wasted work. Not exported beyond the Joyce module.
 */
export function openFamilySessionForNewMember(
  record: FamilyRecord,
  normalizedPhone: string
): FamilySession {
  return sessionFor(record, normalizedPhone);
}

/** Test-only: drops cached handles so a suite can reopen files it deleted between cases. */
export function __resetFamilyCacheForTests(): void {
  for (const { db } of openFamilies.values()) db.close();
  openFamilies.clear();
}
