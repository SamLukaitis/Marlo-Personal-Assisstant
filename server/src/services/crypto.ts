import crypto from "node:crypto";

// Field-level encryption for the two categories of sensitive data at rest: OAuth tokens
// (accounts.access_token / refresh_token — these alone grant live access to someone's email,
// calendar, and files) and uploaded documents (passports, boarding passes, tickets — whatever
// a user photographs and sends over WhatsApp). Everything else in the DB (message text, memory
// notes, check-ins) stays plaintext for now — see README "Data is not encrypted at rest" for
// what's covered and what isn't.
//
// AES-256-GCM: authenticated encryption, so a tampered ciphertext fails to decrypt rather than
// silently returning garbage. Key comes only from the ENCRYPTION_KEY env var — never stored in
// the DB itself, which is the whole point (DB theft alone doesn't expose the plaintext).

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // recommended for GCM

function loadKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "ENCRYPTION_KEY is not set. Generate one with `openssl rand -hex 32` (or " +
        "`node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"`) " +
        "and set it as an env var. Losing this key makes all encrypted data permanently " +
        "unreadable — back it up somewhere safe outside the server itself."
    );
  }
  const key = Buffer.from(raw, "hex");
  if (key.length !== 32) {
    throw new Error(
      `ENCRYPTION_KEY must decode to exactly 32 bytes (64 hex characters) for AES-256; got ${key.length} bytes.`
    );
  }
  return key;
}

// Lazy + cached: fails loudly the first time something actually needs to encrypt/decrypt,
// rather than crashing every process at import time (e.g. scripts that never touch tokens/files).
let cachedKey: Buffer | null = null;
function key(): Buffer {
  if (!cachedKey) cachedKey = loadKey();
  return cachedKey;
}

export function isEncryptionConfigured(): boolean {
  return !!process.env.ENCRYPTION_KEY;
}

/** Encrypts a UTF-8 string. Returns "iv:authTag:ciphertext", all base64. Null passes through. */
export function encryptField(plaintext: string): string;
export function encryptField(plaintext: null): null;
export function encryptField(plaintext: string | null): string | null;
export function encryptField(plaintext: string | null): string | null {
  if (plaintext === null) return null;
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${authTag.toString("base64")}:${ciphertext.toString("base64")}`;
}

/** Reverses encryptField. Null passes through; throws if the value isn't valid ciphertext. */
export function decryptField(ciphertext: string): string;
export function decryptField(ciphertext: null): null;
export function decryptField(ciphertext: string | null): string | null {
  if (ciphertext === null) return null;
  const parts = ciphertext.split(":");
  if (parts.length !== 3) {
    throw new Error("decryptField: value is not in the expected iv:authTag:ciphertext format");
  }
  const [ivB64, authTagB64, dataB64] = parts;
  const decipher = crypto.createDecipheriv(ALGORITHM, key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(authTagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** Encrypts raw bytes (uploaded files). Layout: [12-byte iv][16-byte authTag][ciphertext]. */
export function encryptBuffer(plaintext: Buffer): Buffer {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptBuffer(data: Buffer): Buffer {
  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(IV_LENGTH, IV_LENGTH + 16);
  const ciphertext = data.subarray(IV_LENGTH + 16);
  const decipher = crypto.createDecipheriv(ALGORITHM, key(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
