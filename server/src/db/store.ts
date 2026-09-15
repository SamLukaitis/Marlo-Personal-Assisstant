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

  -- Timed WhatsApp reminders: a one-shot nudge, a fixed-interval burst within a time window, or a
  -- repeat-until-the-user-replies nudge. Deliberately its own table rather than more nullable
  -- columns on memory_notes (which is a facts table) — recurrence needs real state (next_fire_at,
  -- interval_ms, window_end_at) that a single trigger_at can't hold. See
  -- feature-to-do/entities-and-links-guide.md's own "generalise, don't bolt on" spirit; delivered
  -- by services/reminderScheduler.ts on a tight, deterministic timer — see that file for why.
  CREATE TABLE IF NOT EXISTS reminders (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id      INTEGER NOT NULL REFERENCES users(id),
    message       TEXT NOT NULL,
    mode          TEXT NOT NULL,                    -- 'once' | 'interval' | 'until_reply'
    next_fire_at  INTEGER NOT NULL,
    interval_ms   INTEGER,                           -- 'interval' and 'until_reply' only
    window_end_at INTEGER,                           -- 'interval' only
    status        TEXT NOT NULL DEFAULT 'active',    -- active | done | cancelled | gave_up
    created_at    INTEGER NOT NULL,
    last_sent_at  INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_reminders_owner_status_next ON reminders(owner_id, status, next_fire_at);

  -- Admin portal (feature-to-do doc: admin portal) — global/shared across every admin, not
  -- scoped to a tenant, except unmet_requests/api_usage which record which owner's conversation
  -- they came from (admin routes still read across every owner).
  CREATE TABLE IF NOT EXISTS unmet_requests (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id   INTEGER NOT NULL REFERENCES users(id),
    summary    TEXT NOT NULL,
    channel    TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_unmet_requests_created ON unmet_requests(created_at);
  CREATE TABLE IF NOT EXISTS server_logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    level      TEXT NOT NULL,
    message    TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    explanation TEXT,
    explained_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_server_logs_created ON server_logs(created_at);
  CREATE TABLE IF NOT EXISTS api_usage (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id              INTEGER REFERENCES users(id),
    channel               TEXT NOT NULL,
    model                 TEXT NOT NULL,
    purpose               TEXT NOT NULL DEFAULT 'assistant_chat',
    input_tokens          INTEGER NOT NULL,
    output_tokens         INTEGER NOT NULL,
    cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    created_at            INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_api_usage_created ON api_usage(created_at);
  CREATE TABLE IF NOT EXISTS admin_todos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    text       TEXT NOT NULL,
    done       INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    done_at    INTEGER
  );
  CREATE TABLE IF NOT EXISTS admin_todo_replies (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    todo_id    INTEGER NOT NULL REFERENCES admin_todos(id),
    author_id  INTEGER NOT NULL REFERENCES users(id),
    text       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_admin_todo_replies_todo ON admin_todo_replies(todo_id);
  -- Per-viewer read state so "unread reply count" is a personal, not global, notion — the
  -- composite key is (todo_id, user_id), not an autoincrement id, since there's at most one
  -- row per pairing (upserted, never appended to).
  CREATE TABLE IF NOT EXISTS admin_todo_reply_reads (
    todo_id            INTEGER NOT NULL REFERENCES admin_todos(id),
    user_id            INTEGER NOT NULL REFERENCES users(id),
    last_read_reply_id INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (todo_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS poster_notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    author_id  INTEGER NOT NULL REFERENCES users(id),
    text       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  -- Durable cache of every email Marlowe has ever seen metadata for or opened, keyed so a
  -- re-list/re-open upserts the same row rather than piling up duplicates. subject/sender/
  -- snippet/received_at are populated the moment hub.ts lists a message (cheap — Gmail/Outlook
  -- already return this in the same call); body stays NULL until get_message actually opens it
  -- in full. Backs search_read_emails (assistant.ts) — durable ground truth for a previously
  -- seen/opened email even after it ages out of chat history, or is later archived/deleted.
  CREATE TABLE IF NOT EXISTS read_emails (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id      INTEGER NOT NULL REFERENCES users(id),
    account_id    INTEGER NOT NULL,
    account_email TEXT NOT NULL,
    message_id    TEXT NOT NULL,
    subject       TEXT NOT NULL,
    sender        TEXT NOT NULL,
    snippet       TEXT NOT NULL,
    body          TEXT,
    received_at   TEXT NOT NULL,
    read_at       INTEGER NOT NULL,
    UNIQUE(owner_id, account_id, message_id)
  );
  CREATE INDEX IF NOT EXISTS idx_read_emails_owner ON read_emails(owner_id);
`);

// Lightweight migration (same pattern as accounts.auth_broken below): users predates the is_admin
// flag, so add it explicitly if missing. The single app owner (isAppOwner) is always implicitly
// admin regardless of this flag — this only covers additional people granted portal access.
const userColumns = (db.prepare(`PRAGMA table_info(users)`).all() as { name: string }[]).map(
  (c) => c.name
);
if (!userColumns.includes("is_admin")) {
  db.exec(`ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0`);
}

// api_usage originally only tracked the main assistant chat (owner_id required, no purpose
// column). Recording usage for calls with no signed-in owner yet (the public help widget, the
// WhatsApp registration assistant) needs owner_id to be nullable, which SQLite can't ALTER
// directly — rebuild the table when the new "purpose" column (a proxy for "hasn't been migrated
// yet") is missing, same precedent as travel_checkins' lat/long-nullable migration above. Every
// pre-existing row was, by definition, the main assistant chat.
const apiUsageColumns = (db.prepare(`PRAGMA table_info(api_usage)`).all() as { name: string }[]).map(
  (c) => c.name
);
if (!apiUsageColumns.includes("purpose")) {
  db.exec(`
    CREATE TABLE api_usage_new (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id      INTEGER REFERENCES users(id),
      channel       TEXT NOT NULL,
      model         TEXT NOT NULL,
      purpose       TEXT NOT NULL DEFAULT 'assistant_chat',
      input_tokens  INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      created_at    INTEGER NOT NULL
    );
    INSERT INTO api_usage_new (id, owner_id, channel, model, purpose, input_tokens, output_tokens, created_at)
      SELECT id, owner_id, channel, model, 'assistant_chat', input_tokens, output_tokens, created_at FROM api_usage;
    DROP TABLE api_usage;
    ALTER TABLE api_usage_new RENAME TO api_usage;
    CREATE INDEX IF NOT EXISTS idx_api_usage_created ON api_usage(created_at);
  `);
}

// api_usage originally recorded only usage.input_tokens/output_tokens — but with prompt caching
// active (ai/assistant.ts), input_tokens EXCLUDES all cached tokens, so the dominant token class
// on the real Anthropic bill (cache reads/writes of the big tools+system prefix, re-sent on every
// loop turn) was invisible here and the Usage tab's cost estimate understated real spend.
// PRAGMA is re-read rather than reusing apiUsageColumns above: if the purpose rebuild just ran,
// that snapshot is stale (and api_usage_new deliberately doesn't include these columns, so both
// migration paths land here needing the ALTERs).
const apiUsageColumnsNow = (db.prepare(`PRAGMA table_info(api_usage)`).all() as { name: string }[]).map(
  (c) => c.name
);
if (!apiUsageColumnsNow.includes("cache_read_tokens")) {
  db.exec(`
    ALTER TABLE api_usage ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE api_usage ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0;
  `);
}

// Bootstraps the very first non-owner admin without needing an existing admin to grant it through
// the Portal's Admins tab first (a chicken-and-egg problem otherwise) — and deliberately doesn't
// touch APP_OWNER_EMAIL/isAppOwner, since that also controls who /api/checkin's phone-automation
// endpoint resolves to. Runs on every startup, but is idempotent (re-setting is_admin=1 is a
// no-op), so it's safe to leave this var configured indefinitely rather than a true one-shot.
const bootstrapAdminEmail = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim();
if (bootstrapAdminEmail) {
  const bootstrapUser = findOrCreateUserByEmail(bootstrapAdminEmail);
  db.prepare(`UPDATE users SET is_admin = 1 WHERE id = ?`).run(bootstrapUser.id);
}

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
// Per-inbox permission toggles (Settings page "Accounts" section). Default to 1 (allowed) so
// every already-connected account keeps its current full access until explicitly restricted.
if (!accountColumns.includes("can_read")) {
  db.exec(`ALTER TABLE accounts ADD COLUMN can_read INTEGER NOT NULL DEFAULT 1`);
}
if (!accountColumns.includes("can_send")) {
  db.exec(`ALTER TABLE accounts ADD COLUMN can_send INTEGER NOT NULL DEFAULT 1`);
}
if (!accountColumns.includes("can_delete")) {
  db.exec(`ALTER TABLE accounts ADD COLUMN can_delete INTEGER NOT NULL DEFAULT 1`);
}
// Gmail History API checkpoint (google.ts's incremental list) — NULL means "never baselined",
// which falls back to a full messages.list and sets this from the mailbox's current historyId.
// Microsoft accounts never set this; Graph has its own separate delta-query mechanism, not
// implemented here, so they keep doing a full list every tick, unaffected.
if (!accountColumns.includes("history_id")) {
  db.exec(`ALTER TABLE accounts ADD COLUMN history_id TEXT`);
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
        can_read INTEGER NOT NULL DEFAULT 1,
        can_send INTEGER NOT NULL DEFAULT 1,
        can_delete INTEGER NOT NULL DEFAULT 1,
        history_id TEXT,
        UNIQUE(owner_id, provider, email)
      );
    `);
    db.prepare(
      `INSERT INTO accounts_new (id, owner_id, provider, email, access_token, refresh_token, expiry_date, auth_broken, auth_broken_at, can_read, can_send, can_delete, history_id)
       SELECT id, ?, provider, email, access_token, refresh_token, expiry_date, auth_broken, auth_broken_at, can_read, can_send, can_delete, history_id FROM accounts`
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
// Human-readable inbox tag, snapshotted at save time so it survives the account later being
// disconnected (email_account_id alone would go stale/unresolvable in that case).
if (!documentColumns.includes("email_account_email")) {
  db.exec(`ALTER TABLE documents ADD COLUMN email_account_email TEXT`);
}

// The wamid of the WhatsApp message that carried this document, so a later swipe-to-reply on that
// photo/file (Meta's `context.id`) resolves straight to its real extracted content instead of the
// short "[Sent a file]" placeholder stored in whatsapp_messages. Null for email-sourced documents
// and for anything saved before this shipped.
if (!documentColumns.includes("wamid")) {
  db.exec(`ALTER TABLE documents ADD COLUMN wamid TEXT`);
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
// Set once a reminder ages out of listDueMemoryReminders's 24h window without ever sending — lets
// checkDueMemoryReminders notify the user exactly once that it gave up, and lets
// searchReminderNotes report "failed" instead of leaving the reminder looking silently pending.
if (!memoryNoteColumns.includes("gave_up_at")) {
  db.exec(`ALTER TABLE memory_notes ADD COLUMN gave_up_at INTEGER`);
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_notes_trigger ON memory_notes (owner_id, trigger_at)`);

// One-time migration: memory_notes.trigger_at used to be the only way to schedule a reminder.
// Reminders now live in their own `reminders` table (recurrence needs real state a single
// trigger_at can't hold — see that table's comment), delivered by a dedicated fast scheduler
// instead of the old 5-minute-tick memoryReminders.ts. memory_notes itself is left untouched
// (rows and all) as a rollback point, same as travel_checkins after its own migration above —
// only still-pending one-shot reminders (never surfaced, never given up on) are copied forward.
// Guarded the same way as the travel_checkins migration: once any reminders row exists, this is
// skipped on every later boot rather than re-diffing.
const hasMigratedReminders = !!db.prepare(`SELECT 1 FROM reminders LIMIT 1`).get();
if (!hasMigratedReminders) {
  const pendingReminders = db
    .prepare(
      `SELECT owner_id AS ownerId, content, trigger_at AS triggerAt, created_at AS createdAt
       FROM memory_notes
       WHERE trigger_at IS NOT NULL AND last_surfaced_at IS NULL AND gave_up_at IS NULL`
    )
    .all() as { ownerId: number; content: string; triggerAt: number; createdAt: number }[];

  if (pendingReminders.length > 0) {
    const migrateReminders = db.transaction(() => {
      const insertReminder = db.prepare(
        `INSERT INTO reminders (owner_id, message, mode, next_fire_at, status, created_at)
         VALUES (?, ?, 'once', ?, 'active', ?)`
      );
      for (const row of pendingReminders) {
        insertReminder.run(row.ownerId, row.content, row.triggerAt, row.createdAt);
      }
    });
    migrateReminders();
    console.log(`store: migrated ${pendingReminders.length} pending memory-note reminder(s) into reminders`);
  }
}

// Full-text index over memory notes, backing searchMemoryNotes() below. The system prompt only
// ever injects the most recent N notes (listRecentMemoryNotes) — this is how the assistant reaches
// older notes on demand instead of losing them once they age out of that window. External-content
// FTS5 table (content='memory_notes') so the indexed text isn't duplicated in the DB; triggers keep
// it in sync with inserts/deletes (no update trigger — memory_notes rows are never content-edited,
// only inserted or removed).
const ftsExistedBefore = !!db
  .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_notes_fts'`)
  .get();
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS memory_notes_fts USING fts5(
    content, content='memory_notes', content_rowid='id'
  );
  CREATE TRIGGER IF NOT EXISTS memory_notes_fts_ai AFTER INSERT ON memory_notes BEGIN
    INSERT INTO memory_notes_fts(rowid, content) VALUES (new.id, new.content);
  END;
  CREATE TRIGGER IF NOT EXISTS memory_notes_fts_ad AFTER DELETE ON memory_notes BEGIN
    INSERT INTO memory_notes_fts(memory_notes_fts, rowid, content) VALUES ('delete', old.id, old.content);
  END;
`);
if (!ftsExistedBefore) {
  db.exec(`INSERT INTO memory_notes_fts(rowid, content) SELECT id, content FROM memory_notes`);
}

// Full-text index over the raw WhatsApp transcript, backing searchWhatsAppHistory() below — the
// system prompt only ever includes the most recent MAX_HISTORY_MESSAGES messages plus a rolling
// summary of whatever fell out of that window (services/conversationSummary.ts). This is how the
// assistant reaches a specific older fact on demand instead of relying on the summary having kept
// it. External-content FTS5 table (content='whatsapp_messages') so the indexed text isn't
// duplicated in the DB; triggers keep it in sync with inserts/deletes (no update trigger —
// whatsapp_messages rows are never content-edited, only inserted or removed, e.g. by
// deleteUserCompletely).
//
// The initial backfill is deliberately keyed off "is the FTS table empty right now" rather than
// "did it already exist before this boot" — CREATE VIRTUAL TABLE and a backfill INSERT are two
// separate implicit transactions, and this table can hold the entire WhatsApp transcript, so a
// process killed between them (e.g. a slow boot hitting a platform health-check timeout) would
// leave a table that "exists" but was never populated, and an existence check would then skip the
// backfill forever on every future boot — silently missing everything from before that boot, and
// later corrupting the index when deleteUserCompletely's bulk DELETE fires the delete trigger for
// rows the index never actually held. Checking emptiness instead is self-healing: any interrupted
// first boot just looks empty again next time and gets rebuilt. Using FTS5's 'rebuild' command
// (rather than re-running the plain backfill INSERT) also makes the recovery itself atomic and
// idempotent — it re-derives the whole index from whatsapp_messages in one shot and can't leave it
// partially populated either. A legitimately empty whatsapp_messages table (fresh install, zero
// messages) will re-run 'rebuild' on every boot until the first message arrives; that's harmless —
// 'rebuild' against an empty base table is a cheap no-op — and it settles into a normal
// single-run-then-stable pattern the moment real content exists.
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS whatsapp_messages_fts USING fts5(
    content, content='whatsapp_messages', content_rowid='id'
  );
  CREATE TRIGGER IF NOT EXISTS whatsapp_messages_fts_ai AFTER INSERT ON whatsapp_messages BEGIN
    INSERT INTO whatsapp_messages_fts(rowid, content) VALUES (new.id, new.content);
  END;
  CREATE TRIGGER IF NOT EXISTS whatsapp_messages_fts_ad AFTER DELETE ON whatsapp_messages BEGIN
    INSERT INTO whatsapp_messages_fts(whatsapp_messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
  END;
`);
const whatsappFtsIsEmpty = !db.prepare(`SELECT 1 FROM whatsapp_messages_fts LIMIT 1`).get();
if (whatsappFtsIsEmpty) {
  db.exec(`INSERT INTO whatsapp_messages_fts(whatsapp_messages_fts) VALUES('rebuild')`);
}

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

// An append-only log of every post-connect setup step transition, so onboarding drop-off is
// something you can actually see instead of guess at — a 'reached' row with no later row for that
// owner is exactly where they stalled. Written from inside setPendingSetup/clearPendingSetup below
// (the only two writers of pending_setup) rather than from each call site in
// services/postConnectSetup.ts, so every transition is captured for free and a future step can't
// forget to log itself. See adminRoutes.ts's conversation viewer, which renders these alongside
// the WhatsApp history for the same owner.
db.exec(`
  CREATE TABLE IF NOT EXISTS onboarding_step_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL REFERENCES users(id),
    step TEXT NOT NULL,
    event TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_onboarding_step_events_owner ON onboarding_step_events(owner_id);
`);

// Backs ask_user_choice (assistant.ts): a closed-set question rendered as WhatsApp buttons/a
// list, tapped later. 'confirm' rows store the exact tool+args to run on a Yes tap (executed
// directly, no further LLM call), and optionally a decline tool+args to run instead of just
// cancelling on a No tap (e.g. create_email_draft when declining to send an email); an Edit tap
// runs neither and instead routes back into the conversation, same as a resume tap. 'resume' rows
// store the option labels to inject back into the conversation as a synthetic user message. See
// actionHandlers.ts for the consuming side.
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

// Durable dedupe ledger for inbound webhook deliveries. Meta retries a webhook POST (ours or its
// own timeout) for up to 7 days, and a full assistant/tool-calling round trip is easily slow
// enough to look like a failure to Meta — so without this, a retry re-runs the whole handler
// (double-sends replies, double-archives, etc). Was an in-memory Set capped at 500 in
// whatsappRoutes.ts; that lost its dedupe history on every restart/deploy, right when a burst of
// retries is most likely (Meta retries faster after a fresh connection failure). A DB row survives
// restarts and naturally handles concurrent webhook POSTs via INSERT OR IGNORE's atomicity.
db.exec(`
  CREATE TABLE IF NOT EXISTS seen_wamids (
    wamid TEXT PRIMARY KEY,
    seen_at INTEGER NOT NULL
  );
`);

// Maps a WhatsApp message's wamid(s) back to the whatsapp_messages row it belongs to, so a later
// swipe-to-reply (Meta's `context.id`) can resolve to what was actually said/sent, no matter how
// long ago. A join table rather than a column on whatsapp_messages because one outbound reply can
// go out as several WhatsApp-sent chunks (services/messageSplitting.ts) — each chunk gets its own
// wamid, but they're persisted as a single history row; a plain column can't hold that 1:many
// case. Inbound messages just get one row here. Unlike seen_wamids (dedupe-only, pruned after 8
// days), this is never pruned — the whole point is resolving a reply from an arbitrary time ago.
db.exec(`
  CREATE TABLE IF NOT EXISTS whatsapp_message_wamids (
    wamid TEXT PRIMARY KEY,
    message_id INTEGER NOT NULL REFERENCES whatsapp_messages(id)
  );
  CREATE INDEX IF NOT EXISTS idx_whatsapp_message_wamids_message ON whatsapp_message_wamids(message_id);
`);

// One rolling summary per WhatsApp conversation, covering everything older than the raw history
// window (ai/assistant.ts's MAX_HISTORY_MESSAGES) sent to the model on each turn. See
// services/conversationSummary.ts, which is the only writer; ai/assistant.ts's buildSystemPrompt
// is the reader. summarized_through_id is the highest whatsapp_messages.id already folded in, so
// the next update knows where to resume from.
db.exec(`
  CREATE TABLE IF NOT EXISTS whatsapp_conversation_summaries (
    phone TEXT PRIMARY KEY,
    summary TEXT NOT NULL,
    summarized_through_id INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
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
  canRead: boolean;
  canSend: boolean;
  canDelete: boolean;
  historyId: string | null;
}

// ownerId travels on the row itself (not just as a query filter) so code that already has an
// AccountRow in hand — google.ts/microsoft.ts's token-refresh callbacks, hub.ts — can call
// updateAccountTokens(account.ownerId, account.id, ...) etc. without threading a second id
// through every provider function that takes an AccountRow.
const rowSelect = `id, owner_id AS ownerId, provider, email, access_token AS accessToken,
                   refresh_token AS refreshToken, expiry_date AS expiryDate,
                   auth_broken AS authBroken, auth_broken_at AS authBrokenAt,
                   can_read AS canRead, can_send AS canSend, can_delete AS canDelete,
                   history_id AS historyId`;

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
  const row = raw as Omit<AccountRow, "authBroken" | "canRead" | "canSend" | "canDelete"> & {
    authBroken: number;
    canRead: number;
    canSend: number;
    canDelete: number;
  };
  return {
    ...row,
    authBroken: !!row.authBroken,
    canRead: !!row.canRead,
    canSend: !!row.canSend,
    canDelete: !!row.canDelete,
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

// Written after a full list (baseline) or a successful incremental sync (google.ts) — the
// checkpoint google.ts's next call starts an incremental fetch from. Passing null explicitly
// forces the next call back to a full list (used when Gmail reports the stored id has expired,
// 404/"historyId too old").
export function setAccountHistoryId(ownerId: number, id: number, historyId: string | null): void {
  db.prepare(`UPDATE accounts SET history_id = ? WHERE id = ? AND owner_id = ?`).run(
    historyId,
    id,
    ownerId
  );
}

// Backs the Settings page's per-inbox Read/Send/Delete toggles. Only the fields present in
// `patch` are touched — COALESCE keeps the rest at their current value, same idiom as
// updateAccountTokens's refresh_token handling above.
export function updateAccountPermissions(
  ownerId: number,
  id: number,
  patch: { canRead?: boolean; canSend?: boolean; canDelete?: boolean }
): void {
  db.prepare(
    `UPDATE accounts SET
       can_read = COALESCE(@canRead, can_read),
       can_send = COALESCE(@canSend, can_send),
       can_delete = COALESCE(@canDelete, can_delete)
     WHERE id = @id AND owner_id = @ownerId`
  ).run({
    id,
    ownerId,
    canRead: patch.canRead === undefined ? null : patch.canRead ? 1 : 0,
    canSend: patch.canSend === undefined ? null : patch.canSend ? 1 : 0,
    canDelete: patch.canDelete === undefined ? null : patch.canDelete ? 1 : 0,
  });
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
  gaveUpAt: number | null;
}

const MEMORY_NOTE_COLUMNS = `id, content, created_at AS createdAt, trigger_at AS triggerAt, last_surfaced_at AS lastSurfacedAt, gave_up_at AS gaveUpAt`;

export function listMemoryNotes(ownerId: number): MemoryNoteRow[] {
  return db
    .prepare(`SELECT ${MEMORY_NOTE_COLUMNS} FROM memory_notes WHERE owner_id = ? ORDER BY id DESC`)
    .all(ownerId) as MemoryNoteRow[];
}

// Used when building the assistant's system prompt (unlike listMemoryNotes, which the Setup
// page uses to show the full vault) — caps how many notes get resent as tokens on every single
// call so the prompt doesn't grow forever as the vault accumulates facts over months of use.
// Anything older than this window is still reachable via searchMemoryNotes() below, on demand.
export function listRecentMemoryNotes(ownerId: number, limit = 30): MemoryNoteRow[] {
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

// On-demand lookup for notes outside the recency window listRecentMemoryNotes injects into every
// prompt. Query terms are extracted and re-quoted rather than passed to MATCH raw — FTS5's query
// syntax treats quotes/colons/NOT/OR etc. as operators, and a note-search phrase from the model
// (or forwarded user text) containing any of those would otherwise throw instead of just matching
// literally. Terms are ANDed: every term must appear (in any column-equivalent position) for a note
// to match, which keeps multi-word queries from over-matching on any single common word.
export function searchMemoryNotes(ownerId: number, query: string, limit = 10): MemoryNoteRow[] {
  const terms = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (terms.length === 0) return [];

  const matchQuery = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" AND ");
  return db
    .prepare(
      `SELECT m.id, m.content, m.created_at AS createdAt, m.trigger_at AS triggerAt,
              m.last_surfaced_at AS lastSurfacedAt, m.gave_up_at AS gaveUpAt
       FROM memory_notes_fts f
       JOIN memory_notes m ON m.id = f.rowid
       WHERE f.memory_notes_fts MATCH ? AND m.owner_id = ?
       ORDER BY rank
       LIMIT ?`
    )
    .all(matchQuery, ownerId, limit) as MemoryNoteRow[];
}

// Same FTS approach as searchMemoryNotes, restricted to notes that are actually reminders
// (trigger_at IS NOT NULL) — backs check_reminder_status, so an ordinary fact never shows up when
// the user asks "did X reminder go out". Status (sent/failed/scheduled/pending) is derived by the
// caller from triggerAt/lastSurfacedAt/gaveUpAt rather than stored directly.
export function searchReminderNotes(ownerId: number, query: string, limit = 10): MemoryNoteRow[] {
  const terms = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (terms.length === 0) return [];

  const matchQuery = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" AND ");
  return db
    .prepare(
      `SELECT m.id, m.content, m.created_at AS createdAt, m.trigger_at AS triggerAt,
              m.last_surfaced_at AS lastSurfacedAt, m.gave_up_at AS gaveUpAt
       FROM memory_notes_fts f
       JOIN memory_notes m ON m.id = f.rowid
       WHERE f.memory_notes_fts MATCH ? AND m.owner_id = ? AND m.trigger_at IS NOT NULL
       ORDER BY rank
       LIMIT ?`
    )
    .all(matchQuery, ownerId, limit) as MemoryNoteRow[];
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

// The other side of the give-up tradeoff documented above listDueMemoryReminders: once a reminder
// ages out of that query without ever sending, this is how checkDueMemoryReminders finds it (once)
// to notify the user it failed, and how markMemoryGivenUp below stops it from being found again.
export function listMemoryRemindersToGiveUpOn(ownerId: number, nowMs: number): MemoryNoteRow[] {
  return db
    .prepare(
      `SELECT ${MEMORY_NOTE_COLUMNS} FROM memory_notes
       WHERE owner_id = ? AND trigger_at IS NOT NULL AND trigger_at <= ?
         AND last_surfaced_at IS NULL AND gave_up_at IS NULL
       ORDER BY trigger_at ASC`
    )
    .all(ownerId, nowMs - MEMORY_REMINDER_GIVE_UP_WINDOW_MS) as MemoryNoteRow[];
}

export function markMemoryGivenUp(ownerId: number, id: number): void {
  db.prepare(`UPDATE memory_notes SET gave_up_at = ? WHERE id = ? AND owner_id = ?`).run(Date.now(), id, ownerId);
}

// --- Reminders (see the `reminders` table comment above for why this is its own table) ---

export type ReminderMode = "once" | "interval" | "until_reply";
export type ReminderStatus = "active" | "done" | "cancelled" | "gave_up";

export interface ReminderRow {
  id: number;
  message: string;
  mode: ReminderMode;
  nextFireAt: number;
  intervalMs: number | null;
  windowEndAt: number | null;
  status: ReminderStatus;
  createdAt: number;
  lastSentAt: number | null;
}

const REMINDER_COLUMNS = `id, message, mode, next_fire_at AS nextFireAt, interval_ms AS intervalMs,
  window_end_at AS windowEndAt, status, created_at AS createdAt, last_sent_at AS lastSentAt`;

export interface CreateReminderInput {
  message: string;
  mode: ReminderMode;
  nextFireAt: number;
  intervalMs?: number | null;
  windowEndAt?: number | null;
}

export function createReminder(ownerId: number, input: CreateReminderInput): ReminderRow {
  const info = db
    .prepare(
      `INSERT INTO reminders (owner_id, message, mode, next_fire_at, interval_ms, window_end_at, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`
    )
    .run(
      ownerId,
      input.message,
      input.mode,
      input.nextFireAt,
      input.intervalMs ?? null,
      input.windowEndAt ?? null,
      Date.now()
    );
  return db
    .prepare(`SELECT ${REMINDER_COLUMNS} FROM reminders WHERE id = ?`)
    .get(info.lastInsertRowid) as ReminderRow;
}

// Indexed via idx_reminders_owner_status_next (same shape as the old listDueMemoryReminders) —
// cost stays proportional to how many reminders are actually due for this owner right now.
export function listDueRemindersForOwner(ownerId: number, nowMs: number): ReminderRow[] {
  return db
    .prepare(
      `SELECT ${REMINDER_COLUMNS} FROM reminders
       WHERE owner_id = ? AND status = 'active' AND next_fire_at <= ?
       ORDER BY next_fire_at ASC`
    )
    .all(ownerId, nowMs) as ReminderRow[];
}

export function listActiveRemindersForOwner(ownerId: number): ReminderRow[] {
  return db
    .prepare(
      `SELECT ${REMINDER_COLUMNS} FROM reminders WHERE owner_id = ? AND status = 'active' ORDER BY next_fire_at ASC`
    )
    .all(ownerId) as ReminderRow[];
}

// Called by reminderScheduler.ts right after a successful send: 'once' reminders are done after
// firing exactly once; 'interval' reminders advance to the next slot and finish once that would
// fall past window_end_at; 'until_reply' reminders just keep advancing — they only stop via
// cancelUntilReplyRemindersForOwner (any inbound message) or markReminderGivenUp (safety cap).
export function advanceReminderAfterSend(id: number): void {
  const row = db
    .prepare(
      `SELECT mode, next_fire_at AS nextFireAt, interval_ms AS intervalMs, window_end_at AS windowEndAt
       FROM reminders WHERE id = ?`
    )
    .get(id) as
    | { mode: ReminderMode; nextFireAt: number; intervalMs: number | null; windowEndAt: number | null }
    | undefined;
  if (!row) return;

  const now = Date.now();
  if (row.mode === "once" || row.intervalMs == null) {
    db.prepare(`UPDATE reminders SET status = 'done', last_sent_at = ? WHERE id = ?`).run(now, id);
    return;
  }
  const next = row.nextFireAt + row.intervalMs;
  if (row.mode === "interval" && row.windowEndAt != null && next > row.windowEndAt) {
    db.prepare(`UPDATE reminders SET status = 'done', last_sent_at = ? WHERE id = ?`).run(now, id);
    return;
  }
  db.prepare(`UPDATE reminders SET next_fire_at = ?, last_sent_at = ? WHERE id = ?`).run(next, now, id);
}

// The stop-on-reply hook (routes/whatsappRoutes.ts's handleIncoming) — any inbound WhatsApp
// message cancels every one of this owner's currently-active 'until_reply' reminders. 'once' and
// 'interval' reminders are untouched: they stop on their own schedule, never on a reply.
export function cancelUntilReplyRemindersForOwner(ownerId: number): void {
  db.prepare(
    `UPDATE reminders SET status = 'cancelled' WHERE owner_id = ? AND status = 'active' AND mode = 'until_reply'`
  ).run(ownerId);
}

export function cancelReminder(ownerId: number, id: number): boolean {
  const info = db
    .prepare(`UPDATE reminders SET status = 'cancelled' WHERE id = ? AND owner_id = ? AND status = 'active'`)
    .run(id, ownerId);
  return info.changes > 0;
}

// Safety cap for 'until_reply' reminders so a forgotten "text me every minute until I reply"
// doesn't run forever if the user never replies (asleep, phone off, ...) — same 24h-give-up
// philosophy the old memoryReminders.ts used. Checked by reminderScheduler.ts.
export function listRemindersToGiveUpOnForOwner(ownerId: number, cutoffMs: number): ReminderRow[] {
  return db
    .prepare(
      `SELECT ${REMINDER_COLUMNS} FROM reminders
       WHERE owner_id = ? AND status = 'active' AND mode = 'until_reply' AND created_at <= ?
       ORDER BY created_at ASC`
    )
    .all(ownerId, cutoffMs) as ReminderRow[];
}

export function markReminderGivenUp(id: number): void {
  db.prepare(`UPDATE reminders SET status = 'gave_up' WHERE id = ?`).run(id);
}

// Backs check_reminder_status — a simple LIKE scan rather than FTS infrastructure, since a single
// user's reminder volume never gets large enough for that to matter.
export function searchReminders(ownerId: number, query: string, limit = 10): ReminderRow[] {
  const escaped = query.replace(/[\\%_]/g, (c) => `\\${c}`);
  return db
    .prepare(
      `SELECT ${REMINDER_COLUMNS} FROM reminders
       WHERE owner_id = ? AND message LIKE ? ESCAPE '\\'
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(ownerId, `%${escaped}%`, limit) as ReminderRow[];
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

// wamids: the WhatsApp message id(s) this history row corresponds to — a single-element array for
// an inbound message, or one element per chunk for an outbound reply split across several sends
// (services/messageSplitting.ts). Optional and omitted by most existing callers (reactions,
// short-circuit replies like "help"/version text) that don't need to be resolvable as a quote
// target.
export function appendWhatsAppMessage(
  ownerId: number,
  phone: string,
  role: "user" | "assistant",
  content: string,
  wamids?: string[]
): void {
  const info = db
    .prepare(
      `INSERT INTO whatsapp_messages (owner_id, phone, role, content, created_at) VALUES (?, ?, ?, ?, ?)`
    )
    .run(ownerId, phone, role, content, Date.now());
  if (wamids?.length) {
    const insertWamid = db.prepare(
      `INSERT OR IGNORE INTO whatsapp_message_wamids (wamid, message_id) VALUES (?, ?)`
    );
    for (const wamid of wamids) insertWamid.run(wamid, info.lastInsertRowid);
  }
}

// Resolves a swipe-to-reply (Meta's `context.id`) back to the message it quoted, no matter how
// long ago it was sent/received — whatsapp_message_wamids is never pruned, unlike seen_wamids.
// Scoped by ownerId (defense in depth, same convention as searchWhatsAppHistory/getDocument) so a
// lookup can never cross an owner boundary even on a wamid collision.
export function getWhatsAppMessageByWamid(ownerId: number, wamid: string): WhatsAppMessageRow | undefined {
  return db
    .prepare(
      `SELECT w.id, w.phone, w.role, w.content, w.created_at AS createdAt
       FROM whatsapp_message_wamids ww
       JOIN whatsapp_messages w ON w.id = ww.message_id
       WHERE ww.wamid = ? AND w.owner_id = ?`
    )
    .get(wamid, ownerId) as WhatsAppMessageRow | undefined;
}

// Reaches the full raw transcript, not just the MAX_HISTORY_MESSAGES window the assistant sees by
// default — same tokenize-and-MATCH approach as searchMemoryNotes (store.ts:1040) above. Filters
// by both phone (the natural key for "this conversation thread") and owner_id (defense in depth,
// matching searchMemoryNotes's convention) — phone alone should already be unique per owner, but
// scoping by both means a lookup can never cross an owner boundary even if that ever stopped
// holding. Terms are ANDed, same reasoning as searchMemoryNotes: keeps multi-word queries from
// over-matching on any single common word.
export function searchWhatsAppHistory(
  ownerId: number,
  phone: string,
  query: string,
  limit = 20
): WhatsAppMessageRow[] {
  const terms = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (terms.length === 0) return [];

  const matchQuery = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" AND ");
  return db
    .prepare(
      `SELECT w.id, w.phone, w.role, w.content, w.created_at AS createdAt
       FROM whatsapp_messages_fts f
       JOIN whatsapp_messages w ON w.id = f.rowid
       WHERE f.whatsapp_messages_fts MATCH ? AND w.phone = ? AND w.owner_id = ?
       ORDER BY rank
       LIMIT ?`
    )
    .all(matchQuery, phone, ownerId, limit) as WhatsAppMessageRow[];
}

export interface ConversationSummaryRow {
  phone: string;
  summary: string;
  summarizedThroughId: number;
  updatedAt: number;
}

export function getConversationSummary(phone: string): ConversationSummaryRow | null {
  const row = db
    .prepare(
      `SELECT phone, summary, summarized_through_id AS summarizedThroughId, updated_at AS updatedAt
       FROM whatsapp_conversation_summaries WHERE phone = ?`
    )
    .get(phone) as ConversationSummaryRow | undefined;
  return row ?? null;
}

export function saveConversationSummary(phone: string, summary: string, summarizedThroughId: number): void {
  db.prepare(
    `INSERT INTO whatsapp_conversation_summaries (phone, summary, summarized_through_id, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(phone) DO UPDATE SET
       summary = excluded.summary,
       summarized_through_id = excluded.summarized_through_id,
       updated_at = excluded.updated_at`
  ).run(phone, summary, summarizedThroughId, Date.now());
}

// The batch of messages that has fallen out of the raw history window since the last summary
// update: strictly newer than `afterId` (the previous summarizedThroughId, or 0 for "never
// summarized"), strictly older than the current window — i.e. excluding the most recent
// `keepRecent` rows, which the model still sees directly and don't need summarizing yet. Empty
// once total history still fits inside the raw window (nothing has fallen out yet).
export function getWhatsAppBacklogForSummary(
  phone: string,
  afterId: number,
  keepRecent: number
): WhatsAppMessageRow[] {
  const recentIds = db
    .prepare(`SELECT id FROM whatsapp_messages WHERE phone = ? ORDER BY id DESC LIMIT ?`)
    .all(phone, keepRecent) as { id: number }[];
  if (recentIds.length < keepRecent) return [];
  const windowStartId = recentIds[recentIds.length - 1].id;
  return db
    .prepare(
      `SELECT id, phone, role, content, created_at AS createdAt FROM whatsapp_messages
       WHERE phone = ? AND id > ? AND id < ? ORDER BY id ASC`
    )
    .all(phone, afterId, windowStartId) as WhatsAppMessageRow[];
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
  emailAccountEmail: string | null;
  wamid: string | null;
}

const DOCUMENT_COLUMNS = `id, phone, filename, mime_type AS mimeType, stored_path AS storedPath,
  caption, title, extracted_text AS extractedText, category, created_at AS createdAt,
  xero_forwarded_at AS xeroForwardedAt, source, email_account_id AS emailAccountId,
  email_message_id AS emailMessageId, email_attachment_id AS emailAttachmentId,
  email_account_email AS emailAccountEmail, wamid`;

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
    wamid?: string | null;
  }
): DocumentRow {
  // Snapshotted at save time (not resolved on read) so the tag survives the account later
  // being disconnected — see the email_account_email migration comment above.
  const emailAccountEmail = doc.emailAccountId ? getAccount(ownerId, doc.emailAccountId)?.email ?? null : null;
  const info = db
    .prepare(
      `INSERT INTO documents (owner_id, phone, filename, mime_type, stored_path, caption, title, extracted_text, category, created_at, source, email_account_id, email_message_id, email_attachment_id, email_account_email, wamid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      doc.emailAttachmentId ?? null,
      emailAccountEmail,
      doc.wamid ?? null
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

// Resolves a swipe-to-reply on a previously-sent photo/document back to its real extracted
// content — see whatsapp_message_wamids/getWhatsAppMessageByWamid above for the same idea applied
// to plain-text messages. Scoped by ownerId, same convention as getDocument.
export function getDocumentByWamid(ownerId: number, wamid: string): DocumentRow | undefined {
  return db
    .prepare(`SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE owner_id = ? AND wamid = ?`)
    .get(ownerId, wamid) as DocumentRow | undefined;
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

// Hard delete, owner-scoped — mirrors deleteDocument. Also drops any links rows pointing at this
// entity (e.g. an expense's "extracted_from" link to its source document, or a "belongs_to" link
// to a trip) so undoing an expense doesn't leave a dangling reference for get_trip_contents etc.
// to trip over. links has no FK to entities (see deleteUserCompletely), so this is for data
// consistency, not to satisfy a constraint.
export function deleteEntity(ownerId: number, id: number): void {
  const purge = db.transaction(() => {
    db.prepare(
      `DELETE FROM links WHERE owner_id = ? AND ((from_type = 'entity' AND from_id = ?) OR (to_type = 'entity' AND to_id = ?))`
    ).run(ownerId, id, id);
    db.prepare(`DELETE FROM entities WHERE id = ? AND owner_id = ?`).run(id, ownerId);
  });
  purge();
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
// remember → entities bridge: what lets the assistant's `remember` tool optionally file
// a note onto a named, recurring subject instead of only ever writing a flat memory_notes
// row. Reuses the generic entity/link CRUD above — no new tables.
// ---------------------------------------------------------------------------

export interface RememberedEntityData {
  name: string;
  notes: { text: string; at: number }[];
}

function normalizeEntityName(name: string): string {
  return name.trim().toLowerCase();
}

// Dedupes by owner+type+lowercased name so the same subject mentioned across separate
// remember calls accumulates onto one entity instead of spawning near-duplicate rows.
export function findOrCreateEntity(
  ownerId: number,
  type: string,
  name: string
): EntityRow<RememberedEntityData> {
  const existing = findEntityByName(ownerId, name, type);
  if (existing) return existing;
  const trimmed = name.trim();
  if (!trimmed) throw new Error("findOrCreateEntity: name must not be blank");
  return saveEntity<RememberedEntityData>(ownerId, {
    type,
    data: { name: trimmed, notes: [] },
  });
}

export function appendEntityNote(
  ownerId: number,
  entityId: number,
  text: string
): EntityRow<RememberedEntityData> {
  const entity = getEntity<RememberedEntityData>(ownerId, entityId);
  if (!entity) throw new Error(`entity ${entityId} not found`);
  const notes = [...entity.data.notes, { text, at: Date.now() }];
  return updateEntity<RememberedEntityData>(ownerId, entityId, {
    data: { ...entity.data, notes },
  });
}

// Narrows an entity's untyped `data` down to RememberedEntityData shape — required because
// listEntities(ownerId, {}) (no type filter) returns entities of every type for this owner,
// including pre-existing document-extracted ones (travel_checkin, trip, expense, booking)
// whose data shape is unrelated. A `name` string alone isn't enough to tell them apart
// (booking also has one) — requiring `notes` too is what no pre-existing type has.
function isRememberedEntity(data: unknown): data is RememberedEntityData {
  return (
    typeof data === "object" &&
    data !== null &&
    typeof (data as RememberedEntityData).name === "string" &&
    Array.isArray((data as RememberedEntityData).notes)
  );
}

// Case-insensitive exact-name lookup, optionally narrowed to one type — used both by
// findOrCreateEntity's dedupe check and by remember's relates_to / recall_entity.
export function findEntityByName(
  ownerId: number,
  name: string,
  type?: string
): EntityRow<RememberedEntityData> | null {
  const normalized = normalizeEntityName(name);
  if (!normalized) return null;
  return (
    listEntities<unknown>(ownerId, type ? { type } : {}).find(
      (e): e is EntityRow<RememberedEntityData> =>
        isRememberedEntity(e.data) && normalizeEntityName(e.data.name) === normalized
    ) ?? null
  );
}

export interface ReadEmailRow {
  id: number;
  accountId: number;
  accountEmail: string;
  messageId: string;
  subject: string;
  from: string;
  snippet: string;
  body: string | null;
  receivedAt: string;
  readAt: number;
}

// Writes/refreshes the read_emails cache row for one message — called from hub.ts's
// fetchMessages (metadata only, every time a message is listed) and from assistant.ts's
// get_message tool (with body, once the full email is actually opened). Upserts on
// (owner, account, message id) so a re-list or a re-open refreshes the same row rather than
// piling up duplicates. body is only ever moved forward, never backward: a later metadata-only
// upsert (no body given) must not erase a body an earlier get_message already saved, so it's
// COALESCEd against whatever's already stored rather than overwritten unconditionally.
export function upsertReadEmail(
  ownerId: number,
  message: {
    accountId: number;
    accountEmail: string;
    id: string;
    subject: string;
    from: string;
    snippet: string;
    receivedAt: string;
    body?: string | null;
  }
): void {
  db.prepare(
    `INSERT INTO read_emails
       (owner_id, account_id, account_email, message_id, subject, sender, snippet, body, received_at, read_at)
     VALUES (@ownerId, @accountId, @accountEmail, @messageId, @subject, @sender, @snippet, @body, @receivedAt, @readAt)
     ON CONFLICT(owner_id, account_id, message_id) DO UPDATE SET
       account_email = excluded.account_email,
       subject       = excluded.subject,
       sender        = excluded.sender,
       snippet       = excluded.snippet,
       body          = COALESCE(excluded.body, read_emails.body),
       received_at   = excluded.received_at,
       read_at       = excluded.read_at`
  ).run({
    ownerId,
    accountId: message.accountId,
    accountEmail: message.accountEmail,
    messageId: message.id,
    subject: message.subject,
    sender: message.from,
    snippet: message.snippet,
    body: message.body ?? null,
    receivedAt: message.receivedAt,
    readAt: Date.now(),
  });
}

// Plain LIKE, not FTS — same precedent as searchDocuments (store.ts above): per-user volume here
// is bounded by how much mail Marlowe actually lists/opens, not a full message-transcript firehose
// like whatsapp_messages/memory_notes, so FTS5's extra machinery (virtual table + triggers) isn't
// worth it. Searches every previously-seen email regardless of whether it was ever fully opened —
// a metadata-only row (body still NULL) still matches on subject/sender/snippet.
export function searchReadEmails(ownerId: number, query: string, limit = 10): ReadEmailRow[] {
  const like = `%${query}%`;
  const rows = db
    .prepare(
      `SELECT id, account_id AS accountId, account_email AS accountEmail, message_id AS messageId,
              subject, sender, snippet, body, received_at AS receivedAt, read_at AS readAt
       FROM read_emails
       WHERE owner_id = ? AND (subject LIKE ? OR sender LIKE ? OR snippet LIKE ? OR body LIKE ?)
       ORDER BY id DESC LIMIT ?`
    )
    .all(ownerId, like, like, like, like, limit) as (Omit<ReadEmailRow, "from"> & { sender: string })[];
  return rows.map(({ sender, ...rest }) => ({ ...rest, from: sender }));
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

// Gates the admin Portal (to-dos, poster board, unmet requests, logs, usage) — broader than
// isAppOwner: the app owner is always implicitly an admin, plus anyone else an existing admin has
// promoted via the Portal's Admins tab. Deliberately kept separate from isAppOwner, which still
// alone gates the narrower invites/reset-test-phone section in Settings (see adminRoutes.ts).
export function isAdmin(userId: number): boolean {
  if (isAppOwner(userId)) return true;
  const row = db.prepare(`SELECT is_admin AS isAdmin FROM users WHERE id = ?`).get(userId) as
    | { isAdmin: number }
    | undefined;
  return row?.isAdmin === 1;
}

export interface AdminCandidateRow {
  id: number;
  email: string;
  isAdmin: boolean;
  isAppOwner: boolean;
  createdAt: number;
}

// Every user, with their admin status resolved — lets the Portal's Admins tab show who already
// has access and pick from everyone else to grant it to (only invited users can log in at all,
// so this list is implicitly scoped to people who could actually use it).
export function listAdminCandidateUsers(): AdminCandidateRow[] {
  const rows = db
    .prepare(`SELECT id, email, is_admin AS isAdminFlag, created_at AS createdAt FROM users ORDER BY created_at ASC`)
    .all() as { id: number; email: string; isAdminFlag: number; createdAt: number }[];
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    isAdmin: r.isAdminFlag === 1 || r.id === getAppOwnerUserId(),
    isAppOwner: r.id === getAppOwnerUserId(),
    createdAt: r.createdAt,
  }));
}

// The app owner can't be demoted this way (isAdmin() checks isAppOwner first regardless of the
// flag) — callers should still avoid calling this on the owner so the Admins tab doesn't show a
// revoke action that would silently do nothing.
export function setUserAdmin(userId: number, admin: boolean): void {
  db.prepare(`UPDATE users SET is_admin = ? WHERE id = ?`).run(admin ? 1 : 0, userId);
}

export interface UnmetRequestRow {
  id: number;
  ownerId: number;
  summary: string;
  channel: string;
  createdAt: number;
  resolvedAt: number | null;
}

// Written by the assistant's flag_unmet_request tool (assistant.ts) whenever a user asks for
// something Marlowe genuinely can't do — gives admins a running signal of what to build next
// without having to comb through conversation history themselves.
export function addUnmetRequest(ownerId: number, summary: string, channel: string): void {
  db.prepare(
    `INSERT INTO unmet_requests (owner_id, summary, channel, created_at) VALUES (?, ?, ?, ?)`
  ).run(ownerId, summary, channel, Date.now());
}

export function listUnmetRequests(includeResolved: boolean): UnmetRequestRow[] {
  const sql = includeResolved
    ? `SELECT id, owner_id AS ownerId, summary, channel, created_at AS createdAt, resolved_at AS resolvedAt
       FROM unmet_requests ORDER BY created_at DESC`
    : `SELECT id, owner_id AS ownerId, summary, channel, created_at AS createdAt, resolved_at AS resolvedAt
       FROM unmet_requests WHERE resolved_at IS NULL ORDER BY created_at DESC`;
  return db.prepare(sql).all() as UnmetRequestRow[];
}

export function resolveUnmetRequest(id: number): void {
  db.prepare(`UPDATE unmet_requests SET resolved_at = ? WHERE id = ?`).run(Date.now(), id);
}

export interface ServerLogRow {
  id: number;
  level: string;
  message: string;
  createdAt: number;
  explanation: string | null;
  explainedAt: number | null;
}

// Written by logCapture.ts, which wraps console.error/console.warn once at startup so every
// existing call site across the codebase is captured without having to touch each one.
export function addServerLog(level: string, message: string): void {
  db.prepare(`INSERT INTO server_logs (level, message, created_at) VALUES (?, ?, ?)`).run(
    level,
    message,
    Date.now()
  );
}

export function listRecentServerLogs(limit: number): ServerLogRow[] {
  return db
    .prepare(
      `SELECT id, level, message, created_at AS createdAt, explanation, explained_at AS explainedAt
       FROM server_logs ORDER BY created_at DESC LIMIT ?`
    )
    .all(limit) as ServerLogRow[];
}

export function getServerLog(id: number): ServerLogRow | null {
  const row = db
    .prepare(
      `SELECT id, level, message, created_at AS createdAt, explanation, explained_at AS explainedAt
       FROM server_logs WHERE id = ?`
    )
    .get(id) as ServerLogRow | undefined;
  return row ?? null;
}

// Caches a Claude-generated plain-English explanation on the log row itself, so re-opening the
// same log in the Portal doesn't pay for another API call.
export function setServerLogExplanation(id: number, explanation: string): void {
  db.prepare(`UPDATE server_logs SET explanation = ?, explained_at = ? WHERE id = ?`).run(
    explanation,
    Date.now(),
    id
  );
}

// Called once per scheduler tick (see scheduler.ts) to keep the table bounded — logs are a
// debugging aid, not a permanent record worth keeping forever.
export function pruneOldServerLogs(maxAgeMs: number): void {
  db.prepare(`DELETE FROM server_logs WHERE created_at < ?`).run(Date.now() - maxAgeMs);
}

// One row per traced API call — for the multi-turn callers (runAssistantChat, documents.ts's
// runExtraction) that's once per outer invocation with turns summed, not once per internal turn;
// see each call site's own comment. ownerId is null for calls with no signed-in user yet (the
// public help widget, the WhatsApp registration assistant, before an account exists).
// cacheReadTokens/cacheCreationTokens come from usage.cache_read_input_tokens and
// usage.cache_creation_input_tokens — with prompt caching active, usage.input_tokens excludes
// both, so omitting them here is what made the Usage tab blind to most of the real bill. Every
// call site passes them (0 for uncached calls) so a future caching change can't silently
// reintroduce that gap.
export function recordApiUsage(
  ownerId: number | null,
  channel: string,
  model: string,
  purpose: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number
): void {
  db.prepare(
    `INSERT INTO api_usage (owner_id, channel, model, purpose, input_tokens, output_tokens,
                            cache_read_tokens, cache_creation_tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(ownerId, channel, model, purpose, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, Date.now());
}

export interface ApiUsageSummaryRow {
  day: string;
  channel: string;
  model: string;
  purpose: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

// Grouped in SQL rather than fetched-and-reduced in JS — this table only grows over time, so
// letting SQLite do the aggregation keeps this cheap regardless of how much history accumulates.
export function getApiUsageSummary(sinceMs: number): ApiUsageSummaryRow[] {
  return db
    .prepare(
      `SELECT
         date(created_at / 1000, 'unixepoch') AS day,
         channel,
         model,
         purpose,
         COUNT(*) AS calls,
         SUM(input_tokens) AS inputTokens,
         SUM(output_tokens) AS outputTokens,
         SUM(cache_read_tokens) AS cacheReadTokens,
         SUM(cache_creation_tokens) AS cacheCreationTokens
       FROM api_usage
       WHERE created_at >= ?
       GROUP BY day, channel, model, purpose
       ORDER BY day DESC`
    )
    .all(sinceMs) as ApiUsageSummaryRow[];
}

export interface ApiUsageByPurposeRow {
  purpose: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

// A flatter "what's actually costing us tokens" view than getApiUsageSummary's day-by-day
// breakdown — totals per purpose across the whole window, for the Portal Usage tab's headline
// breakdown rather than the detailed table underneath it.
export function getApiUsageByPurpose(sinceMs: number): ApiUsageByPurposeRow[] {
  return db
    .prepare(
      `SELECT
         purpose,
         COUNT(*) AS calls,
         SUM(input_tokens) AS inputTokens,
         SUM(output_tokens) AS outputTokens,
         SUM(cache_read_tokens) AS cacheReadTokens,
         SUM(cache_creation_tokens) AS cacheCreationTokens
       FROM api_usage
       WHERE created_at >= ?
       GROUP BY purpose
       ORDER BY (SUM(input_tokens) + SUM(output_tokens) + SUM(cache_read_tokens) + SUM(cache_creation_tokens)) DESC`
    )
    .all(sinceMs) as ApiUsageByPurposeRow[];
}

export interface ApiUsageByOwnerModelRow {
  ownerEmail: string | null;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

// Grouped by owner AND model (not just owner) so the caller can apply per-model pricing before
// collapsing to one total per owner — mirrors how getApiUsageSummary's rows feed byPurpose's
// cost totals in portalRoutes.ts, for the same reason (a blended rate across models would be
// wrong). ownerEmail is null both for pre-login WhatsApp calls (no owner yet) and for a user
// since deleted (e.g. via reset-test-phone) — LEFT JOIN, not JOIN.
export function getApiUsageByOwner(sinceMs: number): ApiUsageByOwnerModelRow[] {
  return db
    .prepare(
      `SELECT
         us.email AS ownerEmail,
         u.model,
         COUNT(*) AS calls,
         SUM(u.input_tokens) AS inputTokens,
         SUM(u.output_tokens) AS outputTokens,
         SUM(u.cache_read_tokens) AS cacheReadTokens,
         SUM(u.cache_creation_tokens) AS cacheCreationTokens
       FROM api_usage u LEFT JOIN users us ON us.id = u.owner_id
       WHERE u.created_at >= ?
       GROUP BY u.owner_id, u.model
       ORDER BY (SUM(u.input_tokens) + SUM(u.output_tokens) + SUM(u.cache_read_tokens) + SUM(u.cache_creation_tokens)) DESC`
    )
    .all(sinceMs) as ApiUsageByOwnerModelRow[];
}

export interface ApiUsageCallRow {
  id: number;
  ownerEmail: string | null;
  channel: string;
  model: string;
  purpose: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  createdAt: number;
}

// Individual calls with an exact timestamp, newest first — getApiUsageSummary/getApiUsageByPurpose
// only aggregate down to the day, which isn't specific enough to tell exactly when something
// happened (e.g. tracking down what caused a cost spike). LEFT JOIN, not JOIN — owner_id is
// nullable (calls with no signed-in user yet, e.g. the public help widget).
export function listRecentApiUsage(limit: number): ApiUsageCallRow[] {
  return db
    .prepare(
      `SELECT u.id, us.email AS ownerEmail, u.channel, u.model, u.purpose,
              u.input_tokens AS inputTokens, u.output_tokens AS outputTokens,
              u.cache_read_tokens AS cacheReadTokens, u.cache_creation_tokens AS cacheCreationTokens,
              u.created_at AS createdAt
       FROM api_usage u LEFT JOIN users us ON us.id = u.owner_id
       ORDER BY u.created_at DESC, u.id DESC
       LIMIT ?`
    )
    .all(limit) as ApiUsageCallRow[];
}

export interface AdminTodoReplyRow {
  id: number;
  todoId: number;
  text: string;
  authorId: number;
  authorEmail: string;
  createdAt: number;
}

export interface AdminTodoRow {
  id: number;
  text: string;
  done: boolean;
  createdBy: number;
  createdByEmail: string;
  createdAt: number;
  doneAt: number | null;
  replies: AdminTodoReplyRow[];
  // Replies on this todo with id > viewerId's last-read-reply-id — personal to whichever admin
  // is calling listAdminTodos, not a global count. See admin_todo_reply_reads above.
  unreadReplyCount: number;
}

// viewerId drives unreadReplyCount — every admin sees the same todos/replies, but each has their
// own read position per todo, so the same todo can show "2 unread" to one admin and "0" to
// another. Replies are fetched in one extra query (not per-todo N+1) and grouped in JS; an admin
// to-do list is small enough that this is simpler than a correlated SQL subquery per row.
export function listAdminTodos(viewerId: number): AdminTodoRow[] {
  const todoRows = db
    .prepare(
      `SELECT t.id, t.text, t.done, t.created_by AS createdBy, u.email AS createdByEmail,
              t.created_at AS createdAt, t.done_at AS doneAt
       FROM admin_todos t JOIN users u ON u.id = t.created_by
       ORDER BY t.done ASC, t.created_at DESC`
    )
    .all() as (Omit<AdminTodoRow, "done" | "replies" | "unreadReplyCount"> & { done: number })[];

  const replyRows = db
    .prepare(
      `SELECT r.id, r.todo_id AS todoId, r.text, r.author_id AS authorId, u.email AS authorEmail,
              r.created_at AS createdAt
       FROM admin_todo_replies r JOIN users u ON u.id = r.author_id
       ORDER BY r.created_at ASC, r.id ASC`
    )
    .all() as AdminTodoReplyRow[];
  const repliesByTodo = new Map<number, AdminTodoReplyRow[]>();
  for (const r of replyRows) {
    const list = repliesByTodo.get(r.todoId) ?? [];
    list.push(r);
    repliesByTodo.set(r.todoId, list);
  }

  const readRows = db
    .prepare(`SELECT todo_id AS todoId, last_read_reply_id AS lastReadReplyId FROM admin_todo_reply_reads WHERE user_id = ?`)
    .all(viewerId) as { todoId: number; lastReadReplyId: number }[];
  const lastReadByTodo = new Map(readRows.map((r) => [r.todoId, r.lastReadReplyId]));

  return todoRows.map((t) => {
    const replies = repliesByTodo.get(t.id) ?? [];
    const lastRead = lastReadByTodo.get(t.id) ?? 0;
    return {
      ...t,
      done: t.done === 1,
      replies,
      unreadReplyCount: replies.filter((r) => r.id > lastRead).length,
    };
  });
}

export function addAdminTodo(text: string, createdBy: number): void {
  db.prepare(`INSERT INTO admin_todos (text, created_by, created_at) VALUES (?, ?, ?)`).run(
    text,
    createdBy,
    Date.now()
  );
}

export function setAdminTodoDone(id: number, done: boolean): void {
  db.prepare(`UPDATE admin_todos SET done = ?, done_at = ? WHERE id = ?`).run(
    done ? 1 : 0,
    done ? Date.now() : null,
    id
  );
}

export function deleteAdminTodo(id: number): void {
  // Children before parent — same manual-cascade precedent as the account-purge document/
  // document_match_keys ordering (no ON DELETE CASCADE in this schema).
  db.prepare(`DELETE FROM admin_todo_reply_reads WHERE todo_id = ?`).run(id);
  db.prepare(`DELETE FROM admin_todo_replies WHERE todo_id = ?`).run(id);
  db.prepare(`DELETE FROM admin_todos WHERE id = ?`).run(id);
}

export function addAdminTodoReply(todoId: number, authorId: number, text: string): void {
  db.prepare(`INSERT INTO admin_todo_replies (todo_id, author_id, text, created_at) VALUES (?, ?, ?, ?)`).run(
    todoId,
    authorId,
    text,
    Date.now()
  );
}

// Marks every reply currently on the todo as read for this viewer — not just the ones present
// when they opened it, but genuinely "up to now," since the upsert reads admin_todo_replies'
// current MAX(id) at write time rather than a client-supplied count.
export function markAdminTodoRepliesRead(todoId: number, userId: number): void {
  db.prepare(
    `INSERT INTO admin_todo_reply_reads (todo_id, user_id, last_read_reply_id)
     VALUES (?, ?, COALESCE((SELECT MAX(id) FROM admin_todo_replies WHERE todo_id = ?), 0))
     ON CONFLICT(todo_id, user_id) DO UPDATE SET last_read_reply_id = excluded.last_read_reply_id`
  ).run(todoId, userId, todoId);
}

export interface PosterNoteRow {
  id: number;
  authorId: number;
  authorEmail: string;
  text: string;
  createdAt: number;
}

export function listPosterNotes(limit: number): PosterNoteRow[] {
  return db
    .prepare(
      `SELECT n.id, n.author_id AS authorId, u.email AS authorEmail, n.text, n.created_at AS createdAt
       FROM poster_notes n JOIN users u ON u.id = n.author_id
       ORDER BY n.created_at DESC LIMIT ?`
    )
    .all(limit) as PosterNoteRow[];
}

export function addPosterNote(authorId: number, text: string): void {
  db.prepare(`INSERT INTO poster_notes (author_id, text, created_at) VALUES (?, ?, ?)`).run(
    authorId,
    text,
    Date.now()
  );
}

export function deletePosterNote(id: number): void {
  db.prepare(`DELETE FROM poster_notes WHERE id = ?`).run(id);
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
    // whatsapp_message_wamids.message_id REFERENCES whatsapp_messages(id) — must be deleted
    // before whatsapp_messages itself or the FK constraint rejects the whatsapp_messages delete.
    db.prepare(
      `DELETE FROM whatsapp_message_wamids WHERE message_id IN (SELECT id FROM whatsapp_messages WHERE owner_id = ?)`
    ).run(ownerId);
    db.prepare(`DELETE FROM whatsapp_messages WHERE owner_id = ?`).run(ownerId);
    // document_match_keys.document_id REFERENCES documents(id) — must be deleted before
    // documents itself or the FK constraint rejects the documents delete.
    db.prepare(`DELETE FROM document_match_keys WHERE owner_id = ?`).run(ownerId);
    db.prepare(`DELETE FROM documents WHERE owner_id = ?`).run(ownerId);
    db.prepare(`DELETE FROM travel_checkins WHERE owner_id = ?`).run(ownerId);
    db.prepare(`DELETE FROM entities WHERE owner_id = ?`).run(ownerId);
    db.prepare(`DELETE FROM links WHERE owner_id = ?`).run(ownerId);
    db.prepare(`DELETE FROM alerted_messages WHERE owner_id = ?`).run(ownerId);
    db.prepare(`DELETE FROM read_emails WHERE owner_id = ?`).run(ownerId);
    db.prepare(`DELETE FROM user_enabled_tools WHERE owner_id = ?`).run(ownerId);
    db.prepare(`DELETE FROM pending_setup WHERE owner_id = ?`).run(ownerId);
    db.prepare(`DELETE FROM onboarding_step_events WHERE owner_id = ?`).run(ownerId);
    db.prepare(`DELETE FROM pending_actions WHERE owner_id = ?`).run(ownerId);
    db.prepare(`DELETE FROM unmet_requests WHERE owner_id = ?`).run(ownerId);
    db.prepare(`DELETE FROM api_usage WHERE owner_id = ?`).run(ownerId);
    // admin_todos.created_by and poster_notes.author_id both declare NOT NULL REFERENCES
    // users(id) (Portal admin feature, commit 686d173). Same bug shape as the pending_setup/
    // pending_actions and document_match_keys fixes above: an admin (including the app owner
    // being reset here) who'd used their own to-do list or poster board left a row behind, and
    // the final DELETE FROM users below violated the foreign key.
    //
    // admin_todo_replies.author_id and admin_todo_reply_reads.user_id are the same shape again,
    // one generation later (threaded to-do replies, commit c16615f) — but two-directional, unlike
    // every fix above: this owner's own replies/reads on someone ELSE's to-do (author_id/user_id
    // = ownerId) AND every reply/read left by someone ELSE on a to-do THIS owner created, which
    // the DELETE FROM admin_todos below is about to remove as the parent row (todo_id IN ... ).
    // The first attempt at this fix only handled the first direction and still threw "FOREIGN KEY
    // constraint failed" in production — a real to-do creator whose to-dos other admins had
    // replied to/read. Children before parent, same manual-cascade order as deleteAdminTodo above.
    db.prepare(
      `DELETE FROM admin_todo_reply_reads WHERE user_id = ? OR todo_id IN (SELECT id FROM admin_todos WHERE created_by = ?)`
    ).run(ownerId, ownerId);
    db.prepare(
      `DELETE FROM admin_todo_replies WHERE author_id = ? OR todo_id IN (SELECT id FROM admin_todos WHERE created_by = ?)`
    ).run(ownerId, ownerId);
    db.prepare(`DELETE FROM admin_todos WHERE created_by = ?`).run(ownerId);
    db.prepare(`DELETE FROM poster_notes WHERE author_id = ?`).run(ownerId);
    db.prepare(`DELETE FROM user_phone_numbers WHERE user_id = ?`).run(ownerId);
    db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(ownerId);
    db.prepare(`DELETE FROM users WHERE id = ?`).run(ownerId);
  });
  purge();

  return { deletedDocumentPaths: documentPaths };
}

// A lighter alternative to deleteUserCompletely, for replaying the WhatsApp onboarding UX on an
// account you actually want to keep (usage, to-dos, poster board, documents, memory, chat
// history — everything data-bearing stays put). Clears only the state that gates onboarding:
// - accounts: forces a real OAuth reconnect rather than silently reusing the old tokens.
// - pending_setup: restarts the post-connect chain (first-task/briefing/Teams/closing) from
//   its first step instead of resuming mid-way.
// - user_phone_numbers: unbinds every phone this owner had, so resolveOwnerByPhone(phone)
//   returns null again and the next inbound WhatsApp message from it re-enters
//   handlePendingRegistration instead of going straight to normal chat.
// handleAwaitingEmail (whatsappRegistration.ts) is the other half of this: it only lets a typed
// email that already belongs to an account through when that account currently has zero phones
// bound, which is exactly the state this function leaves it in.
export function resetOnboardingConnectionState(ownerId: number): void {
  const reset = db.transaction(() => {
    db.prepare(`DELETE FROM accounts WHERE owner_id = ?`).run(ownerId);
    db.prepare(`DELETE FROM pending_setup WHERE owner_id = ?`).run(ownerId);
    db.prepare(`DELETE FROM user_phone_numbers WHERE user_id = ?`).run(ownerId);
  });
  reset();
}

// Introspects the live schema (rather than a hand-maintained table list) to find every column
// that declares REFERENCES users(id), and reports which of them still hold a row for this owner.
// deleteUserCompletely has needed this exact class of fix three times now (pending_setup/
// pending_actions, document_match_keys, admin_todos/poster_notes) — each time because a new
// owner-scoped table was added elsewhere and this purge wasn't updated to match, and each time
// the only symptom was a bare "FOREIGN KEY constraint failed" with no table name. Call this from
// the catch site around deleteUserCompletely so a future occurrence names the exact table on the
// first failure instead of requiring another guess-and-redeploy cycle.
export function findRemainingOwnerReferences(ownerId: number): string[] {
  const tables = (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as {
      name: string;
    }[]
  ).map((t) => t.name);

  const offenders: string[] = [];
  for (const table of tables) {
    const fks = db.prepare(`PRAGMA foreign_key_list("${table}")`).all() as { table: string; from: string }[];
    for (const fk of fks) {
      if (fk.table !== "users") continue;
      const { c } = db.prepare(`SELECT COUNT(*) AS c FROM "${table}" WHERE "${fk.from}" = ?`).get(ownerId) as {
        c: number;
      };
      if (c > 0) offenders.push(`${table}.${fk.from} (${c} row${c === 1 ? "" : "s"})`);
    }
  }
  return offenders;
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
// Post-connect setup — the chain (first-task check, daily briefing, Teams) run right after OAuth
// connects. ask_first_task is a free-text step that waits for a real reply (skip or otherwise)
// rather than a button tap. See services/postConnectSetup.ts. Briefing content (news/weather/
// markets) is no longer its own step — it defaults on yes and stays adjustable afterward via the
// assistant's set_briefing_preferences tool, and ask_teams is skipped entirely for owners with no
// Microsoft account connected.
// ---------------------------------------------------------------------------

export type PostConnectSetupStep = "ask_name" | "ask_first_task" | "ask_briefing" | "ask_teams";

export function getPendingSetup(ownerId: number): PostConnectSetupStep | null {
  const row = db.prepare(`SELECT step FROM pending_setup WHERE owner_id = ?`).get(ownerId) as
    | { step: PostConnectSetupStep }
    | undefined;
  return row?.step ?? null;
}

function logOnboardingStepEvent(
  ownerId: number,
  step: PostConnectSetupStep,
  event: "reached" | "completed"
): void {
  db.prepare(
    `INSERT INTO onboarding_step_events (owner_id, step, event, created_at) VALUES (?, ?, ?, ?)`
  ).run(ownerId, step, event, Date.now());
}

export function setPendingSetup(ownerId: number, step: PostConnectSetupStep): void {
  db.prepare(
    `INSERT INTO pending_setup (owner_id, step) VALUES (?, ?)
     ON CONFLICT(owner_id) DO UPDATE SET step = excluded.step`
  ).run(ownerId, step);
  logOnboardingStepEvent(ownerId, step, "reached");
}

export function clearPendingSetup(ownerId: number): void {
  const step = getPendingSetup(ownerId);
  db.prepare(`DELETE FROM pending_setup WHERE owner_id = ?`).run(ownerId);
  if (step) logOnboardingStepEvent(ownerId, step, "completed");
}

export interface OnboardingStepEvent {
  step: PostConnectSetupStep;
  event: "reached" | "completed";
  createdAt: number;
}

// Oldest first, so a caller rendering these alongside a WhatsApp conversation can just walk them
// in order — see adminRoutes.ts's conversation viewer.
export function getOnboardingStepEvents(ownerId: number): OnboardingStepEvent[] {
  return db
    .prepare(
      `SELECT step, event, created_at AS createdAt FROM onboarding_step_events
       WHERE owner_id = ? ORDER BY id ASC`
    )
    .all(ownerId) as OnboardingStepEvent[];
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

const SEEN_WAMID_RETENTION_MS = 8 * 24 * 60 * 60 * 1000; // Meta retries for 7 days; +1 day margin.

// Atomically records a wamid as seen and reports whether this is the first time — the same
// check-and-insert `alreadyProcessed` used to do with an in-memory Set, but race-safe across
// concurrent webhook POSTs (INSERT OR IGNORE either inserts or no-ops, never both callers "win")
// and durable across restarts. Returns true (process it) the first time, false (skip — a Meta
// retry) every time after.
export function markWamidSeenIfNew(wamid: string): boolean {
  const result = db
    .prepare(`INSERT OR IGNORE INTO seen_wamids (wamid, seen_at) VALUES (?, ?)`)
    .run(wamid, Date.now());
  return result.changes > 0;
}

// Hygiene only, same shape as deleteExpiredPendingActions — dedupe correctness comes from the
// primary key, not from this. Called once per scheduler tick to keep the table bounded.
export function deleteExpiredSeenWamids(): void {
  db.prepare(`DELETE FROM seen_wamids WHERE seen_at < ?`).run(Date.now() - SEEN_WAMID_RETENTION_MS);
}
