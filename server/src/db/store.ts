import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const dataDir = path.join(process.cwd(), "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, "app.db"));

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
`);

export const uploadsDir = path.join(dataDir, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

export type Provider = "google" | "microsoft" | "local";

export interface AccountRow {
  id: number;
  provider: Provider;
  email: string;
  accessToken: string | null;
  refreshToken: string | null;
  expiryDate: number | null;
}

const rowSelect = `id, provider, email, access_token AS accessToken,
                   refresh_token AS refreshToken, expiry_date AS expiryDate`;

export function upsertAccount(account: {
  provider: Provider;
  email: string;
  accessToken: string | null;
  refreshToken: string | null;
  expiryDate: number | null;
}): AccountRow {
  db.prepare(
    `INSERT INTO accounts (provider, email, access_token, refresh_token, expiry_date)
     VALUES (@provider, @email, @accessToken, @refreshToken, @expiryDate)
     ON CONFLICT(provider, email) DO UPDATE SET
       access_token = excluded.access_token,
       refresh_token = COALESCE(excluded.refresh_token, accounts.refresh_token),
       expiry_date = excluded.expiry_date`
  ).run(account);

  return db
    .prepare(`SELECT ${rowSelect} FROM accounts WHERE provider = ? AND email = ?`)
    .get(account.provider, account.email) as AccountRow;
}

export function updateAccountTokens(
  id: number,
  tokens: { accessToken: string | null; refreshToken?: string | null; expiryDate: number | null }
): void {
  db.prepare(
    `UPDATE accounts SET
       access_token = @accessToken,
       refresh_token = COALESCE(@refreshToken, refresh_token),
       expiry_date = @expiryDate
     WHERE id = @id`
  ).run({ id, refreshToken: null, ...tokens });
}

export function listAccounts(provider?: Provider): AccountRow[] {
  if (provider) {
    return db
      .prepare(`SELECT ${rowSelect} FROM accounts WHERE provider = ?`)
      .all(provider) as AccountRow[];
  }
  return db.prepare(`SELECT ${rowSelect} FROM accounts`).all() as AccountRow[];
}

export function getAccount(id: number): AccountRow | null {
  const row = db.prepare(`SELECT ${rowSelect} FROM accounts WHERE id = ?`).get(id) as
    | AccountRow
    | undefined;
  return row ?? null;
}

export function deleteAccount(id: number): void {
  db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
}

export function getSetting(key: string): string | null {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

export interface LocalRootRow {
  id: number;
  path: string;
  label: string | null;
}

export function listLocalRoots(): LocalRootRow[] {
  return db.prepare(`SELECT id, path, label FROM local_roots`).all() as LocalRootRow[];
}

export function addLocalRoot(rootPath: string, label?: string): LocalRootRow {
  const info = db
    .prepare(`INSERT INTO local_roots (path, label) VALUES (?, ?)`)
    .run(rootPath, label ?? null);
  return db
    .prepare(`SELECT id, path, label FROM local_roots WHERE id = ?`)
    .get(info.lastInsertRowid) as LocalRootRow;
}

export function removeLocalRoot(id: number): void {
  db.prepare(`DELETE FROM local_roots WHERE id = ?`).run(id);
}

export interface BriefingRow {
  date: string;
  content: string;
  createdAt: number;
}

export function getBriefing(date: string): BriefingRow | null {
  const row = db
    .prepare(`SELECT date, content, created_at AS createdAt FROM briefings WHERE date = ?`)
    .get(date) as BriefingRow | undefined;
  return row ?? null;
}

export function saveBriefing(date: string, content: string): BriefingRow {
  db.prepare(
    `INSERT INTO briefings (date, content, created_at) VALUES (?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET content = excluded.content, created_at = excluded.created_at`
  ).run(date, content, Date.now());
  return getBriefing(date)!;
}

export interface MemoryNoteRow {
  id: number;
  content: string;
  createdAt: number;
}

export function listMemoryNotes(): MemoryNoteRow[] {
  return db
    .prepare(`SELECT id, content, created_at AS createdAt FROM memory_notes ORDER BY id DESC`)
    .all() as MemoryNoteRow[];
}

// Used when building the assistant's system prompt (unlike listMemoryNotes, which the Setup
// page uses to show the full vault) — caps how many notes get resent as tokens on every single
// call so the prompt doesn't grow forever as the vault accumulates facts over months of use.
export function listRecentMemoryNotes(limit = 40): MemoryNoteRow[] {
  return db
    .prepare(
      `SELECT id, content, created_at AS createdAt FROM memory_notes ORDER BY id DESC LIMIT ?`
    )
    .all(limit) as MemoryNoteRow[];
}

export function addMemoryNote(content: string): MemoryNoteRow {
  const info = db
    .prepare(`INSERT INTO memory_notes (content, created_at) VALUES (?, ?)`)
    .run(content, Date.now());
  return db
    .prepare(`SELECT id, content, created_at AS createdAt FROM memory_notes WHERE id = ?`)
    .get(info.lastInsertRowid) as MemoryNoteRow;
}

export function removeMemoryNote(id: number): void {
  db.prepare(`DELETE FROM memory_notes WHERE id = ?`).run(id);
}

export interface WhatsAppMessageRow {
  id: number;
  phone: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
}

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
  phone: string,
  role: "user" | "assistant",
  content: string
): void {
  db.prepare(
    `INSERT INTO whatsapp_messages (phone, role, content, created_at) VALUES (?, ?, ?, ?)`
  ).run(phone, role, content, Date.now());
}

function normalizePhone(phone: string): string {
  return phone.replace(/[^0-9]/g, "");
}

export function getWhatsAppAllowedNumbers(): string[] {
  const raw = getSetting("whatsapp_allowed_numbers");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function setWhatsAppAllowedNumbers(numbers: string[]): void {
  setSetting("whatsapp_allowed_numbers", JSON.stringify(numbers.map(normalizePhone)));
}

export function isWhatsAppNumberAllowed(phone: string): boolean {
  const normalized = normalizePhone(phone);
  return getWhatsAppAllowedNumbers().includes(normalized);
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

export function saveDocument(doc: {
  phone: string;
  filename: string | null;
  mimeType: string;
  storedPath: string;
  caption: string | null;
  extractedText: string;
}): DocumentRow {
  const info = db
    .prepare(
      `INSERT INTO documents (phone, filename, mime_type, stored_path, caption, extracted_text, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
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

export function listDocuments(limit = 50): DocumentRow[] {
  return db
    .prepare(`SELECT ${DOCUMENT_COLUMNS} FROM documents ORDER BY id DESC LIMIT ?`)
    .all(limit) as DocumentRow[];
}

export function searchDocuments(query: string, limit = 10): DocumentRow[] {
  const like = `%${query}%`;
  return db
    .prepare(
      `SELECT ${DOCUMENT_COLUMNS} FROM documents
       WHERE filename LIKE ? OR caption LIKE ? OR extracted_text LIKE ?
       ORDER BY id DESC LIMIT ?`
    )
    .all(like, like, like, limit) as DocumentRow[];
}

export function getDocument(id: number): DocumentRow | undefined {
  return db.prepare(`SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE id = ?`).get(id) as
    | DocumentRow
    | undefined;
}

export function deleteDocument(id: number): void {
  db.prepare(`DELETE FROM documents WHERE id = ?`).run(id);
}

export interface TravelCheckinRow {
  id: number;
  latitude: number;
  longitude: number;
  country: string | null;
  city: string | null;
  checkedInAt: number;
}

export function saveCheckin(checkin: {
  latitude: number;
  longitude: number;
  country: string | null;
  city: string | null;
  checkedInAt: number;
}): TravelCheckinRow {
  const info = db
    .prepare(
      `INSERT INTO travel_checkins (latitude, longitude, country, city, checked_in_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(checkin.latitude, checkin.longitude, checkin.country, checkin.city, checkin.checkedInAt);
  return db
    .prepare(
      `SELECT id, latitude, longitude, country, city, checked_in_at AS checkedInAt
       FROM travel_checkins WHERE id = ?`
    )
    .get(info.lastInsertRowid) as TravelCheckinRow;
}

export function listCheckins(limit = 100): TravelCheckinRow[] {
  return db
    .prepare(
      `SELECT id, latitude, longitude, country, city, checked_in_at AS checkedInAt
       FROM travel_checkins ORDER BY checked_in_at DESC LIMIT ?`
    )
    .all(limit) as TravelCheckinRow[];
}
