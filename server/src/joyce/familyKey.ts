import crypto from "node:crypto";

// Joyce's cryptographic core. Every family gets its own AES-256 key, and that key is *derived*
// on demand rather than stored anywhere — not in the registry, not in the family's own database,
// not in any message. Two inputs produce it: the server-wide master secret (JOYCE_MASTER_KEY,
// env only) and a 32-byte random salt generated once when the family is created.
//
// Why this exists at all, given the per-family database files in familyDb.ts already keep
// families in separate SQLite files: the two barriers fail differently, which is the point.
// A wrong file gives you no rows. A wrong key gives you an exception. AES-GCM is *authenticated*
// encryption — the auth tag is verified before any plaintext is returned, so feeding family A's
// ciphertext to family B's key throws rather than producing readable data (or, worse, plausible
// garbage). There is no combination of bugs that quietly hands one family another's content:
// either the data isn't there, or decrypting it crashes.
//
// The master secret alone is not enough to read anything — you also need the family's salt, which
// lives in the registry, and the family's database file. Losing JOYCE_MASTER_KEY makes every
// family's data permanently unreadable, exactly like ENCRYPTION_KEY does for Marlowe.

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96 bits, the recommended size for GCM
const KEY_LENGTH = 32; // AES-256
export const SALT_LENGTH = 32;

// Bumping this re-derives every family key and orphans all existing ciphertext, so it changes
// only alongside a deliberate migration. It's in the HKDF `info` parameter so that a future
// version can derive a *different* key from the same master secret and salt.
const KEY_INFO_VERSION = "joyce-family-v1";

function masterSecret(): Buffer {
  const raw = process.env.JOYCE_MASTER_KEY;
  if (!raw) {
    throw new Error(
      "JOYCE_MASTER_KEY is not set. Generate one with `openssl rand -hex 32` and set it as an " +
        "env var. It is the root of every family's encryption key — losing it makes all Joyce " +
        "family data permanently unreadable, so back it up somewhere outside the server. It must " +
        "be different from Marlowe's ENCRYPTION_KEY."
    );
  }
  const key = Buffer.from(raw, "hex");
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `JOYCE_MASTER_KEY must decode to exactly 32 bytes (64 hex characters); got ${key.length} bytes.`
    );
  }
  return key;
}

export function isJoyceConfigured(): boolean {
  return !!process.env.JOYCE_MASTER_KEY;
}

export function newFamilySalt(): Buffer {
  return crypto.randomBytes(SALT_LENGTH);
}

/**
 * The per-family AES key. Deterministic given the same three inputs, so it never needs storing;
 * `familyId` is mixed in alongside the salt so that two families can't collide onto one key even
 * if a salt were ever reused by accident.
 */
export function deriveFamilyKey(familyId: string, salt: Buffer): Buffer {
  const info = Buffer.from(`${KEY_INFO_VERSION}:${familyId}`, "utf8");
  return Buffer.from(crypto.hkdfSync("sha256", masterSecret(), salt, info, KEY_LENGTH));
}

/**
 * Digits only. Joyce defines her own rather than importing Marlowe's identical helper from
 * ../db/store.js — importing that module would open Marlowe's app.db as a side effect, and the
 * whole point of this directory is that no Joyce code path can reach it.
 */
export function normalizeJoycePhone(phone: string): string {
  return phone.replace(/[^0-9]/g, "");
}

/**
 * Looks up a phone number without storing it. The registry (the one table that spans families)
 * holds only this HMAC, so a dump of it reveals neither who is in which family nor any phone
 * number — matching a number requires the master secret and the number you're testing.
 */
export function phoneLookupHash(normalizedPhone: string): string {
  return crypto.createHmac("sha256", masterSecret()).update(normalizedPhone).digest("hex");
}

/** Encrypts a UTF-8 string under a family key. Returns "iv:authTag:ciphertext", all base64. */
export function encryptFor(key: Buffer, plaintext: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

/**
 * Reverses encryptFor. Throws on a wrong key, a tampered value, or a malformed one — never
 * returns partial or garbage plaintext. That throw is the second isolation barrier doing its job,
 * so callers must not swallow it: a decrypt failure means something is wired up wrong, and the
 * only safe response is to stop.
 */
export function decryptFor(key: Buffer, value: string): string {
  const parts = value.split(":");
  if (parts.length !== 3) {
    throw new Error("decryptFor: value is not in the expected iv:authTag:ciphertext format");
  }
  const [ivB64, tagB64, dataB64] = parts;
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** Encrypts raw bytes (uploaded files). Layout: [12-byte iv][16-byte authTag][ciphertext]. */
export function encryptBufferFor(key: Buffer, plaintext: Buffer): Buffer {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptBufferFor(key: Buffer, data: Buffer): Buffer {
  const decipher = crypto.createDecipheriv(ALGORITHM, key, data.subarray(0, IV_LENGTH));
  decipher.setAuthTag(data.subarray(IV_LENGTH, IV_LENGTH + 16));
  return Buffer.concat([
    decipher.update(data.subarray(IV_LENGTH + 16)),
    decipher.final(),
  ]);
}
