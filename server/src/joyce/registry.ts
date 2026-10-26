import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { newFamilySalt, phoneLookupHash, SALT_LENGTH } from "./familyKey.js";

// The registry is the *only* Joyce database that spans families, and it is deliberately tiny:
// it answers one question ("which family does this phone belong to?") and holds no family
// content whatsoever — no messages, no notes, no documents, no names. Everything a family
// actually says or stores lives in that family's own SQLite file (familyDb.ts).
//
// Even within this file, families are only identifiable by:
//   - an opaque random family_id (never shown to users),
//   - an HMAC of the phone number (so a stolen registry doesn't reveal who is in which family,
//     or any phone numbers at all, without the master secret),
//   - the encryption salt, which is useless on its own — deriving the key also needs
//     JOYCE_MASTER_KEY, which is env-only and never written to disk by this server.
//
// It is also separate from Marlo's app.db on purpose. Joyce has no import of ../db/store.js
// anywhere in this directory, so there is no code path by which a Joyce request can read
// Marlo's tables, and none by which Marlo can read a family's.

export const JOYCE_DIR = path.join(process.env.DATA_DIR ?? path.join(process.cwd(), "data"), "joyce");
const joyceDir = JOYCE_DIR;
if (!fs.existsSync(joyceDir)) fs.mkdirSync(joyceDir, { recursive: true });

export const FAMILY_DB_DIR = path.join(joyceDir, "families");
if (!fs.existsSync(FAMILY_DB_DIR)) fs.mkdirSync(FAMILY_DB_DIR, { recursive: true });

// Photos and files family members send, one subfolder per family — see joyce/files.ts.
export const FAMILY_FILES_DIR = path.join(joyceDir, "files");

const registry = new Database(path.join(joyceDir, "registry.db"));
registry.pragma("foreign_keys = ON");

registry.exec(`
  CREATE TABLE IF NOT EXISTS families (
    family_id TEXT PRIMARY KEY,
    salt BLOB NOT NULL,
    join_code_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );

  -- phone_hash as the PRIMARY KEY is what enforces "each phone number belongs to exactly one
  -- family". It is a database constraint rather than a rule the code has to remember: a second
  -- INSERT for the same number fails loudly instead of quietly moving someone, or worse, leaving
  -- them in two families at once and making "which family is this message for?" ambiguous.
  CREATE TABLE IF NOT EXISTS family_members (
    phone_hash TEXT PRIMARY KEY,
    family_id TEXT NOT NULL REFERENCES families(family_id),
    phone_last4 TEXT NOT NULL,
    joined_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_family_members_family ON family_members(family_id);

  -- Where someone is in the "new family or join one?" conversation, for numbers that have no
  -- family yet. Has to live here rather than in a family database for the obvious reason: at
  -- this point there is no family to put it in. Dropped the moment they land in one.
  CREATE TABLE IF NOT EXISTS onboarding_state (
    phone_hash TEXT PRIMARY KEY,
    step TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- Someone who has asked to leave their family and hasn't yet confirmed. Its own table rather
  -- than a column on family_members so that an expired or abandoned request leaves no trace on
  -- the membership row itself.
  CREATE TABLE IF NOT EXISTS pending_leave (
    phone_hash TEXT PRIMARY KEY,
    requested_at INTEGER NOT NULL
  );

  -- Inbound WhatsApp message ids already handled, so Meta's webhook retries don't replay a
  -- message. Joyce's own copy — sharing Marlo's would be a cross-product dependency.
  CREATE TABLE IF NOT EXISTS seen_wamids (
    wamid TEXT PRIMARY KEY,
    seen_at INTEGER NOT NULL
  );

  -- When each family's next reminder is due, so the reminder sender (reminderDelivery.ts) can
  -- find who has something due without opening every family's file. A time and an opaque id,
  -- nothing else: what the reminder says stays in the family's own encrypted file. A family with
  -- nothing pending has no row.
  CREATE TABLE IF NOT EXISTS reminder_schedule (
    family_id TEXT PRIMARY KEY REFERENCES families(family_id),
    next_due_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_reminder_schedule_due ON reminder_schedule(next_due_at);

  -- A family's calendar subscription link (calendarFeed.ts). Only a hash of the secret in the
  -- link is kept here, the same way join codes are, so a copy of the registry can't be used to
  -- read anyone's calendar.
  CREATE TABLE IF NOT EXISTS calendar_feeds (
    token_hash TEXT PRIMARY KEY,
    family_id TEXT NOT NULL UNIQUE REFERENCES families(family_id)
  );

  -- One-time links for connecting a Google Calendar (joyce/googleRoutes.ts). The browser that
  -- finishes the Google sign-in carries no phone number, so the link stands in for one: it was
  -- minted for this phone_hash, and spending it opens that phone's family exactly as an inbound
  -- message would. Only an HMAC of the token is kept, like join codes.
  CREATE TABLE IF NOT EXISTS google_connect_tokens (
    token_hash TEXT PRIMARY KEY,
    phone_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_google_connect_tokens_phone ON google_connect_tokens(phone_hash);
`);

export type OnboardingStep = "awaiting_choice" | "awaiting_join_code";

// Crockford-style alphabet: no I, L, O, U, so a code read aloud or retyped can't be garbled into
// a different valid code. Two groups of four is short enough to pass along in a text message.
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function randomCodeGroup(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  }
  return out;
}

export function formatJoinCode(raw: string): string {
  return `JOY-${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

/**
 * Accepts whatever a person actually types — "joy-4k7m-2qx9", "JOY 4K7M 2QX9", "4k7m2qx9" — and
 * reduces it to the eight canonical characters, or null if it can't be one of our codes. Strict
 * about the alphabet rather than clever about near-misses: a code that doesn't match is answered
 * with "I don't recognise that one", never with a guess at which family was meant.
 */
export function normalizeJoinCode(input: string): string | null {
  const stripped = input.toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/^JOY/, "");
  if (stripped.length !== 8) return null;
  if (![...stripped].every((c) => CODE_ALPHABET.includes(c))) return null;
  return stripped;
}

function joinCodeHash(canonicalCode: string): string {
  // Same HMAC construction as phone lookup: the plaintext code is never stored, so the registry
  // can verify a code someone sends without holding anything that would let a reader of the file
  // join a family themselves.
  return phoneLookupHash(`joincode:${canonicalCode}`);
}

export interface FamilyRecord {
  familyId: string;
  salt: Buffer;
}

/**
 * Creates a family and puts this phone in it. Returns the join code in plaintext exactly once —
 * it is not recoverable from the registry afterwards, so the caller must send it to the user in
 * this same turn. (`getJoinCodeForMember` re-issues a fresh one if it's lost; see below.)
 */
export function createFamily(normalizedPhone: string): { family: FamilyRecord; joinCode: string } {
  const phoneHash = phoneLookupHash(normalizedPhone);
  const existing = findFamilyForPhone(normalizedPhone);
  if (existing) {
    throw new Error("createFamily: this phone number is already in a family");
  }

  const familyId = crypto.randomUUID();
  const salt = newFamilySalt();
  const now = Date.now();

  // Retry on the astronomically unlikely code collision rather than assuming uniqueness — the
  // UNIQUE index would otherwise throw and lose the whole registration.
  let canonicalCode = "";
  const insertFamily = registry.prepare(
    `INSERT INTO families (family_id, salt, join_code_hash, created_at) VALUES (?, ?, ?, ?)`
  );
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = randomCodeGroup(8);
    try {
      insertFamily.run(familyId, salt, joinCodeHash(candidate), now);
      canonicalCode = candidate;
      break;
    } catch (err) {
      if (attempt === 9) throw err;
    }
  }

  registry
    .prepare(
      `INSERT INTO family_members (phone_hash, family_id, phone_last4, joined_at) VALUES (?, ?, ?, ?)`
    )
    .run(phoneHash, familyId, normalizedPhone.slice(-4), now);
  clearOnboardingState(normalizedPhone);

  return { family: { familyId, salt }, joinCode: formatJoinCode(canonicalCode) };
}

/** The family this number belongs to, or null if it belongs to none. */
export function findFamilyForPhone(normalizedPhone: string): FamilyRecord | null {
  return findFamilyForPhoneHash(phoneLookupHash(normalizedPhone));
}

/**
 * Same as findFamilyForPhone, for the one caller that holds a phone hash rather than a number:
 * opening a family from a spent Google connect link (familyDb.ts). The hash only ever comes from
 * a row this registry wrote itself, never from a request.
 */
export function findFamilyForPhoneHash(phoneHash: string): FamilyRecord | null {
  const row = registry
    .prepare(
      `SELECT f.family_id AS familyId, f.salt AS salt
         FROM family_members m JOIN families f ON f.family_id = m.family_id
        WHERE m.phone_hash = ?`
    )
    .get(phoneHash) as { familyId: string; salt: Buffer } | undefined;
  if (!row) return null;
  if (row.salt.length !== SALT_LENGTH) {
    throw new Error(`registry: family ${row.familyId} has a malformed salt — refusing to derive a key`);
  }
  return { familyId: row.familyId, salt: row.salt };
}

export type JoinOutcome =
  | { ok: true; family: FamilyRecord }
  | { ok: false; reason: "unknown_code" | "already_in_a_family" };

/**
 * Puts a phone into an existing family by join code. The "already in a family" check is a
 * courtesy so Joyce can explain herself — the PRIMARY KEY on family_members is what actually
 * guarantees it, and would reject the insert regardless.
 */
export function joinFamilyByCode(normalizedPhone: string, rawCode: string): JoinOutcome {
  if (findFamilyForPhone(normalizedPhone)) return { ok: false, reason: "already_in_a_family" };

  const canonical = normalizeJoinCode(rawCode);
  if (!canonical) return { ok: false, reason: "unknown_code" };

  const row = registry
    .prepare(`SELECT family_id AS familyId, salt FROM families WHERE join_code_hash = ?`)
    .get(joinCodeHash(canonical)) as { familyId: string; salt: Buffer } | undefined;
  if (!row) return { ok: false, reason: "unknown_code" };

  registry
    .prepare(
      `INSERT INTO family_members (phone_hash, family_id, phone_last4, joined_at) VALUES (?, ?, ?, ?)`
    )
    .run(phoneLookupHash(normalizedPhone), row.familyId, normalizedPhone.slice(-4), Date.now());
  clearOnboardingState(normalizedPhone);

  return { ok: true, family: { familyId: row.familyId, salt: row.salt } };
}

/**
 * Issues a *new* join code for the caller's family and invalidates the old one. This is both the
 * "I've lost the code" path and the only revocation mechanism there is: a code is permanent and
 * reusable until it's rotated, so anyone who was ever forwarded one can join until someone does
 * this. Only a member of the family can call it — the caller's own phone selects the family, so
 * there is no parameter through which another family could be named.
 */
export function rotateJoinCode(normalizedPhone: string): string | null {
  const family = findFamilyForPhone(normalizedPhone);
  if (!family) return null;
  const update = registry.prepare(`UPDATE families SET join_code_hash = ? WHERE family_id = ?`);
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = randomCodeGroup(8);
    try {
      update.run(joinCodeHash(candidate), family.familyId);
      return formatJoinCode(candidate);
    } catch (err) {
      if (attempt === 9) throw err;
    }
  }
  return null;
}

/** How many phones are in this family — used for "you're the first one here" style copy. */
export function countFamilyMembers(familyId: string): number {
  const row = registry
    .prepare(`SELECT COUNT(*) AS n FROM family_members WHERE family_id = ?`)
    .get(familyId) as { n: number };
  return row.n;
}

export function getOnboardingState(normalizedPhone: string): OnboardingStep | null {
  const row = registry
    .prepare(`SELECT step FROM onboarding_state WHERE phone_hash = ?`)
    .get(phoneLookupHash(normalizedPhone)) as { step: OnboardingStep } | undefined;
  return row?.step ?? null;
}

export function setOnboardingState(normalizedPhone: string, step: OnboardingStep): void {
  registry
    .prepare(
      `INSERT INTO onboarding_state (phone_hash, step, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(phone_hash) DO UPDATE SET step = excluded.step, updated_at = excluded.updated_at`
    )
    .run(phoneLookupHash(normalizedPhone), step, Date.now());
}

export function clearOnboardingState(normalizedPhone: string): void {
  registry
    .prepare(`DELETE FROM onboarding_state WHERE phone_hash = ?`)
    .run(phoneLookupHash(normalizedPhone));
}

// A leave request that nobody confirmed goes stale. Ten minutes is long enough to read the
// warning and think about it, short enough that "confirm cancel" typed next week — in some
// completely unrelated conversation — can't act on a request they've long forgotten making.
const LEAVE_REQUEST_TTL_MS = 10 * 60 * 1000;

/** Arms the confirmation step. Does not itself remove anyone from anything. */
export function requestLeave(normalizedPhone: string): void {
  registry
    .prepare(
      `INSERT INTO pending_leave (phone_hash, requested_at) VALUES (?, ?)
         ON CONFLICT(phone_hash) DO UPDATE SET requested_at = excluded.requested_at`
    )
    .run(phoneLookupHash(normalizedPhone), Date.now());
}

/**
 * True if this number has a live leave request, clearing it either way — so a request is spent
 * by the very next message whatever that message says, and can never sit around waiting to be
 * triggered later.
 */
export function consumePendingLeave(normalizedPhone: string): boolean {
  const phoneHash = phoneLookupHash(normalizedPhone);
  const row = registry
    .prepare(`SELECT requested_at AS requestedAt FROM pending_leave WHERE phone_hash = ?`)
    .get(phoneHash) as { requestedAt: number } | undefined;
  if (!row) return false;
  registry.prepare(`DELETE FROM pending_leave WHERE phone_hash = ?`).run(phoneHash);
  return Date.now() - row.requestedAt <= LEAVE_REQUEST_TTL_MS;
}

/**
 * Removes this phone from its family. Returns false if it wasn't in one.
 *
 * What it deliberately does *not* do is delete anything the person contributed. Their notes,
 * documents and messages stay with the family, and their member row stays in the family database
 * so existing attributions ("saved by Sam") keep working instead of turning into blanks. What
 * they lose is access: with no registry row, resolveFamilyForPhone returns null and there is no
 * longer any path from their number to that family's file.
 *
 * The family itself survives even if the last member leaves, join code and all, so a family that
 * empties out can still be rejoined by anyone who kept the code.
 */
export function leaveFamily(normalizedPhone: string): boolean {
  const res = registry
    .prepare(`DELETE FROM family_members WHERE phone_hash = ?`)
    .run(phoneLookupHash(normalizedPhone));
  return res.changes > 0;
}

// Long enough to tap the link and get through Google's screens, short enough that a link found
// later in a forwarded chat or a phone's history is dead. Same window as Marlo's connect links.
export const GOOGLE_CONNECT_TOKEN_TTL_MS = 10 * 60 * 1000;

function googleConnectTokenHash(token: string): string {
  return phoneLookupHash(`googleconnect:${token}`);
}

/**
 * A fresh connect link token for this phone, replacing any earlier one so only the latest link a
 * person was sent works. Returned in plaintext once; only its HMAC is stored.
 */
export function issueGoogleConnectToken(normalizedPhone: string): string {
  const phoneHash = phoneLookupHash(normalizedPhone);
  const token = crypto.randomBytes(24).toString("base64url");
  registry.transaction(() => {
    registry.prepare(`DELETE FROM google_connect_tokens WHERE phone_hash = ?`).run(phoneHash);
    registry
      .prepare(`INSERT INTO google_connect_tokens (token_hash, phone_hash, created_at) VALUES (?, ?, ?)`)
      .run(googleConnectTokenHash(token), phoneHash, Date.now());
  })();
  return token;
}

/** Checks a token without spending it, so the link can be validated before sending anyone to Google. */
export function isGoogleConnectTokenLive(token: string): boolean {
  const row = registry
    .prepare(`SELECT created_at AS createdAt FROM google_connect_tokens WHERE token_hash = ?`)
    .get(googleConnectTokenHash(token)) as { createdAt: number } | undefined;
  return !!row && Date.now() - row.createdAt <= GOOGLE_CONNECT_TOKEN_TTL_MS;
}

/**
 * Spends a token, returning the phone hash it was minted for, or null if it's unknown or
 * expired. Deleted either way, so a link works once. Callers want familyDb.ts's
 * openFamilySessionForGoogleConnect, not this.
 */
export function consumeGoogleConnectToken(token: string): string | null {
  const tokenHash = googleConnectTokenHash(token);
  const row = registry
    .prepare(`SELECT phone_hash AS phoneHash, created_at AS createdAt FROM google_connect_tokens WHERE token_hash = ?`)
    .get(tokenHash) as { phoneHash: string; createdAt: number } | undefined;
  if (!row) return null;
  registry.prepare(`DELETE FROM google_connect_tokens WHERE token_hash = ?`).run(tokenHash);
  return Date.now() - row.createdAt <= GOOGLE_CONNECT_TOKEN_TTL_MS ? row.phoneHash : null;
}

/** False if this wamid was already handled — the dedupe guard for Meta's webhook retries. */
export function markJoyceWamidSeenIfNew(wamid: string): boolean {
  const res = registry
    .prepare(`INSERT OR IGNORE INTO seen_wamids (wamid, seen_at) VALUES (?, ?)`)
    .run(wamid, Date.now());
  return res.changes > 0;
}

/** Test-only escape hatch so a suite can assert against registry internals. */
export function __registryForTests(): Database.Database {
  return registry;
}

// --- Reminder schedule ---------------------------------------------------------------------------
// Written from inside a family (familyDb.ts's syncReminderSchedule, after any reminder change) and
// read only by the reminder sender. Neither is reachable from an AI tool or an inbound request.

export function setReminderScheduleEntry(familyId: string, nextDueAt: number | null): void {
  if (nextDueAt === null) {
    registry.prepare(`DELETE FROM reminder_schedule WHERE family_id = ?`).run(familyId);
    return;
  }
  registry
    .prepare(
      `INSERT INTO reminder_schedule (family_id, next_due_at) VALUES (?, ?)
       ON CONFLICT(family_id) DO UPDATE SET next_due_at = excluded.next_due_at`
    )
    .run(familyId, nextDueAt);
}

/** Families with a reminder due by `now`, for the reminder sender only. */
export function familiesWithRemindersDue(now: number): FamilyRecord[] {
  return registry
    .prepare(
      `SELECT f.family_id AS familyId, f.salt AS salt
         FROM reminder_schedule s JOIN families f ON f.family_id = s.family_id
        WHERE s.next_due_at <= ?`
    )
    .all(now) as FamilyRecord[];
}

// --- Calendar subscription links -----------------------------------------------------------------

function calendarTokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Makes a new calendar link secret for the caller's own family, replacing any earlier one so the
 * old link stops working. Like rotateJoinCode, the family comes from the caller's phone.
 */
export function issueCalendarToken(normalizedPhone: string): string | null {
  const family = findFamilyForPhone(normalizedPhone);
  if (!family) return null;
  const token = crypto.randomBytes(24).toString("base64url");
  const replace = registry.transaction(() => {
    registry.prepare(`DELETE FROM calendar_feeds WHERE family_id = ?`).run(family.familyId);
    registry
      .prepare(`INSERT INTO calendar_feeds (token_hash, family_id) VALUES (?, ?)`)
      .run(calendarTokenHash(token), family.familyId);
  });
  replace();
  return token;
}

/** The family a calendar link belongs to, or null for an unknown or replaced link. */
export function findFamilyForCalendarToken(token: string): FamilyRecord | null {
  const row = registry
    .prepare(
      `SELECT f.family_id AS familyId, f.salt AS salt
         FROM calendar_feeds c JOIN families f ON f.family_id = c.family_id
        WHERE c.token_hash = ?`
    )
    .get(calendarTokenHash(token)) as FamilyRecord | undefined;
  return row ?? null;
}
