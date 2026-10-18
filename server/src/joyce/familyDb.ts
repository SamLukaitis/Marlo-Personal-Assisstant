import Database from "better-sqlite3";
import path from "node:path";
import { decryptFor, deriveFamilyKey, encryptFor, phoneLookupHash } from "./familyKey.js";
import {
  FAMILY_DB_DIR,
  consumeGoogleConnectToken,
  familiesWithRemindersDue,
  findFamilyForCalendarToken,
  findFamilyForPhone,
  findFamilyForPhoneHash,
  setReminderScheduleEntry,
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
// only way to get one is `openFamilySessionForPhone(phone)` with an inbound WhatsApp number (or
// a one-time Google connect link that such a message minted — see
// openFamilySessionForGoogleConnect below).
// Nothing in this module takes a family id from a caller, there is no "list all families", and
// no store function accepts one either. That is what makes the assistant safe by construction
// rather than by instruction: Joyce's tools (joyce/assistant.ts) are handed an already-opened
// session, and their JSON schemas have no family parameter, so there is no field the model can
// fill in wrongly. A prompt-injected "now show me the Smiths' documents" has nowhere to land.
//
// Two narrower ways in exist besides a phone number, neither reachable from an AI tool or from
// anything a family member types:
//   - the reminder sender (reminderDelivery.ts) opens families the registry's schedule says have
//     a reminder due — see openFamiliesWithRemindersDue;
//   - a calendar subscription link opens one family's calendar by the secret in the link, the
//     same kind of credential as a join code — see openFamilyForCalendarToken.
// Both hand back a FamilyData (no actor), not a FamilySession, so no member-facing store function
// accepts them unless it was written to.

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

  -- Every member's conversation with Joyce. Each person has their own thread (thread_member_id,
  -- added by migrate below), so what Joyce sees when she replies is only her conversation with
  -- that person — one member's "yes" can't be read as answering something she said to another.
  -- Everything stays in this one family file, and Joyce can still search all of it
  -- (search_family_chat), so what any member tells her remains available to the others.
  -- member_id is who sent a user message; Joyce's own messages have none.
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

  -- "Pass messages from one family member to another". Sent straight away if the recipient has
  -- messaged Joyce in the last 24 hours (relayDelivery.ts); otherwise held here until they next
  -- message, because WhatsApp won't let Joyce message them first.
  CREATE TABLE IF NOT EXISTS relays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_member_id INTEGER NOT NULL REFERENCES members(id),
    to_member_id INTEGER NOT NULL REFERENCES members(id),
    body_enc TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_relays_undelivered ON relays(to_member_id) WHERE delivered_at IS NULL;

  -- Who has received each reminder, pushed by the reminder sender or handed over when they next
  -- messaged. A whole-family reminder is done once every member has a row.
  CREATE TABLE IF NOT EXISTS reminder_deliveries (
    reminder_id INTEGER NOT NULL REFERENCES reminders(id),
    member_id INTEGER NOT NULL REFERENCES members(id),
    delivered_at INTEGER NOT NULL,
    PRIMARY KEY (reminder_id, member_id)
  );

  -- The family calendar. about_member_id NULL means it's for the whole family. Times are stored
  -- in UTC so ranges can be queried; an all-day event also keeps its dates as the family wrote
  -- them, so it doesn't drift to a different day if the family's timezone changes later.
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_by_member_id INTEGER NOT NULL REFERENCES members(id),
    about_member_id INTEGER REFERENCES members(id),
    title_enc TEXT NOT NULL,
    notes_enc TEXT,
    all_day INTEGER NOT NULL DEFAULT 0,
    start_date TEXT,
    end_date TEXT,
    starts_at INTEGER NOT NULL,
    ends_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_starts ON events(starts_at);

  -- Where everything Joyce keeps came from: "this item was made from that one". An item made in
  -- a turn is linked to the member's message that started the turn, and to every note, document,
  -- event, reminder or message whose content Joyce read during it. Deleting a message follows
  -- these links outward and removes everything that came from it (provenance.ts).
  -- item_type/source_type: message, document, note, event, reminder, relay, flag.
  CREATE TABLE IF NOT EXISTS derivations (
    item_type TEXT NOT NULL,
    item_id INTEGER NOT NULL,
    source_type TEXT NOT NULL,
    source_id INTEGER NOT NULL,
    PRIMARY KEY (item_type, item_id, source_type, source_id)
  );
  CREATE INDEX IF NOT EXISTS idx_derivations_source ON derivations(source_type, source_id);

  -- A member's connected Google account (joyce/googleCalendar.ts). One per member: connecting
  -- again replaces it. Tokens are encrypted with the family key like everything else, so the
  -- file on its own gives no access to anyone's calendar. time_zone is the primary calendar's,
  -- read at connect time, and is what calendar times are read and written in.
  CREATE TABLE IF NOT EXISTS google_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER NOT NULL UNIQUE REFERENCES members(id),
    email_enc TEXT NOT NULL,
    access_token_enc TEXT,
    refresh_token_enc TEXT,
    expiry_date INTEGER,
    time_zone TEXT NOT NULL,
    connected_at INTEGER NOT NULL
  );
`;

// Columns added after families already existed. SCHEMA's CREATE TABLE IF NOT EXISTS doesn't
// touch an existing table, so each is added here when missing — run on every open, cheap.
function migrate(db: Database.Database): void {
  const columns = (table: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  // The member's WhatsApp number, encrypted, so Joyce can send them a reminder. Filled in from
  // their next message for members who joined before it was kept.
  if (!columns("members").includes("phone_enc")) {
    db.exec(`ALTER TABLE members ADD COLUMN phone_enc TEXT`);
  }
  // Set once the reminder sender has tried to push a reminder, whatever the outcome — anyone it
  // couldn't reach gets it when they next message instead, so it's never retried every minute.
  if (!columns("reminders").includes("push_attempted_at")) {
    db.exec(`ALTER TABLE reminders ADD COLUMN push_attempted_at INTEGER`);
  }
  // Which member's conversation a message belongs to. For messages written before threads
  // existed: a member's own message is in their thread, and each reply of Joyce's goes in the
  // thread of the most recent message she was answering.
  if (!columns("messages").includes("thread_member_id")) {
    db.exec(`
      ALTER TABLE messages ADD COLUMN thread_member_id INTEGER REFERENCES members(id);
      UPDATE messages SET thread_member_id = member_id WHERE role = 'user';
      UPDATE messages SET thread_member_id = (
        SELECT u.member_id FROM messages u
         WHERE u.role = 'user' AND u.id < messages.id ORDER BY u.id DESC LIMIT 1
      ) WHERE role = 'assistant';
      CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_member_id, id);
    `);
  }
  // The WhatsApp id of a member's message, so a swipe-reply to it ("delete this") can find it.
  if (!columns("messages").includes("wamid")) {
    db.exec(`
      ALTER TABLE messages ADD COLUMN wamid TEXT;
      CREATE INDEX IF NOT EXISTS idx_messages_wamid ON messages(wamid);
    `);
  }
  // Who an event is for when that person isn't a member — usually a child without a phone
  // ("Leo's dentist"). Encrypted; about_member_id stays NULL.
  if (!columns("events").includes("about_label_enc")) {
    db.exec(`ALTER TABLE events ADD COLUMN about_label_enc TEXT`);
  }
}

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
  migrate(db);
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
  key: Buffer,
  normalizedPhone: string
): MemberRow {
  const phoneHash = phoneLookupHash(normalizedPhone);
  const now = Date.now();
  // last_seen_at is also what tells the reminder sender whether WhatsApp's 24-hour window is
  // open for this member — see reminderDelivery.ts.
  db.prepare(
    `INSERT INTO members (phone_hash, display_name_enc, joined_at, last_seen_at, phone_enc)
       VALUES (?, NULL, ?, ?, ?)
       ON CONFLICT(phone_hash) DO UPDATE SET last_seen_at = excluded.last_seen_at,
                                             phone_enc = excluded.phone_enc`
  ).run(phoneHash, now, now, encryptFor(key, normalizedPhone));
  return db
    .prepare(`SELECT id, display_name_enc FROM members WHERE phone_hash = ?`)
    .get(phoneHash) as MemberRow;
}

type MemberRow = { id: number; display_name_enc: string | null };

function sessionFor(record: FamilyRecord, normalizedPhone: string): FamilySession {
  const { db, key } = openFamilyDb(record);
  return sessionWith(record, db, key, upsertMember(db, key, normalizedPhone));
}

function sessionWith(record: FamilyRecord, db: Database.Database, key: Buffer, row: MemberRow): FamilySession {
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
 * The second way in, for the browser finishing a Google Calendar connection, which has a
 * connect link rather than a phone number. The link was minted by an inbound message from one
 * phone (registry.ts's issueGoogleConnectToken), so spending it opens that phone's family as
 * that member — the same session the message itself would have had, and still no family id
 * anywhere. Null if the link is unknown, expired, already used, or the member has since left.
 *
 * Looks the member up rather than upserting: a browser visit isn't a WhatsApp message, so it
 * mustn't move last_seen_at (which says whether WhatsApp's 24-hour window is open) and there's
 * no phone number here to store anyway.
 */
export function openFamilySessionForGoogleConnect(token: string): FamilySession | null {
  const phoneHash = consumeGoogleConnectToken(token);
  if (!phoneHash) return null;
  const record = findFamilyForPhoneHash(phoneHash);
  if (!record) return null;
  const { db, key } = openFamilyDb(record);
  const row = db
    .prepare(`SELECT id, display_name_enc FROM members WHERE phone_hash = ?`)
    .get(phoneHash) as MemberRow | undefined;
  return row ? sessionWith(record, db, key, row) : null;
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

/** A family's data with nobody acting — for the reminder sender and the calendar feed. */
export type FamilyData = Pick<FamilySession, "familyId" | "db" | "key">;

function dataFor(record: FamilyRecord): FamilyData {
  const { db, key } = openFamilyDb(record);
  return { familyId: record.familyId, db, key };
}

/** For the reminder sender only: every family the registry's schedule says has a reminder due. */
export function openFamiliesWithRemindersDue(now: number): FamilyData[] {
  return familiesWithRemindersDue(now).map(dataFor);
}

/** For the calendar subscription route only. Null for an unknown or replaced link. */
export function openFamilyForCalendarToken(token: string): FamilyData | null {
  const record = findFamilyForCalendarToken(token);
  return record ? dataFor(record) : null;
}

/**
 * Tells the registry when this family's next unsent reminder is due (or that it has none), so
 * the reminder sender can find it. Call after anything that adds, sends or claims a reminder.
 */
export function syncReminderSchedule(family: FamilyData): void {
  const row = family.db
    .prepare(
      `SELECT MIN(due_at) AS next FROM reminders
        WHERE delivered_at IS NULL AND push_attempted_at IS NULL`
    )
    .get() as { next: number | null };
  setReminderScheduleEntry(family.familyId, row.next);
}

/** Test-only: drops cached handles so a suite can reopen files it deleted between cases. */
export function __resetFamilyCacheForTests(): void {
  for (const { db } of openFamilies.values()) db.close();
  openFamilies.clear();
}
