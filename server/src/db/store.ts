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
}

export function listMemoryNotes(ownerId: number): MemoryNoteRow[] {
  return db
    .prepare(`SELECT id, content, created_at AS createdAt FROM memory_notes WHERE owner_id = ? ORDER BY id DESC`)
    .all(ownerId) as MemoryNoteRow[];
}

// Used when building the assistant's system prompt (unlike listMemoryNotes, which the Setup
// page uses to show the full vault) — caps how many notes get resent as tokens on every single
// call so the prompt doesn't grow forever as the vault accumulates facts over months of use.
export function listRecentMemoryNotes(ownerId: number, limit = 40): MemoryNoteRow[] {
  return db
    .prepare(
      `SELECT id, content, created_at AS createdAt FROM memory_notes WHERE owner_id = ? ORDER BY id DESC LIMIT ?`
    )
    .all(ownerId, limit) as MemoryNoteRow[];
}

export function addMemoryNote(ownerId: number, content: string): MemoryNoteRow {
  const info = db
    .prepare(`INSERT INTO memory_notes (owner_id, content, created_at) VALUES (?, ?, ?)`)
    .run(ownerId, content, Date.now());
  return db
    .prepare(`SELECT id, content, created_at AS createdAt FROM memory_notes WHERE id = ?`)
    .get(info.lastInsertRowid) as MemoryNoteRow;
}

export function removeMemoryNote(ownerId: number, id: number): void {
  db.prepare(`DELETE FROM memory_notes WHERE id = ? AND owner_id = ?`).run(id, ownerId);
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

export interface DocumentRow {
  id: number;
  phone: string;
  filename: string | null;
  mimeType: string;
  storedPath: string;
  caption: string | null;
  extractedText: string;
  createdAt: number;
}

const DOCUMENT_COLUMNS = `id, phone, filename, mime_type AS mimeType, stored_path AS storedPath,
  caption, extracted_text AS extractedText, created_at AS createdAt`;

export function saveDocument(
  ownerId: number,
  doc: {
    phone: string;
    filename: string | null;
    mimeType: string;
    storedPath: string;
    caption: string | null;
    extractedText: string;
  }
): DocumentRow {
  const info = db
    .prepare(
      `INSERT INTO documents (owner_id, phone, filename, mime_type, stored_path, caption, extracted_text, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      ownerId,
      doc.phone,
      doc.filename,
      doc.mimeType,
      doc.storedPath,
      doc.caption,
      doc.extractedText,
      Date.now()
    );
  return db
    .prepare(`SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE id = ?`)
    .get(info.lastInsertRowid) as DocumentRow;
}

export function listDocuments(ownerId: number, limit = 50): DocumentRow[] {
  return db
    .prepare(`SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE owner_id = ? ORDER BY id DESC LIMIT ?`)
    .all(ownerId, limit) as DocumentRow[];
}

export function searchDocuments(ownerId: number, query: string, limit = 10): DocumentRow[] {
  const like = `%${query}%`;
  return db
    .prepare(
      `SELECT ${DOCUMENT_COLUMNS} FROM documents
       WHERE owner_id = ? AND (filename LIKE ? OR caption LIKE ? OR extracted_text LIKE ?)
       ORDER BY id DESC LIMIT ?`
    )
    .all(ownerId, like, like, like, limit) as DocumentRow[];
}

// Scoped by owner — this used to accept any numeric id with no ownership check at all (a live
// IDOR: GET /api/documents/:id/file would serve any document to anyone who guessed an id).
export function getDocument(ownerId: number, id: number): DocumentRow | undefined {
  return db
    .prepare(`SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE id = ? AND owner_id = ?`)
    .get(id, ownerId) as DocumentRow | undefined;
}

export function deleteDocument(ownerId: number, id: number): void {
  db.prepare(`DELETE FROM documents WHERE id = ? AND owner_id = ?`).run(id, ownerId);
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

const CHECKIN_SELECT = `id, latitude, longitude, country, city, checked_in_at AS checkedInAt,
  source, document_id AS documentId`;

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
  const info = db
    .prepare(
      `INSERT INTO travel_checkins (owner_id, latitude, longitude, country, city, checked_in_at, source, document_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      ownerId,
      checkin.latitude ?? null,
      checkin.longitude ?? null,
      checkin.country,
      checkin.city,
      checkin.checkedInAt,
      checkin.source ?? "phone",
      checkin.documentId ?? null
    );
  return db
    .prepare(`SELECT ${CHECKIN_SELECT} FROM travel_checkins WHERE id = ?`)
    .get(info.lastInsertRowid) as TravelCheckinRow;
}

export function listCheckins(ownerId: number, limit = 100): TravelCheckinRow[] {
  return db
    .prepare(
      `SELECT ${CHECKIN_SELECT} FROM travel_checkins WHERE owner_id = ? ORDER BY checked_in_at DESC LIMIT ?`
    )
    .all(ownerId, limit) as TravelCheckinRow[];
}

// Dedup ledger for real-time message alerts: "have we already pinged the user about this
// message" — keyed by "accountId:messageId" since raw message IDs aren't guaranteed unique
// across providers/accounts. Scoped by owner so one tenant's alert volume can't evict another
// tenant's dedup entries out of the bounded 2000-row window.
export function hasAlerted(ownerId: number, key: string): boolean {
  return !!db.prepare(`SELECT 1 FROM alerted_messages WHERE owner_id = ? AND key = ?`).get(ownerId, key);
}

export function markAlerted(ownerId: number, key: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO alerted_messages (owner_id, key, alerted_at) VALUES (?, ?, ?)`
  ).run(ownerId, key, Date.now());
  db.prepare(
    `DELETE FROM alerted_messages WHERE owner_id = ? AND key NOT IN (
       SELECT key FROM alerted_messages WHERE owner_id = ? ORDER BY alerted_at DESC LIMIT 2000
     )`
  ).run(ownerId, ownerId);
}

// Ascending, uncapped — day-counting needs the full timeline, not just the most recent page.
export function listAllCheckinsAscending(ownerId: number): TravelCheckinRow[] {
  return db
    .prepare(`SELECT ${CHECKIN_SELECT} FROM travel_checkins WHERE owner_id = ? ORDER BY checked_in_at ASC`)
    .all(ownerId) as TravelCheckinRow[];
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

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, sliding — refreshed on each use

function hashSessionToken(raw: string): string {
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
    hashSessionToken(raw),
    userId,
    now,
    now + SESSION_TTL_MS
  );
  return raw;
}

export function getUserIdBySessionToken(raw: string): number | null {
  const hash = hashSessionToken(raw);
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
  db.prepare(`DELETE FROM sessions WHERE id = ?`).run(hashSessionToken(raw));
}
