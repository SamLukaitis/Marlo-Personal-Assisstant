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
`);

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
