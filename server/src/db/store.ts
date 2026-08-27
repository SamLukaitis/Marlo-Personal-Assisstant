import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { encryptField, decryptField } from "../services/crypto.js";

// DATA_DIR lets tests (see server/src/test/setup.ts) point this at an isolated temp directory
// instead of the real server/data — unset in normal dev/production, where this falls back to
// the existing behavior unchanged.
const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
// Printed once at startup so a Railway Volume (or any host's persistent-disk mount) can be
// pointed at the exact right path — guessing wrong here silently loses the DB + uploads on
// every redeploy, since the container filesystem is otherwise ephemeral.
console.log(`store: using data directory ${dataDir}`);

const db = new Database(path.join(dataDir, "app.db"));

// Tables are always created in their ORIGINAL (pre-multi-tenant) shape here — CREATE TABLE IF
// NOT EXISTS is a no-op on an existing DB, and the migration block below brings every one of
// them forward to the current shape (adding owner_id, etc.), the same way earlier migrations
// (auth_broken, travel_checkins.source) already did. This keeps one migration code path that's
// exercised identically whether the DB is brand new or years old.
db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    email TEXT NOT NULL,
    access_token TEXT,
    refresh_token TEXT,
    expiry_date INTEGER,
    UNIQUE(provider, email)
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS local_roots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    label TEXT
  );
  CREATE TABLE IF NOT EXISTS briefings (
    date TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS memory_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS whatsapp_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_phone ON whatsapp_messages(phone);
  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    filename TEXT,
    mime_type TEXT NOT NULL,
    stored_path TEXT NOT NULL,
    caption TEXT,
    title TEXT,
    extracted_text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS travel_checkins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    country TEXT,
    city TEXT,
    checked_in_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS alerted_messages (
    key TEXT PRIMARY KEY,
    alerted_at INTEGER NOT NULL
  );

  -- Multi-tenant tables — always safe to create fresh (no pre-existing data to migrate into
  -- these; they simply didn't exist before).
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS invited_emails (
    email TEXT PRIMARY KEY,
    invited_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
  CREATE TABLE IF NOT EXISTS user_phone_numbers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    phone TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_user_phone_numbers_user ON user_phone_numbers(user_id);
  CREATE TABLE IF NOT EXISTS user_enabled_tools (
    owner_id INTEGER NOT NULL REFERENCES users(id),
    tool_key TEXT NOT NULL,
    enabled_at INTEGER NOT NULL,
    PRIMARY KEY(owner_id, tool_key)
  );
  CREATE TABLE IF NOT EXISTS pending_whatsapp_registrations (
    phone TEXT PRIMARY KEY,
    step TEXT NOT NULL,
    name TEXT,
    typed_email TEXT,
    token_hash TEXT,
    token_expires_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pending_reg_token_hash ON pending_whatsapp_registrations(token_hash);
  CREATE TABLE IF NOT EXISTS document_match_keys (
    document_id INTEGER PRIMARY KEY REFERENCES documents(id),
    owner_id INTEGER NOT NULL REFERENCES users(id),
    reference_code TEXT,
    flight_number TEXT,
    vendor TEXT,
    event_date TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_document_match_keys_owner ON document_match_keys(owner_id, created_at);

  -- Generic entity store (docs/entities-and-links-guide.md): a typed, owner-scoped "thing derived
  -- from a document" (travel check-in, expense, trip, ...). Type-specific fields live in the JSON
  -- data column rather than as real columns, so adding a new entity type is a data change, not a
  -- schema change. Foundation only for now — nothing reads/writes this table yet.
  CREATE TABLE IF NOT EXISTS entities (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id   INTEGER NOT NULL REFERENCES users(id),
    type       TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'active',
    data       TEXT NOT NULL,
    confidence REAL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_entities_owner_type ON entities(owner_id, type);

  -- Generic link store (docs/entities-and-links-guide.md): connects two records — either an
  -- entity or a document, by id — with a labelled relation ('extracted_from', 'belongs_to',
  -- 'relates_to'). This is what lets several documents/entities all attach to one grouping
  -- entity (e.g. a trip), instead of hardcoding one foreign key per relationship as
  -- travel_checkins.document_id currently does. Foundation only for now.
  CREATE TABLE IF NOT EXISTS links (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id   INTEGER NOT NULL REFERENCES users(id),
    relation   TEXT NOT NULL,
    from_type  TEXT NOT NULL,
    from_id    INTEGER NOT NULL,
    to_type    TEXT NOT NULL,
    to_id      INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_links_from ON links(owner_id, from_type, from_id);
  CREATE INDEX IF NOT EXISTS idx_links_to   ON links(owner_id, to_type, to_id);
`);

// Lightweight migration: CREATE TABLE IF NOT EXISTS doesn't add columns to a table that
// already existed before this field was introduced, so add it explicitly if missing.
const accountColumns = (db.prepare(`PRAGMA table_info(accounts)`).all() as { name: string }[]).map(
  (c) => c.name
);
if (!accountColumns.includes("auth_broken")) {
  db.exec(`ALTER TABLE accounts ADD COLUMN auth_broken INTEGER NOT NULL DEFAULT 0`);
}
if (!accountColumns.includes("auth_broken_at")) {
  db.exec(`ALTER TABLE accounts ADD COLUMN auth_broken_at INTEGER`);
}

// travel_checkins originally required lat/long (phone GPS check-ins only). Document-derived
// entries (a boarding pass's arrival city) don't have exact coordinates, so lat/long need to
// become nullable — SQLite can't ALTER a column's NOT NULL constraint directly, so rebuild the
// table when the new "source" column (a proxy for "hasn't been migrated yet") is missing.
const checkinColumns = (
  db.prepare(`PRAGMA table_info(travel_checkins)`).all() as { name: string }[]
).map((c) => c.name);
if (!checkinColumns.includes("source")) {
  db.exec(`
    CREATE TABLE travel_checkins_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      latitude REAL,
      longitude REAL,
      country TEXT,
      city TEXT,
      checked_in_at INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'phone',
      document_id INTEGER
    );
    INSERT INTO travel_checkins_new (id, latitude, longitude, country, city, checked_in_at, source, document_id)
      SELECT id, latitude, longitude, country, city, checked_in_at, 'phone', NULL FROM travel_checkins;
    DROP TABLE travel_checkins;
    ALTER TABLE travel_checkins_new RENAME TO travel_checkins;
  `);
}

// Multi-tenant migration: adds owner_id to every table that previously had zero tenant
// scoping. A NOT NULL owner_id on a table with existing rows needs the full rebuild pattern
// (SQLite can't ALTER ADD a NOT NULL column without a default, and a hardcoded default would be
// wrong once a second tenant exists) — same mechanical pattern as the travel_checkins migration
// above. Runs once, wrapped in a transaction so a crash mid-migration rolls back cleanly instead
// of leaving some tables migrated and others not (the accounts.owner_id check below would then
// incorrectly think migration is complete on the next boot).
const hasOwnerId = (db.prepare(`PRAGMA table_info(accounts)`).all() as { name: string }[]).some(
  (c) => c.name === "owner_id"
);
if (!hasOwnerId) {
  const migrateToMultiTenant = db.transaction(() => {
    const APP_OWNER_EMAIL = normalizeEmail(process.env.APP_OWNER_EMAIL ?? "samlukaitis5@gmail.com");
    const now = Date.now();

    let ownerRow = db.prepare(`SELECT id FROM users WHERE email = ?`).get(APP_OWNER_EMAIL) as
      | { id: number }
      | undefined;
    if (!ownerRow) {
      const info = db
        .prepare(`INSERT INTO users (email, created_at) VALUES (?, ?)`)
        .run(APP_OWNER_EMAIL, now);
      ownerRow = { id: Number(info.lastInsertRowid) };
    }
    const ownerId = ownerRow.id;
    db.prepare(`INSERT OR IGNORE INTO invited_emails (email, invited_at) VALUES (?, ?)`).run(
      APP_OWNER_EMAIL,
      now
    );

    // Capture the pre-migration global WhatsApp allow-list before settings is rebuilt, so it
    // can be seeded into the new per-user user_phone_numbers table below.
    let existingAllowedNumbers: string[] = [];
    try {
      const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get("whatsapp_allowed_numbers") as
        | { value: string }
        | undefined;
      if (row?.value) {
        const parsed = JSON.parse(row.value);
        if (Array.isArray(parsed)) existingAllowedNumbers = parsed;
      }
    } catch {
      // malformed/missing — nothing to seed, not fatal to the migration
    }

    db.exec(`
      CREATE TABLE accounts_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_id INTEGER NOT NULL REFERENCES users(id),
        provider TEXT NOT NULL,
        email TEXT NOT NULL,
        access_token TEXT,
        refresh_token TEXT,
        expiry_date INTEGER,
        auth_broken INTEGER NOT NULL DEFAULT 0,
        auth_broken_at INTEGER,
        UNIQUE(owner_id, provider, email)
      );
    `);
    db.prepare(
      `INSERT INTO accounts_new (id, owner_id, provider, email, access_token, refresh_token, expiry_date, auth_broken, auth_broken_at)
       SELECT id, ?, provider, email, access_token, refresh_token, expiry_date, auth_broken, auth_broken_at FROM accounts`
    ).run(ownerId);
    db.exec(`DROP TABLE accounts; ALTER TABLE accounts_new RENAME TO accounts;`);

    db.exec(`
      CREATE TABLE settings_new (
        owner_id INTEGER NOT NULL REFERENCES users(id),
        key TEXT NOT NULL,
        value TEXT,
        PRIMARY KEY(owner_id, key)
      );
    `);
    db.prepare(`INSERT INTO settings_new (owner_id, key, value) SELECT ?, key, value FROM settings`).run(
      ownerId
    );
    db.exec(`DROP TABLE settings; ALTER TABLE settings_new RENAME TO settings;`);

    db.exec(`
      CREATE TABLE local_roots_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_id INTEGER NOT NULL REFERENCES users(id),
        path TEXT NOT NULL,
        label TEXT,
        UNIQUE(owner_id, path)
      );
    `);
    db.prepare(
      `INSERT INTO local_roots_new (id, owner_id, path, label) SELECT id, ?, path, label FROM local_roots`
    ).run(ownerId);
    db.exec(`DROP TABLE local_roots; ALTER TABLE local_roots_new RENAME TO local_roots;`);

    db.exec(`
      CREATE TABLE briefings_new (
        owner_id INTEGER NOT NULL REFERENCES users(id),
        date TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(owner_id, date)
      );
    `);
    db.prepare(
      `INSERT INTO briefings_new (owner_id, date, content, created_at) SELECT ?, date, content, created_at FROM briefings`
    ).run(ownerId);
    db.exec(`DROP TABLE briefings; ALTER TABLE briefings_new RENAME TO briefings;`);

    db.exec(`
      CREATE TABLE memory_notes_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_id INTEGER NOT NULL REFERENCES users(id),
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    db.prepare(
      `INSERT INTO memory_notes_new (id, owner_id, content, created_at) SELECT id, ?, content, created_at FROM memory_notes`
    ).run(ownerId);
    db.exec(`DROP TABLE memory_notes; ALTER TABLE memory_notes_new RENAME TO memory_notes;`);

    db.exec(`
      CREATE TABLE whatsapp_messages_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_id INTEGER NOT NULL REFERENCES users(id),
        phone TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    db.prepare(
      `INSERT INTO whatsapp_messages_new (id, owner_id, phone, role, content, created_at)
       SELECT id, ?, phone, role, content, created_at FROM whatsapp_messages`
    ).run(ownerId);
    db.exec(`
      DROP TABLE whatsapp_messages;
      ALTER TABLE whatsapp_messages_new RENAME TO whatsapp_messages;
      CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_phone ON whatsapp_messages(phone);
    `);

    db.exec(`
      CREATE TABLE documents_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_id INTEGER NOT NULL REFERENCES users(id),
        phone TEXT NOT NULL,
        filename TEXT,
        mime_type TEXT NOT NULL,
        stored_path TEXT NOT NULL,
        caption TEXT,
        extracted_text TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    db.prepare(
      `INSERT INTO documents_new (id, owner_id, phone, filename, mime_type, stored_path, caption, extracted_text, created_at)
       SELECT id, ?, phone, filename, mime_type, stored_path, caption, extracted_text, created_at FROM documents`
    ).run(ownerId);
    db.exec(`DROP TABLE documents; ALTER TABLE documents_new RENAME TO documents;`);

    db.exec(`
      CREATE TABLE travel_checkins_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_id INTEGER NOT NULL REFERENCES users(id),
        latitude REAL,
        longitude REAL,
        country TEXT,
        city TEXT,
        checked_in_at INTEGER NOT NULL,
        source TEXT NOT NULL DEFAULT 'phone',
        document_id INTEGER
      );
    `);
    db.prepare(
      `INSERT INTO travel_checkins_new (id, owner_id, latitude, longitude, country, city, checked_in_at, source, document_id)
       SELECT id, ?, latitude, longitude, country, city, checked_in_at, source, document_id FROM travel_checkins`
    ).run(ownerId);
    db.exec(`DROP TABLE travel_checkins; ALTER TABLE travel_checkins_new RENAME TO travel_checkins;`);

    db.exec(`
      CREATE TABLE alerted_messages_new (
        owner_id INTEGER NOT NULL REFERENCES users(id),
        key TEXT NOT NULL,
        alerted_at INTEGER NOT NULL,
        PRIMARY KEY(owner_id, key)
      );
    `);
    db.prepare(
      `INSERT INTO alerted_messages_new (owner_id, key, alerted_at) SELECT ?, key, alerted_at FROM alerted_messages`
    ).run(ownerId);
    db.exec(`DROP TABLE alerted_messages; ALTER TABLE alerted_messages_new RENAME TO alerted_messages;`);

    // Seed the owner's pre-existing WhatsApp allow-list into the new per-user phone table.
    for (const phone of existingAllowedNumbers) {
      const normalized = phone.replace(/[^0-9]/g, "");
      if (normalized) {
        db.prepare(
          `INSERT OR IGNORE INTO user_phone_numbers (user_id, phone, created_at) VALUES (?, ?, ?)`
        ).run(ownerId, normalized, now);
      }
    }
  });

  migrateToMultiTenant();
  console.log("store: migrated to multi-tenant schema (owner_id added to every table)");
}

// One-time backfill: user_enabled_tools started empty for every user, including users who
// already existed before this feature shipped — on deploy that would silently flip their prior
// always-on Teams chat / travel tracker to off with no notice. If the table is still empty AND
// there's at least one pre-existing user, seed both tools as enabled for every one of them so
// upgrading preserves prior behavior. Guarded the same way as hasOwnerId above: once this has
// run once (or a real user has toggled anything), the table is non-empty and this never fires
// again — a new signup after that point still correctly starts with both tools off, since the
// guard's emptiness check is what's being read, not "does this specific user have rows yet".
const hasEnabledToolsRows = !!db.prepare(`SELECT 1 FROM user_enabled_tools LIMIT 1`).get();
if (!hasEnabledToolsRows) {
  const preExistingUserIds = (db.prepare(`SELECT id FROM users`).all() as { id: number }[]).map(
    (r) => r.id
  );
  if (preExistingUserIds.length > 0) {
    const backfillEnabledTools = db.transaction(() => {
      const now = Date.now();
      const insert = db.prepare(
        `INSERT INTO user_enabled_tools (owner_id, tool_key, enabled_at) VALUES (?, ?, ?)
         ON CONFLICT(owner_id, tool_key) DO NOTHING`
      );
      for (const userId of preExistingUserIds) {
        insert.run(userId, "teams", now);
        insert.run(userId, "travel", now);
      }
    });
    backfillEnabledTools();
    console.log(
      `store: backfilled user_enabled_tools (teams+travel enabled) for ${preExistingUserIds.length} pre-existing user(s)`
    );
  }
}

// Documents used to be listed by their raw WhatsApp caption, which is whatever the user happened
// to type when sending the file — often a whole sentence, sometimes nothing at all. The
// extraction pass now also names the document, and that name lives here. Nullable on purpose:
// rows saved before this shipped have no title and fall back to filename/caption in the UI.
// Runs after the multi-tenant rebuild above, which recreates `documents` without this column.
const documentColumns = (
  db.prepare(`PRAGMA table_info(documents)`).all() as { name: string }[]
).map((c) => c.name);
if (!documentColumns.includes("title")) {
  db.exec(`ALTER TABLE documents ADD COLUMN title TEXT`);
}

// Groups documents on the Files page (Travel / ID & Legal / Receipts & Bookings / Other) —
// assigned by the same extraction call that already names the document, so it costs nothing
// extra. Nullable and deliberately distinct from "other": null means "predates this feature or
// couldn't be analyzed", "other" means the model looked and it genuinely didn't fit.
if (!documentColumns.includes("category")) {
  db.exec(`ALTER TABLE documents ADD COLUMN category TEXT`);
}

// Set once a receipt has actually been emailed to the owner's Xero forwarding address (see
// xeroForwarding.ts) — null means "never forwarded" (predates the feature, wasn't a receipt, or
// forwarding hasn't run yet). Exists so a future retry/resend path can tell what's already gone
// out instead of re-sending it.
if (!documentColumns.includes("xero_forwarded_at")) {
  db.exec(`ALTER TABLE documents ADD COLUMN xero_forwarded_at INTEGER`);
}

// Origin of a saved document — every row before this shipped is implicitly 'whatsapp'. The three
// email_* columns are only set for source='email' rows, populated by ingestEmailAttachment
// (documents.ts) and used by findDocumentByEmailAttachment to dedup re-extraction of the same
// attachment. See docs/superpowers/specs/2026-08-26-email-search-depth-and-attachment-extraction-design.md
// for why this is three additive columns rather than a `phone` rebuild.
if (!documentColumns.includes("source")) {
  db.exec(`ALTER TABLE documents ADD COLUMN source TEXT NOT NULL DEFAULT 'whatsapp'`);
}
if (!documentColumns.includes("email_account_id")) {
  db.exec(`ALTER TABLE documents ADD COLUMN email_account_id INTEGER`);
}
if (!documentColumns.includes("email_message_id")) {
  db.exec(`ALTER TABLE documents ADD COLUMN email_message_id TEXT`);
}
if (!documentColumns.includes("email_attachment_id")) {
  db.exec(`ALTER TABLE documents ADD COLUMN email_attachment_id TEXT`);
}

// One-time relabel: 'receipts_bookings' was split into 'receipts' (booking confirmations moved
// under 'travel', where they arguably always belonged — see JAKES_TODO.md 2026-08-24). Plain
// UPDATE rather than a guarded block since it's naturally idempotent: once no row has the old
// value, this is a no-op on every subsequent boot.
db.exec(`UPDATE documents SET category = 'receipts' WHERE category = 'receipts_bookings'`);

// One-time migration (docs/entities-and-links-guide.md §7 step 2): copy every existing
// travel_checkins row into the generic entities table as type='travel_checkin', with a link back
// to its source document where one exists. This is the proof the generic entities/links shape
// holds for a real, already-existing type before a second type (expenses) gets built on it.
// travel_checkins itself is left untouched (rows and all) as a rollback point — saveCheckin/
// listCheckins below now read and write entities instead, so this only ever needs to run once,
// guarded by "does an entities row of this type already exist" rather than re-diffing every boot.
const hasMigratedCheckins = !!db.prepare(`SELECT 1 FROM entities WHERE type = 'travel_checkin' LIMIT 1`).get();
if (!hasMigratedCheckins) {
  const oldCheckins = db
    .prepare(
      `SELECT id, owner_id AS ownerId, latitude, longitude, country, city,
         checked_in_at AS checkedInAt, source, document_id AS documentId
       FROM travel_checkins`
    )
    .all() as {
    id: number;
    ownerId: number;
    latitude: number | null;
    longitude: number | null;
    country: string | null;
    city: string | null;
    checkedInAt: number;
    source: string;
    documentId: number | null;
  }[];

  if (oldCheckins.length > 0) {
    const migrateCheckins = db.transaction(() => {
      const now = Date.now();
      const insertEntity = db.prepare(
        `INSERT INTO entities (owner_id, type, status, data, confidence, created_at, updated_at)
         VALUES (?, 'travel_checkin', 'active', ?, NULL, ?, ?)`
      );
      const insertLink = db.prepare(
        `INSERT INTO links (owner_id, relation, from_type, from_id, to_type, to_id, created_at)
         VALUES (?, 'extracted_from', 'entity', ?, 'document', ?, ?)`
      );
      for (const row of oldCheckins) {
        const data = {
          latitude: row.latitude,
          longitude: row.longitude,
          country: row.country,
          city: row.city,
          checkedInAt: row.checkedInAt,
          source: row.source,
        };
        const info = insertEntity.run(row.ownerId, JSON.stringify(data), now, now);
        if (row.documentId != null) {
          insertLink.run(row.ownerId, info.lastInsertRowid, row.documentId, now);
        }
      }
    });
    migrateCheckins();
    console.log(`store: migrated ${oldCheckins.length} travel_checkins row(s) into entities`);
  }
}

// Powers proactive memory surfacing: an optional point in time a memory becomes worth mentioning
// unprompted (a stated deadline, a recurring commitment), and when it was last pushed so it never
// repeats. Both nullable — an ordinary fact/preference leaves both null, unchanged from before.
const memoryNoteColumns = (
  db.prepare(`PRAGMA table_info(memory_notes)`).all() as { name: string }[]
).map((c) => c.name);
if (!memoryNoteColumns.includes("trigger_at")) {
  db.exec(`ALTER TABLE memory_notes ADD COLUMN trigger_at INTEGER`);
}
if (!memoryNoteColumns.includes("last_surfaced_at")) {
  db.exec(`ALTER TABLE memory_notes ADD COLUMN last_surfaced_at INTEGER`);
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_notes_trigger ON memory_notes (owner_id, trigger_at)`);

// When a number last sent us a message — powers the outbound-message-type decision in
// outbound.ts (WhatsApp only allows free-form replies within 24h of the user's last message;
// past that, a proactive push has to go out as a pre-approved template or Meta rejects it with
// error 131047). Null means "never messaged us, or predates this column" — treated as outside
// the window, which is the safe default (falls back to a template rather than risking a failed
// send).
const userPhoneNumberColumns = (
  db.prepare(`PRAGMA table_info(user_phone_numbers)`).all() as { name: string }[]
).map((c) => c.name);
if (!userPhoneNumberColumns.includes("last_inbound_at")) {
  db.exec(`ALTER TABLE user_phone_numbers ADD COLUMN last_inbound_at INTEGER`);
}

// Which OAuth provider the person picked at the "Gmail or Outlook?" button step of registration
// — see services/whatsappRegistration.ts. Needed so a later "resend" only re-sends that one link
// instead of going back to asking.
const pendingRegColumns = (
  db.prepare(`PRAGMA table_info(pending_whatsapp_registrations)`).all() as { name: string }[]
).map((c) => c.name);
if (!pendingRegColumns.includes("provider")) {
  db.exec(`ALTER TABLE pending_whatsapp_registrations ADD COLUMN provider TEXT`);
}

// Tracks the one outstanding yes/no button question in the post-OAuth-connect setup chain (daily
// briefing, then Teams search, then Schengen tracking) — see services/postConnectSetup.ts. A
// registered number is routed straight to the real assistant (handleIncoming), not the
// registration state machine, so this is what lets a button tap answering one of those questions
// be recognized instead of falling through as an unrecognized interactive message. One row per
// owner; deleted once the chain finishes (or never created if the chain wasn't started).
db.exec(`
  CREATE TABLE IF NOT EXISTS pending_setup (
    owner_id INTEGER PRIMARY KEY REFERENCES users(id),
    step TEXT NOT NULL
  );
`);

// Backs ask_user_choice (assistant.ts): a closed-set question rendered as WhatsApp buttons/a
// list, tapped later. 'confirm' rows store the exact tool+args to run on a Yes tap (executed
// directly, no further LLM call); 'resume' rows store the option labels to inject back into the
// conversation as a synthetic user message. See actionHandlers.ts for the consuming side.
db.exec(`
  CREATE TABLE IF NOT EXISTS pending_actions (
    id TEXT PRIMARY KEY,
    owner_id INTEGER NOT NULL REFERENCES users(id),
    mode TEXT NOT NULL,
    question TEXT NOT NULL,
    context_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER
  );
`);

export const uploadsDir = path.join(dataDir, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

export type Provider = "google" | "microsoft" | "local";

export interface AccountRow {
  id: number;
  ownerId: number;
  provider: Provider;
  email: string;
  accessToken: string | null;
  refreshToken: string | null;
  expiryDate: number | null;
  authBroken: boolean;
  authBrokenAt: number | null;
}

// ownerId travels on the row itself (not just as a query filter) so code that already has an
// AccountRow in hand — google.ts/microsoft.ts's token-refresh callbacks, hub.ts — can call
// updateAccountTokens(account.ownerId, account.id, ...) etc. without threading a second id
// through every provider function that takes an AccountRow.
const rowSelect = `id, owner_id AS ownerId, provider, email, access_token AS accessToken,
                   refresh_token AS refreshToken, expiry_date AS expiryDate,
                   auth_broken AS authBroken, auth_broken_at AS authBrokenAt`;

// Tokens written before encryption was added are still plaintext in the DB. Rather than a
// one-shot migration script (easy to miss on a host you don't shell into), decrypt lazily and
// fall back to the raw value if it isn't in our "iv:authTag:ciphertext" format — those accounts
// self-heal to encrypted the next time their token is refreshed or they're reconnected, which
// happens naturally (access tokens refresh often; a manual reconnect fixes refresh_token too).
function tryDecrypt(value: string | null): string | null {
  if (value === null) return null;
  try {
    return decryptField(value);
  } catch {
    return value;
  }
}

function toAccountRow(raw: unknown): AccountRow {
  const row = raw as Omit<AccountRow, "authBroken"> & { authBroken: number };
  return {
    ...row,
    authBroken: !!row.authBroken,
    accessToken: tryDecrypt(row.accessToken),
    refreshToken: tryDecrypt(row.refreshToken),
  };
}

export function upsertAccount(
  ownerId: number,
  account: {
    provider: Provider;
    email: string;
    accessToken: string | null;
    refreshToken: string | null;
    expiryDate: number | null;
  }
): AccountRow {
  // Reconnecting (via the OAuth flow, which is what calls this) always means auth is healthy
  // again — clear any prior broken-connection flag.
  db.prepare(
    `INSERT INTO accounts (owner_id, provider, email, access_token, refresh_token, expiry_date, auth_broken, auth_broken_at)
     VALUES (@ownerId, @provider, @email, @accessToken, @refreshToken, @expiryDate, 0, NULL)
     ON CONFLICT(owner_id, provider, email) DO UPDATE SET
       access_token = excluded.access_token,
       refresh_token = COALESCE(excluded.refresh_token, accounts.refresh_token),
       expiry_date = excluded.expiry_date,
       auth_broken = 0,
       auth_broken_at = NULL`
  ).run({
    ownerId,
    ...account,
    accessToken: encryptField(account.accessToken),
    refreshToken: encryptField(account.refreshToken),
  });

  return toAccountRow(
    db
      .prepare(`SELECT ${rowSelect} FROM accounts WHERE owner_id = ? AND provider = ? AND email = ?`)
      .get(ownerId, account.provider, account.email)
  );
}

export function updateAccountTokens(
  ownerId: number,
  id: number,
  tokens: { accessToken: string | null; refreshToken?: string | null; expiryDate: number | null }
): void {
  db.prepare(
    `UPDATE accounts SET
       access_token = @accessToken,
       refresh_token = COALESCE(@refreshToken, refresh_token),
       expiry_date = @expiryDate
     WHERE id = @id AND owner_id = @ownerId`
  ).run({
    id,
    ownerId,
    expiryDate: tokens.expiryDate,
    accessToken: encryptField(tokens.accessToken),
    refreshToken: tokens.refreshToken != null ? encryptField(tokens.refreshToken) : null,
  });
}

export function markAccountAuthBroken(ownerId: number, id: number): void {
  db.prepare(
    `UPDATE accounts SET auth_broken = 1, auth_broken_at = ? WHERE id = ? AND owner_id = ? AND auth_broken = 0`
  ).run(Date.now(), id, ownerId);
}

export function markAccountAuthHealthy(ownerId: number, id: number): void {
  db.prepare(
    `UPDATE accounts SET auth_broken = 0, auth_broken_at = NULL WHERE id = ? AND owner_id = ? AND auth_broken = 1`
  ).run(id, ownerId);
}

export function listAccounts(ownerId: number, provider?: Provider): AccountRow[] {
  const rows = provider
    ? db.prepare(`SELECT ${rowSelect} FROM accounts WHERE owner_id = ? AND provider = ?`).all(ownerId, provider)
    : db.prepare(`SELECT ${rowSelect} FROM accounts WHERE owner_id = ?`).all(ownerId);
  return rows.map(toAccountRow);
}

export function getAccount(ownerId: number, id: number): AccountRow | null {
  const row = db
    .prepare(`SELECT ${rowSelect} FROM accounts WHERE id = ? AND owner_id = ?`)
    .get(id, ownerId);
  return row ? toAccountRow(row) : null;
}

export function deleteAccount(ownerId: number, id: number): void {
  db.prepare(`DELETE FROM accounts WHERE id = ? AND owner_id = ?`).run(id, ownerId);
}

export function getSetting(ownerId: number, key: string): string | null {
  const row = db.prepare(`SELECT value FROM settings WHERE owner_id = ? AND key = ?`).get(ownerId, key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(ownerId: number, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (owner_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(owner_id, key) DO UPDATE SET value = excluded.value`
  ).run(ownerId, key, value);
}

export interface LocalRootRow {
  id: number;
  path: string;
  label: string | null;
}

export function listLocalRoots(ownerId: number): LocalRootRow[] {
  return db
    .prepare(`SELECT id, path, label FROM local_roots WHERE owner_id = ?`)
    .all(ownerId) as LocalRootRow[];
}

export function addLocalRoot(ownerId: number, rootPath: string, label?: string): LocalRootRow {
  const info = db
    .prepare(`INSERT INTO local_roots (owner_id, path, label) VALUES (?, ?, ?)`)
    .run(ownerId, rootPath, label ?? null);
  return db
    .prepare(`SELECT id, path, label FROM local_roots WHERE id = ?`)
    .get(info.lastInsertRowid) as LocalRootRow;
}

export function removeLocalRoot(ownerId: number, id: number): void {
  db.prepare(`DELETE FROM local_roots WHERE id = ? AND owner_id = ?`).run(id, ownerId);
}

export interface BriefingRow {
  date: string;
  content: string;
  createdAt: number;
}

export function getBriefing(ownerId: number, date: string): BriefingRow | null {
  const row = db
    .prepare(`SELECT date, content, created_at AS createdAt FROM briefings WHERE owner_id = ? AND date = ?`)
    .get(ownerId, date) as BriefingRow | undefined;
  return row ?? null;
}

export function saveBriefing(ownerId: number, date: string, content: string): BriefingRow {
  db.prepare(
    `INSERT INTO briefings (owner_id, date, content, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(owner_id, date) DO UPDATE SET content = excluded.content, created_at = excluded.created_at`
  ).run(ownerId, date, content, Date.now());
  return getBriefing(ownerId, date)!;
}

export interface MemoryNoteRow {
  id: number;
  content: string;
  createdAt: number;
  triggerAt: number | null;
  lastSurfacedAt: number | null;
}

const MEMORY_NOTE_COLUMNS = `id, content, created_at AS createdAt, trigger_at AS triggerAt, last_surfaced_at AS lastSurfacedAt`;

export function listMemoryNotes(ownerId: number): MemoryNoteRow[] {
  return db
    .prepare(`SELECT ${MEMORY_NOTE_COLUMNS} FROM memory_notes WHERE owner_id = ? ORDER BY id DESC`)
    .all(ownerId) as MemoryNoteRow[];
}

// Used when building the assistant's system prompt (unlike listMemoryNotes, which the Setup
// page uses to show the full vault) — caps how many notes get resent as tokens on every single
// call so the prompt doesn't grow forever as the vault accumulates facts over months of use.
export function listRecentMemoryNotes(ownerId: number, limit = 40): MemoryNoteRow[] {
  return db
    .prepare(`SELECT ${MEMORY_NOTE_COLUMNS} FROM memory_notes WHERE owner_id = ? ORDER BY id DESC LIMIT ?`)
    .all(ownerId, limit) as MemoryNoteRow[];
}

// triggerAt comes from the model as an ISO 8601 string (see the remember tool in assistant.ts) —
// parsed here rather than trusted as-is, since a malformed or hallucinated date string should
// never crash a save or silently store garbage. Invalid/unparseable dates are treated exactly
// like "no trigger" (same fault-tolerant spirit as record_travel_movement elsewhere), not an
// error — the note itself still saves.
export function addMemoryNote(ownerId: number, content: string, triggerAt?: string | null): MemoryNoteRow {
  const parsedMs = triggerAt ? new Date(triggerAt).getTime() : NaN;
  const triggerAtMs = Number.isFinite(parsedMs) ? parsedMs : null;

  const info = db
    .prepare(`INSERT INTO memory_notes (owner_id, content, created_at, trigger_at) VALUES (?, ?, ?, ?)`)
    .run(ownerId, content, Date.now(), triggerAtMs);
  return db
    .prepare(`SELECT ${MEMORY_NOTE_COLUMNS} FROM memory_notes WHERE id = ?`)
    .get(info.lastInsertRowid) as MemoryNoteRow;
}

export function removeMemoryNote(ownerId: number, id: number): void {
  db.prepare(`DELETE FROM memory_notes WHERE id = ? AND owner_id = ?`).run(id, ownerId);
}

// Indexed lookup (idx_memory_notes_trigger, see the migration above), not a scan — cost stays
// proportional to how many reminders are actually due, not how many memories exist in total.
//
// Only reminders whose trigger_at falls within the last 24 hours are returned. Without this
// window, a reminder whose WhatsApp send keeps permanently failing (e.g. the customer-service
// window has closed, or the note exceeds WhatsApp's body limit) would stay "due" forever and be
// retried every scheduler tick — and because callers order by trigger_at ASC and only take the
// oldest few, a handful of permanently-stuck reminders could starve every later reminder
// indefinitely. Time-boxing the give-up window to 24h means a reminder that fails for that long
// silently drops out of this query — it stops blocking others, at the cost of never being
// retried again itself. That's an accepted tradeoff (see final-review fix notes).
const MEMORY_REMINDER_GIVE_UP_WINDOW_MS = 24 * 60 * 60 * 1000;

export function listDueMemoryReminders(ownerId: number, nowMs: number): MemoryNoteRow[] {
  return db
    .prepare(
      `SELECT ${MEMORY_NOTE_COLUMNS} FROM memory_notes
       WHERE owner_id = ? AND trigger_at IS NOT NULL AND trigger_at <= ? AND trigger_at > ?
         AND last_surfaced_at IS NULL
       ORDER BY trigger_at ASC`
    )
    .all(ownerId, nowMs, nowMs - MEMORY_REMINDER_GIVE_UP_WINDOW_MS) as MemoryNoteRow[];
}

export function markMemorySurfaced(ownerId: number, id: number): void {
  db.prepare(`UPDATE memory_notes SET last_surfaced_at = ? WHERE id = ? AND owner_id = ?`).run(
    Date.now(),
    id,
    ownerId
  );
}

export interface WhatsAppMessageRow {
  id: number;
  phone: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
}

// Stays keyed by phone rather than ownerId — phone is still the natural key for "this WhatsApp
// conversation thread." ownerId (resolved from phone before these are called — see
// resolveOwnerByPhone) scopes what the assistant is *allowed to see* when answering, not the
// chat log itself.
export function getWhatsAppHistory(phone: string, limit = 20): WhatsAppMessageRow[] {
  const rows = db
    .prepare(
      `SELECT id, phone, role, content, created_at AS createdAt FROM whatsapp_messages
       WHERE phone = ? ORDER BY id DESC LIMIT ?`
    )
    .all(phone, limit) as WhatsAppMessageRow[];
  return rows.reverse();
}

export function appendWhatsAppMessage(
  ownerId: number,
  phone: string,
  role: "user" | "assistant",
  content: string
): void {
  db.prepare(
    `INSERT INTO whatsapp_messages (owner_id, phone, role, content, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(ownerId, phone, role, content, Date.now());
}

export function normalizePhone(phone: string): string {
  return phone.replace(/[^0-9]/g, "");
}

export interface UserPhoneNumberRow {
  id: number;
  userId: number;
  phone: string;
  createdAt: number;
}

export function listPhoneNumbersForUser(ownerId: number): UserPhoneNumberRow[] {
  return db
    .prepare(`SELECT id, user_id AS userId, phone, created_at AS createdAt FROM user_phone_numbers WHERE user_id = ?`)
    .all(ownerId) as UserPhoneNumberRow[];
}

// A phone number can only ever belong to one owner — throws rather than silently returning
// someone else's existing row if the number's already registered to a different account.
export function addPhoneNumberForUser(ownerId: number, phone: string): UserPhoneNumberRow {
  const normalized = normalizePhone(phone);
  const existingOwner = resolveOwnerByPhone(normalized);
  if (existingOwner !== null && existingOwner !== ownerId) {
    throw new Error("This phone number is already registered to another account.");
  }
  if (existingOwner === ownerId) {
    return db
      .prepare(`SELECT id, user_id AS userId, phone, created_at AS createdAt FROM user_phone_numbers WHERE phone = ?`)
      .get(normalized) as UserPhoneNumberRow;
  }
  const info = db
    .prepare(`INSERT INTO user_phone_numbers (user_id, phone, created_at) VALUES (?, ?, ?)`)
    .run(ownerId, normalized, Date.now());
  return db
    .prepare(`SELECT id, user_id AS userId, phone, created_at AS createdAt FROM user_phone_numbers WHERE id = ?`)
    .get(info.lastInsertRowid) as UserPhoneNumberRow;
}

export function removePhoneNumberForUser(ownerId: number, id: number): void {
  db.prepare(`DELETE FROM user_phone_numbers WHERE id = ? AND user_id = ?`).run(id, ownerId);
}

export type ToolKey = "teams" | "travel";
export const TOOL_KEYS: ToolKey[] = ["teams", "travel"];

export function getEnabledTools(ownerId: number): Set<ToolKey> {
  const rows = db
    .prepare(`SELECT tool_key AS toolKey FROM user_enabled_tools WHERE owner_id = ?`)
    .all(ownerId) as { toolKey: ToolKey }[];
  return new Set(rows.map((r) => r.toolKey));
}

export function setToolEnabled(ownerId: number, toolKey: ToolKey, enabled: boolean): void {
  if (!TOOL_KEYS.includes(toolKey)) {
    throw new Error(`unknown tool: ${toolKey}`);
  }
  if (enabled) {
    db.prepare(
      `INSERT INTO user_enabled_tools (owner_id, tool_key, enabled_at) VALUES (?, ?, ?)
       ON CONFLICT(owner_id, tool_key) DO NOTHING`
    ).run(ownerId, toolKey, Date.now());
  } else {
    db.prepare(`DELETE FROM user_enabled_tools WHERE owner_id = ? AND tool_key = ?`).run(ownerId, toolKey);
  }
}

// The core of WhatsApp multi-tenant routing: given an inbound sender's phone number, which
// tenant's hub does this message belong to? Returns null for a number nobody has registered —
// the caller treats that the same as "not allowed" did before multi-tenancy.
export function resolveOwnerByPhone(phone: string): number | null {
  const normalized = normalizePhone(phone);
  const row = db.prepare(`SELECT user_id AS userId FROM user_phone_numbers WHERE phone = ?`).get(normalized) as
    | { userId: number }
    | undefined;
  return row ? row.userId : null;
}

// Called once per inbound webhook message, right after the sender resolves to an owner — see
// outbound.ts for how this timestamp decides free-form vs. template on the way back out.
export function recordInboundMessage(phone: string): void {
  db.prepare(`UPDATE user_phone_numbers SET last_inbound_at = ? WHERE phone = ?`).run(
    Date.now(),
    normalizePhone(phone)
  );
}

export function getLastInboundAt(phone: string): number | null {
  const row = db
    .prepare(`SELECT last_inbound_at AS lastInboundAt FROM user_phone_numbers WHERE phone = ?`)
    .get(normalizePhone(phone)) as { lastInboundAt: number | null } | undefined;
  return row?.lastInboundAt ?? null;
}

// Fixed on purpose (not free-form LLM tags) — a small, predictable set keeps the Files page
// grouping/filter UI simple and avoids near-duplicate categories ("Receipt" vs "Receipts")
// fragmenting the view over time.
export type DocumentCategory = "travel" | "id_legal" | "receipts" | "other";
export const DOCUMENT_CATEGORIES: DocumentCategory[] = ["travel", "id_legal", "receipts", "other"];

export type DocumentSource = "whatsapp" | "email";

export interface DocumentRow {
  id: number;
  phone: string;
  filename: string | null;
  mimeType: string;
  storedPath: string;
  caption: string | null;
  title: string | null;
  extractedText: string;
  category: DocumentCategory | null;
  createdAt: number;
  xeroForwardedAt: number | null;
  source: DocumentSource;
  emailAccountId: number | null;
  emailMessageId: string | null;
  emailAttachmentId: string | null;
}

const DOCUMENT_COLUMNS = `id, phone, filename, mime_type AS mimeType, stored_path AS storedPath,
  caption, title, extracted_text AS extractedText, category, created_at AS createdAt,
  xero_forwarded_at AS xeroForwardedAt, source, email_account_id AS emailAccountId,
  email_message_id AS emailMessageId, email_attachment_id AS emailAttachmentId`;

export function saveDocument(
  ownerId: number,
  doc: {
    phone: string;
    filename: string | null;
    mimeType: string;
    storedPath: string;
    caption: string | null;
    title: string | null;
    extractedText: string;
    category: DocumentCategory | null;
    source?: DocumentSource;
    emailAccountId?: number | null;
    emailMessageId?: string | null;
    emailAttachmentId?: string | null;
  }
): DocumentRow {
  const info = db
    .prepare(
      `INSERT INTO documents (owner_id, phone, filename, mime_type, stored_path, caption, title, extracted_text, category, created_at, source, email_account_id, email_message_id, email_attachment_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      ownerId,
      doc.phone,
      doc.filename,
      doc.mimeType,
      doc.storedPath,
      doc.caption,
      doc.title,
      doc.extractedText,
      doc.category,
      Date.now(),
      doc.source ?? "whatsapp",
      doc.emailAccountId ?? null,
      doc.emailMessageId ?? null,
      doc.emailAttachmentId ?? null
    );
  return db
    .prepare(`SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE id = ?`)
    .get(info.lastInsertRowid) as DocumentRow;
}

export function listDocuments(ownerId: number, limit = 50, category?: DocumentCategory): DocumentRow[] {
  if (category) {
    return db
      .prepare(`SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE owner_id = ? AND category = ? ORDER BY id DESC LIMIT ?`)
      .all(ownerId, category, limit) as DocumentRow[];
  }
  return db
    .prepare(`SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE owner_id = ? ORDER BY id DESC LIMIT ?`)
    .all(ownerId, limit) as DocumentRow[];
}

export function searchDocuments(ownerId: number, query: string, limit = 10): DocumentRow[] {
  const like = `%${query}%`;
  return db
    .prepare(
      `SELECT ${DOCUMENT_COLUMNS} FROM documents
       WHERE owner_id = ? AND (filename LIKE ? OR caption LIKE ? OR title LIKE ? OR extracted_text LIKE ?)
       ORDER BY id DESC LIMIT ?`
    )
    .all(ownerId, like, like, like, like, limit) as DocumentRow[];
}

// Scoped by owner — this used to accept any numeric id with no ownership check at all (a live
// IDOR: GET /api/documents/:id/file would serve any document to anyone who guessed an id).
export function getDocument(ownerId: number, id: number): DocumentRow | undefined {
  return db
    .prepare(`SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE id = ? AND owner_id = ?`)
    .get(id, ownerId) as DocumentRow | undefined;
}

export function findDocumentByEmailAttachment(
  ownerId: number,
  emailAccountId: number,
  emailMessageId: string,
  emailAttachmentId: string
): DocumentRow | undefined {
  return db
    .prepare(
      `SELECT ${DOCUMENT_COLUMNS} FROM documents
       WHERE owner_id = ? AND email_account_id = ? AND email_message_id = ? AND email_attachment_id = ?`
    )
    .get(ownerId, emailAccountId, emailMessageId, emailAttachmentId) as DocumentRow | undefined;
}

export function deleteDocument(ownerId: number, id: number): void {
  db.prepare(`DELETE FROM documents WHERE id = ? AND owner_id = ?`).run(id, ownerId);
}

export function markDocumentXeroForwarded(ownerId: number, id: number, forwardedAt: number): void {
  db.prepare(`UPDATE documents SET xero_forwarded_at = ? WHERE id = ? AND owner_id = ?`).run(
    forwardedAt,
    id,
    ownerId
  );
}

// Machine-checkable identifiers (reference code, flight number, vendor, event date) pulled from
// a document's extraction call, used by reconciliation.ts to notice when a document and an email
// refer to the same real-world thing. One row per document — a document can be re-extracted at
// most once in practice, but ON CONFLICT keeps this safe if that ever changes.
export interface DocumentMatchKeysRow {
  documentId: number;
  referenceCode: string | null;
  flightNumber: string | null;
  vendor: string | null;
  eventDate: string | null;
  docTitle: string | null;
}

// No-op when every field is absent — don't write an empty row that would never match anything
// and would just be dead weight in listRecentMatchKeys's scan.
export function saveMatchKeys(
  ownerId: number,
  documentId: number,
  keys: {
    referenceCode?: string | null;
    flightNumber?: string | null;
    vendor?: string | null;
    eventDate?: string | null;
  }
): void {
  const hasAny = keys.referenceCode || keys.flightNumber || keys.vendor || keys.eventDate;
  if (!hasAny) return;

  db.prepare(
    `INSERT INTO document_match_keys (document_id, owner_id, reference_code, flight_number, vendor, event_date, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(document_id) DO UPDATE SET
       reference_code = excluded.reference_code,
       flight_number = excluded.flight_number,
       vendor = excluded.vendor,
       event_date = excluded.event_date,
       created_at = excluded.created_at`
  ).run(
    documentId,
    ownerId,
    keys.referenceCode ?? null,
    keys.flightNumber ?? null,
    keys.vendor ?? null,
    keys.eventDate ?? null,
    Date.now()
  );
}

// Joined with documents.title so callers (reconciliation.ts) have everything needed to compose a
// notification without a second lookup.
export function listRecentMatchKeys(ownerId: number, sinceMs: number): DocumentMatchKeysRow[] {
  return db
    .prepare(
      `SELECT k.document_id AS documentId, k.reference_code AS referenceCode, k.flight_number AS flightNumber,
              k.vendor AS vendor, k.event_date AS eventDate, d.title AS docTitle
       FROM document_match_keys k
       JOIN documents d ON d.id = k.document_id
       WHERE k.owner_id = ? AND k.created_at >= ?
       ORDER BY k.created_at DESC`
    )
    .all(ownerId, sinceMs) as DocumentMatchKeysRow[];
}

export type CheckinSource = "phone" | "document";

export interface TravelCheckinRow {
  id: number;
  latitude: number | null;
  longitude: number | null;
  country: string | null;
  city: string | null;
  checkedInAt: number;
  source: CheckinSource;
  documentId: number | null;
}

// The JSON shape stored in entities.data for type='travel_checkin'. documentId is deliberately
// NOT in here — it's represented as a links row (entity --extracted_from--> document) per the
// generic design, and reattached onto the compatibility TravelCheckinRow shape in
// checkinFromEntity below, so travelDays.ts and every existing caller sees an identical shape to
// before the Phase B migration (docs/entities-and-links-guide.md §7 step 2).
interface TravelCheckinData {
  latitude: number | null;
  longitude: number | null;
  country: string | null;
  city: string | null;
  checkedInAt: number;
  source: CheckinSource;
}

function checkinFromEntity(ownerId: number, entity: EntityRow<TravelCheckinData>): TravelCheckinRow {
  const documentLink = getLinksFrom(ownerId, "entity", entity.id).find(
    (link) => link.relation === "extracted_from" && link.toType === "document"
  );
  return {
    id: entity.id,
    ...entity.data,
    documentId: documentLink ? documentLink.toId : null,
  };
}

export function saveCheckin(
  ownerId: number,
  checkin: {
    latitude?: number | null;
    longitude?: number | null;
    country: string | null;
    city: string | null;
    checkedInAt: number;
    source?: CheckinSource;
    documentId?: number | null;
  }
): TravelCheckinRow {
  const entity = saveEntity<TravelCheckinData>(ownerId, {
    type: "travel_checkin",
    data: {
      latitude: checkin.latitude ?? null,
      longitude: checkin.longitude ?? null,
      country: checkin.country,
      city: checkin.city,
      checkedInAt: checkin.checkedInAt,
      source: checkin.source ?? "phone",
    },
  });
  if (checkin.documentId != null) {
    linkRecords(ownerId, {
      relation: "extracted_from",
      from: { type: "entity", id: entity.id },
      to: { type: "document", id: checkin.documentId },
    });
  }
  return checkinFromEntity(ownerId, entity);
}

export function listCheckins(ownerId: number, limit = 100): TravelCheckinRow[] {
  return listEntities<TravelCheckinData>(ownerId, { type: "travel_checkin" })
    .sort((a, b) => b.data.checkedInAt - a.data.checkedInAt)
    .slice(0, limit)
    .map((entity) => checkinFromEntity(ownerId, entity));
}

// Dedup ledger for real-time message alerts: "have we already pinged the user about this
// message" — keyed by "accountId:messageId" since raw message IDs aren't guaranteed unique
// across providers/accounts. Scoped by owner so one tenant's alert volume can't evict another
// tenant's dedup entries out of the bounded 5000-row window.
export function hasAlerted(ownerId: number, key: string): boolean {
  return !!db.prepare(`SELECT 1 FROM alerted_messages WHERE owner_id = ? AND key = ?`).get(ownerId, key);
}

export function markAlerted(ownerId: number, key: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO alerted_messages (owner_id, key, alerted_at) VALUES (?, ?, ?)`
  ).run(ownerId, key, Date.now());
  db.prepare(
    `DELETE FROM alerted_messages WHERE owner_id = ? AND key NOT IN (
       SELECT key FROM alerted_messages WHERE owner_id = ? ORDER BY alerted_at DESC LIMIT 5000
     )`
  ).run(ownerId, ownerId);
}

// Ascending, uncapped — day-counting needs the full timeline, not just the most recent page.
export function listAllCheckinsAscending(ownerId: number): TravelCheckinRow[] {
  return listEntities<TravelCheckinData>(ownerId, { type: "travel_checkin" })
    .sort((a, b) => a.data.checkedInAt - b.data.checkedInAt)
    .map((entity) => checkinFromEntity(ownerId, entity));
}

// ---------------------------------------------------------------------------
// Generic entity + link store (docs/entities-and-links-guide.md §3). Foundation only — nothing
// calls these yet (that starts in Phase B, migrating travel_checkins). The row-mappers JSON.parse
// the `data`/JSON column on the way out, the same shape as the column-alias mappers above (e.g.
// toAccountRow), just with one field that's itself JSON.
// ---------------------------------------------------------------------------

export type EntityStatus = "active" | "needs_review" | "archived";

export interface EntityRow<T = unknown> {
  id: number;
  type: string;
  status: EntityStatus;
  data: T;
  confidence: number | null;
  createdAt: number;
  updatedAt: number;
}

const ENTITY_SELECT = `id, type, status, data, confidence, created_at AS createdAt, updated_at AS updatedAt`;

function toEntityRow<T>(raw: unknown): EntityRow<T> {
  const row = raw as Omit<EntityRow<T>, "data"> & { data: string };
  return { ...row, data: JSON.parse(row.data) as T };
}

export function saveEntity<T>(
  ownerId: number,
  entity: { type: string; data: T; confidence?: number | null; status?: EntityStatus }
): EntityRow<T> {
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO entities (owner_id, type, status, data, confidence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      ownerId,
      entity.type,
      entity.status ?? "active",
      JSON.stringify(entity.data),
      entity.confidence ?? null,
      now,
      now
    );
  return toEntityRow<T>(
    db.prepare(`SELECT ${ENTITY_SELECT} FROM entities WHERE id = ?`).get(info.lastInsertRowid)
  );
}

export function getEntity<T>(ownerId: number, id: number): EntityRow<T> | null {
  const row = db
    .prepare(`SELECT ${ENTITY_SELECT} FROM entities WHERE id = ? AND owner_id = ?`)
    .get(id, ownerId);
  return row ? toEntityRow<T>(row) : null;
}

export function listEntities<T>(
  ownerId: number,
  filter: { type?: string; status?: EntityStatus } = {}
): EntityRow<T>[] {
  const conditions = ["owner_id = ?"];
  const params: unknown[] = [ownerId];
  if (filter.type) {
    conditions.push("type = ?");
    params.push(filter.type);
  }
  if (filter.status) {
    conditions.push("status = ?");
    params.push(filter.status);
  }
  const rows = db
    .prepare(`SELECT ${ENTITY_SELECT} FROM entities WHERE ${conditions.join(" AND ")} ORDER BY id DESC`)
    .all(...params);
  return rows.map((row) => toEntityRow<T>(row));
}

export function updateEntity<T>(
  ownerId: number,
  id: number,
  patch: Partial<{ data: T; status: EntityStatus; confidence: number | null }>
): EntityRow<T> {
  const existing = getEntity<T>(ownerId, id);
  if (!existing) throw new Error(`entity ${id} not found`);
  db.prepare(
    `UPDATE entities SET data = @data, status = @status, confidence = @confidence, updated_at = @updatedAt
     WHERE id = @id AND owner_id = @ownerId`
  ).run({
    id,
    ownerId,
    data: JSON.stringify(patch.data !== undefined ? patch.data : existing.data),
    status: patch.status ?? existing.status,
    confidence: patch.confidence !== undefined ? patch.confidence : existing.confidence,
    updatedAt: Date.now(),
  });
  return getEntity<T>(ownerId, id)!;
}

export type LinkableType = "entity" | "document";

export interface LinkRow {
  id: number;
  relation: string;
  fromType: LinkableType;
  fromId: number;
  toType: LinkableType;
  toId: number;
  createdAt: number;
}

const LINK_SELECT = `id, relation, from_type AS fromType, from_id AS fromId,
  to_type AS toType, to_id AS toId, created_at AS createdAt`;

export function linkRecords(
  ownerId: number,
  link: {
    relation: string;
    from: { type: LinkableType; id: number };
    to: { type: LinkableType; id: number };
  }
): LinkRow {
  const info = db
    .prepare(
      `INSERT INTO links (owner_id, relation, from_type, from_id, to_type, to_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(ownerId, link.relation, link.from.type, link.from.id, link.to.type, link.to.id, Date.now());
  return db
    .prepare(`SELECT ${LINK_SELECT} FROM links WHERE id = ?`)
    .get(info.lastInsertRowid) as LinkRow;
}

export function getLinksFrom(ownerId: number, fromType: LinkableType, fromId: number): LinkRow[] {
  return db
    .prepare(`SELECT ${LINK_SELECT} FROM links WHERE owner_id = ? AND from_type = ? AND from_id = ?`)
    .all(ownerId, fromType, fromId) as LinkRow[];
}

export function getLinksTo(ownerId: number, toType: LinkableType, toId: number): LinkRow[] {
  return db
    .prepare(`SELECT ${LINK_SELECT} FROM links WHERE owner_id = ? AND to_type = ? AND to_id = ?`)
    .all(ownerId, toType, toId) as LinkRow[];
}

// Walks links in both directions from a record (an entity or a document) and returns every
// entity on the other end of one of those links — e.g. "everything belonging to this trip,"
// regardless of whether the trip is the from-side or the to-side of any given link row.
export function getRelatedEntities<T = unknown>(
  ownerId: number,
  record: { type: LinkableType; id: number }
): EntityRow<T>[] {
  const outgoingEntityIds = getLinksFrom(ownerId, record.type, record.id)
    .filter((link) => link.toType === "entity")
    .map((link) => link.toId);
  const incomingEntityIds = getLinksTo(ownerId, record.type, record.id)
    .filter((link) => link.fromType === "entity")
    .map((link) => link.fromId);
  const entityIds = [...new Set([...outgoingEntityIds, ...incomingEntityIds])];
  return entityIds
    .map((id) => getEntity<T>(ownerId, id))
    .filter((entity): entity is EntityRow<T> => entity !== null);
}

// ---------------------------------------------------------------------------
// Users, invites, sessions — the identity layer. Everything above this line is
// per-tenant *data*; everything below is what determines which tenant a request belongs to.
// ---------------------------------------------------------------------------

export interface UserRow {
  id: number;
  email: string;
  createdAt: number;
}

// Normalized once here so every caller (login, invite script, migration bootstrap) matches
// consistently regardless of how a provider or a human happened to capitalize an address.
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isEmailInvited(email: string): boolean {
  return !!db.prepare(`SELECT 1 FROM invited_emails WHERE email = ?`).get(normalizeEmail(email));
}

// Only call this once isEmailInvited(email) has already been checked true — this does not
// itself gate access, it just finds-or-creates the row for an already-authorized email.
export function findOrCreateUserByEmail(email: string): UserRow {
  const normalized = normalizeEmail(email);
  let row = db.prepare(`SELECT id, email, created_at AS createdAt FROM users WHERE email = ?`).get(normalized) as
    | UserRow
    | undefined;
  if (!row) {
    const info = db
      .prepare(`INSERT INTO users (email, created_at) VALUES (?, ?)`)
      .run(normalized, Date.now());
    row = db
      .prepare(`SELECT id, email, created_at AS createdAt FROM users WHERE id = ?`)
      .get(info.lastInsertRowid) as UserRow;
  }
  return row;
}

// Read-only, unlike findOrCreateUserByEmail — used to check "does this email already belong to
// someone" without the side effect of creating a row for an address that was only typed into a
// WhatsApp conversation, not yet OAuth-verified.
export function getUserByEmail(email: string): UserRow | null {
  const row = db
    .prepare(`SELECT id, email, created_at AS createdAt FROM users WHERE email = ?`)
    .get(normalizeEmail(email)) as UserRow | undefined;
  return row ?? null;
}

export function getUser(id: number): UserRow | null {
  const row = db.prepare(`SELECT id, email, created_at AS createdAt FROM users WHERE id = ?`).get(id) as
    | UserRow
    | undefined;
  return row ?? null;
}

// Used by server/src/scripts/invite.ts — the app owner's manual "grant this person a hub" tool.
export function addInvitedEmail(email: string): void {
  db.prepare(`INSERT OR IGNORE INTO invited_emails (email, invited_at) VALUES (?, ?)`).run(
    normalizeEmail(email),
    Date.now()
  );
}

// Per-tenant background jobs (scheduler.ts, alerts.ts) loop over every user rather than
// assuming a single global run.
export function listAllUserIds(): number[] {
  return (db.prepare(`SELECT id FROM users`).all() as { id: number }[]).map((r) => r.id);
}

// /api/checkin (a phone automation — iOS Shortcuts/Tasker — hitting the API with no interactive
// login) still runs on a single shared secret for this phase rather than a per-tenant one (see
// README), so it has no session to resolve an owner from. Resolves to the app owner's account
// the same way the multi-tenant migration itself decided who "the app owner" was.
export function getAppOwnerUserId(): number {
  const email = normalizeEmail(process.env.APP_OWNER_EMAIL ?? "samlukaitis5@gmail.com");
  return findOrCreateUserByEmail(email).id;
}

// Gates the admin invites UI/API — the one account (APP_OWNER_EMAIL) that can grant other people
// a hub, replacing the "run a script on your own machine" flow with a page in the app itself.
export function isAppOwner(userId: number): boolean {
  return userId === getAppOwnerUserId();
}

export interface InvitedEmailRow {
  email: string;
  invitedAt: number;
}

export function listInvitedEmails(): InvitedEmailRow[] {
  return db
    .prepare(`SELECT email, invited_at AS invitedAt FROM invited_emails ORDER BY invited_at DESC`)
    .all() as InvitedEmailRow[];
}

export function removeInvitedEmail(email: string): void {
  db.prepare(`DELETE FROM invited_emails WHERE email = ?`).run(normalizeEmail(email));
}

// Full account purge — built for repeatable testing of the WhatsApp registration flow (admin-
// only, see adminRoutes.ts), but a genuine "delete my account" is the same operation, so this is
// written as that rather than a test-only shortcut. Removes every row this owner_id touches
// across every table, plus the users row itself. Returns the uploaded documents' storedPaths so
// the caller can also unlink the actual files from disk (this function only touches the DB —
// deleting from server/data/uploads is a filesystem concern, kept in the route/caller, same
// separation documentRoutes.ts already uses for single-document deletes).
export function deleteUserCompletely(ownerId: number): { deletedDocumentPaths: string[] } {
  const documentPaths = (
    db.prepare(`SELECT stored_path AS storedPath FROM documents WHERE owner_id = ?`).all(ownerId) as {
      storedPath: string;
    }[]
  ).map((r) => r.storedPath);

  const purge = db.transaction(() => {
    db.prepare(`DELETE FROM accounts WHERE owner_id = ?`).run(ownerId);
    db.prepare(`DELETE FROM settings WHERE owner_id = ?`).run(ownerId);
    db.prepare(`DELETE FROM local_roots WHERE owner_id = ?`).run(ownerId);
    db.prepare(`DELETE FROM briefings WHERE owner_id = ?`).run(ownerId);
    db.prepare(`DELETE FROM memory_notes WHERE owner_id = ?`).run(ownerId);
    db.prepare(`DELETE FROM whatsapp_messages WHERE owner_id = ?`).run(ownerId);
    db.prepare(`DELETE FROM documents WHERE owner_id = ?`).run(ownerId);
    db.prepare(`DELETE FROM document_match_keys WHERE owner_id = ?`).run(ownerId);
    db.prepare(`DELETE FROM travel_checkins WHERE owner_id = ?`).run(ownerId);
    db.prepare(`DELETE FROM entities WHERE owner_id = ?`).run(ownerId);
    db.prepare(`DELETE FROM links WHERE owner_id = ?`).run(ownerId);
    db.prepare(`DELETE FROM alerted_messages WHERE owner_id = ?`).run(ownerId);
    db.prepare(`DELETE FROM user_enabled_tools WHERE owner_id = ?`).run(ownerId);
    db.prepare(`DELETE FROM pending_setup WHERE owner_id = ?`).run(ownerId);
    db.prepare(`DELETE FROM pending_actions WHERE owner_id = ?`).run(ownerId);
    db.prepare(`DELETE FROM user_phone_numbers WHERE user_id = ?`).run(ownerId);
    db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(ownerId);
    db.prepare(`DELETE FROM users WHERE id = ?`).run(ownerId);
  });
  purge();

  return { deletedDocumentPaths: documentPaths };
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, sliding — refreshed on each use

// Shared by session tokens and WhatsApp registration link tokens below — same primitive, two
// different token types, only the hash is ever stored for either.
function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

// Returns the raw token to set as the cookie value — only its SHA-256 hash is ever stored, so a
// DB read alone can't be used to impersonate a session (same reasoning as never storing
// passwords in plaintext, even though this is a random token rather than something a user
// picked).
export function createSession(userId: number): string {
  const raw = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  db.prepare(`INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`).run(
    hashToken(raw),
    userId,
    now,
    now + SESSION_TTL_MS
  );
  return raw;
}

export function getUserIdBySessionToken(raw: string): number | null {
  const hash = hashToken(raw);
  const now = Date.now();
  const row = db.prepare(`SELECT user_id AS userId, expires_at AS expiresAt FROM sessions WHERE id = ?`).get(
    hash
  ) as { userId: number; expiresAt: number } | undefined;
  if (!row || row.expiresAt < now) return null;
  // Sliding expiration — a session that's actually in use never silently expires mid-session.
  db.prepare(`UPDATE sessions SET expires_at = ? WHERE id = ?`).run(now + SESSION_TTL_MS, hash);
  return row.userId;
}

export function deleteSession(raw: string): void {
  db.prepare(`DELETE FROM sessions WHERE id = ?`).run(hashToken(raw));
}

// ---------------------------------------------------------------------------
// Pending WhatsApp registrations — conversation state for a brand-new, unregistered phone
// number working through "what's your name? / which email? / tap this link" before it has an
// owner at all. See server/src/services/whatsappRegistration.ts for the state machine that
// drives this; these are just the storage primitives.
// ---------------------------------------------------------------------------

export type PendingRegistrationStep =
  | "awaiting_name"
  | "awaiting_email"
  | "awaiting_provider"
  | "awaiting_link_tap"
  | "completed";

export type RegistrationProvider = "google" | "microsoft";

export interface PendingRegistrationRow {
  phone: string;
  step: PendingRegistrationStep;
  name: string | null;
  typedEmail: string | null;
  provider: RegistrationProvider | null;
  tokenHash: string | null;
  tokenExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}

const PENDING_REG_SELECT = `phone, step, name, typed_email AS typedEmail, provider, token_hash AS tokenHash,
  token_expires_at AS tokenExpiresAt, created_at AS createdAt, updated_at AS updatedAt`;

export function getPendingRegistration(phone: string): PendingRegistrationRow | null {
  const row = db
    .prepare(`SELECT ${PENDING_REG_SELECT} FROM pending_whatsapp_registrations WHERE phone = ?`)
    .get(normalizePhone(phone)) as PendingRegistrationRow | undefined;
  return row ?? null;
}

export function upsertPendingRegistration(
  phone: string,
  patch: Partial<{
    step: PendingRegistrationStep;
    name: string;
    typedEmail: string;
    provider: RegistrationProvider;
  }>
): PendingRegistrationRow {
  const normalized = normalizePhone(phone);
  const now = Date.now();
  const existing = getPendingRegistration(normalized);
  if (!existing) {
    db.prepare(
      `INSERT INTO pending_whatsapp_registrations (phone, step, name, typed_email, provider, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      normalized,
      patch.step ?? "awaiting_name",
      patch.name ?? null,
      patch.typedEmail ?? null,
      patch.provider ?? null,
      now,
      now
    );
  } else {
    db.prepare(
      `UPDATE pending_whatsapp_registrations SET
         step = @step, name = @name, typed_email = @typedEmail, provider = @provider, updated_at = @updatedAt
       WHERE phone = @phone`
    ).run({
      phone: normalized,
      step: patch.step ?? existing.step,
      name: patch.name ?? existing.name,
      typedEmail: patch.typedEmail ?? existing.typedEmail,
      provider: patch.provider ?? existing.provider,
      updatedAt: now,
    });
  }
  return getPendingRegistration(normalized)!;
}

// Generates the one-time link token, storing only its hash (same pattern as session tokens) —
// returns the raw token to embed in the WhatsApp message, never persisted anywhere itself.
// ttlMs defaults to the deck's 10-minute window; overridable only so tests can produce an
// already-expired token deterministically instead of waiting on a real clock.
export function setPendingRegistrationToken(phone: string, ttlMs = 10 * 60 * 1000): string {
  const normalized = normalizePhone(phone);
  const raw = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  db.prepare(
    `UPDATE pending_whatsapp_registrations SET token_hash = ?, token_expires_at = ?, updated_at = ? WHERE phone = ?`
  ).run(hashToken(raw), now + ttlMs, now, normalized);
  return raw;
}

// Read-only version of the lookup below — used by the /auth/{provider}/register route to
// validate the link and read typedEmail for login_hint BEFORE redirecting to the provider,
// without spending the token yet. If Google's consent screen fails or the user cancels there,
// the link must still work if they come back and tap it again.
export function peekPendingRegistrationByToken(rawToken: string): PendingRegistrationRow | null {
  const hash = hashToken(rawToken);
  const now = Date.now();
  const row = db
    .prepare(`SELECT ${PENDING_REG_SELECT} FROM pending_whatsapp_registrations WHERE token_hash = ?`)
    .get(hash) as PendingRegistrationRow | undefined;
  if (!row || row.tokenExpiresAt === null || row.tokenExpiresAt < now) return null;
  return row;
}

// Single-use: nulls out the token immediately on a successful lookup, so a second tap of either
// the Google or Microsoft link (whichever wasn't used first) fails cleanly instead of re-running
// OAuth against a stale registration. Does NOT advance `step` or delete the row — the caller
// (the OAuth callback) does that explicitly once the rest of the connect flow actually succeeds,
// so a failed callback (e.g. not invited) doesn't strand the row in a half-consumed state.
export function consumePendingRegistrationToken(rawToken: string): PendingRegistrationRow | null {
  const hash = hashToken(rawToken);
  const now = Date.now();
  const row = db
    .prepare(`SELECT ${PENDING_REG_SELECT} FROM pending_whatsapp_registrations WHERE token_hash = ?`)
    .get(hash) as PendingRegistrationRow | undefined;
  if (!row || row.tokenExpiresAt === null || row.tokenExpiresAt < now) return null;
  db.prepare(
    `UPDATE pending_whatsapp_registrations SET token_hash = NULL, token_expires_at = NULL WHERE phone = ?`
  ).run(row.phone);
  return row;
}

export function completePendingRegistration(phone: string): void {
  db.prepare(`UPDATE pending_whatsapp_registrations SET step = 'completed', updated_at = ? WHERE phone = ?`).run(
    Date.now(),
    normalizePhone(phone)
  );
}

export function deletePendingRegistration(phone: string): void {
  db.prepare(`DELETE FROM pending_whatsapp_registrations WHERE phone = ?`).run(normalizePhone(phone));
}

// ---------------------------------------------------------------------------
// Post-connect setup — the yes/no button chain (daily briefing, Teams, Schengen
// tracking) run right after OAuth connects. See services/postConnectSetup.ts.
// ---------------------------------------------------------------------------

export type PostConnectSetupStep = "ask_briefing" | "ask_teams" | "ask_travel";

export function getPendingSetup(ownerId: number): PostConnectSetupStep | null {
  const row = db.prepare(`SELECT step FROM pending_setup WHERE owner_id = ?`).get(ownerId) as
    | { step: PostConnectSetupStep }
    | undefined;
  return row?.step ?? null;
}

export function setPendingSetup(ownerId: number, step: PostConnectSetupStep): void {
  db.prepare(
    `INSERT INTO pending_setup (owner_id, step) VALUES (?, ?)
     ON CONFLICT(owner_id) DO UPDATE SET step = excluded.step`
  ).run(ownerId, step);
}

export function clearPendingSetup(ownerId: number): void {
  db.prepare(`DELETE FROM pending_setup WHERE owner_id = ?`).run(ownerId);
}

// ---------------------------------------------------------------------------
// Pending actions — ask_user_choice's backing store (see assistant.ts / actionHandlers.ts)
// ---------------------------------------------------------------------------

export type PendingActionMode = "confirm" | "resume";

export interface PendingActionRow {
  id: string;
  ownerId: number;
  mode: PendingActionMode;
  question: string;
  contextJson: string;
}

const PENDING_ACTION_TTL_MS = 24 * 60 * 60 * 1000;

export function createPendingAction(
  ownerId: number,
  mode: PendingActionMode,
  question: string,
  contextJson: string
): string {
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO pending_actions (id, owner_id, mode, question, context_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, ownerId, mode, question, contextJson, now, now + PENDING_ACTION_TTL_MS);
  return id;
}

// Atomically marks the row consumed and returns it. Returns null if the id doesn't exist,
// belongs to a different owner, is already consumed, or is past its expiry — expiry is checked
// here rather than relying solely on the periodic sweep, since the sweep is hygiene only, not
// the correctness boundary.
export function consumePendingAction(id: string, ownerId: number): PendingActionRow | null {
  const now = Date.now();
  const result = db
    .prepare(
      `UPDATE pending_actions SET consumed_at = ?
       WHERE id = ? AND owner_id = ? AND consumed_at IS NULL AND expires_at > ?`
    )
    .run(now, id, ownerId, now);
  if (result.changes === 0) return null;
  const row = db
    .prepare(
      `SELECT id, owner_id AS ownerId, mode, question, context_json AS contextJson
       FROM pending_actions WHERE id = ?`
    )
    .get(id) as PendingActionRow | undefined;
  return row ?? null;
}

// Hygiene only — expiry is already enforced at consume time above. Called once per scheduler
// tick (not per user — this isn't scoped to a tenant).
export function deleteExpiredPendingActions(): void {
  db.prepare(`DELETE FROM pending_actions WHERE expires_at < ?`).run(Date.now());
}
