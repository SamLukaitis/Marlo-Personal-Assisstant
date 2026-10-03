import { decryptFor, encryptFor } from "./familyKey.js";
import type { FamilySession } from "./familyDb.js";

// Every read and write of family content. Note what these functions do not take: a family id, an
// owner id, a phone number, or anything else identifying whose data to touch. They take a
// FamilySession, which can only be produced by familyDb.ts from an inbound phone number, and
// they operate on `session.db` — a connection to that one family's file. Passing the "wrong"
// family is not a bug that can be written here, because there is no argument for it.
//
// The result is that the tenant-isolation sweep described in
// feature-to-do/tenant-isolation-audit.md has nothing to check in this file. There is no
// `WHERE family_id = ?` to forget, because every query is already confined to one database.

export interface FamilyMemberRow {
  id: number;
  displayName: string | null;
  isSelf: boolean;
}

/** Everyone in the family, so Joyce can say who's who and address a relay to the right person. */
export function listMembers(session: FamilySession): FamilyMemberRow[] {
  const rows = session.db
    .prepare(`SELECT id, display_name_enc FROM members ORDER BY joined_at ASC`)
    .all() as { id: number; display_name_enc: string | null }[];
  return rows.map((r) => ({
    id: r.id,
    displayName: r.display_name_enc === null ? null : decryptFor(session.key, r.display_name_enc),
    isSelf: r.id === session.actor.id,
  }));
}

export function setMemberName(session: FamilySession, name: string): void {
  session.db
    .prepare(`UPDATE members SET display_name_enc = ? WHERE id = ?`)
    .run(encryptFor(session.key, name), session.actor.id);
}

/**
 * Resolves a name the model produced back to a member id. Exact match on the name first, then a
 * unique case-insensitive match — and nothing further. If two people are both "Sam", this
 * returns "ambiguous" and Joyce asks, rather than picking one: a relay delivered to the wrong
 * family member is exactly the kind of quiet mistake worth an extra question.
 */
export type MemberLookup =
  | { found: true; id: number; displayName: string }
  | { found: false; reason: "unknown" | "ambiguous" };

export function findMemberByName(session: FamilySession, name: string): MemberLookup {
  const wanted = name.trim().toLowerCase();
  const matches = listMembers(session).filter(
    (m) => m.displayName !== null && m.displayName.toLowerCase() === wanted
  );
  if (matches.length === 1) {
    return { found: true, id: matches[0].id, displayName: matches[0].displayName! };
  }
  return { found: false, reason: matches.length === 0 ? "unknown" : "ambiguous" };
}

// --- Conversation log ------------------------------------------------------------------------

export function appendMessage(
  session: FamilySession,
  role: "user" | "assistant",
  body: string
): void {
  session.db
    .prepare(
      `INSERT INTO messages (member_id, role, body_enc, created_at) VALUES (?, ?, ?, ?)`
    )
    // An assistant turn is the family's, not any one member's, so it carries no member_id.
    .run(role === "user" ? session.actor.id : null, role, encryptFor(session.key, body), Date.now());
}

export interface HistoryEntry {
  role: "user" | "assistant";
  body: string;
  senderName: string | null;
  createdAt: number;
}

/**
 * The shared family history, newest `limit` turns, oldest first. Everyone sees everyone's —
 * that's the product. Each user turn carries the sender's name so the model can attribute
 * ("Dad asked about that on Tuesday") instead of treating the family as one voice.
 */
export function recentHistory(session: FamilySession, limit = 40): HistoryEntry[] {
  const rows = session.db
    .prepare(
      `SELECT m.role, m.body_enc, m.created_at, mem.display_name_enc
         FROM messages m LEFT JOIN members mem ON mem.id = m.member_id
        ORDER BY m.id DESC LIMIT ?`
    )
    .all(limit) as {
    role: "user" | "assistant";
    body_enc: string;
    created_at: number;
    display_name_enc: string | null;
  }[];
  return rows
    .map((r) => ({
      role: r.role,
      body: decryptFor(session.key, r.body_enc),
      senderName:
        r.display_name_enc === null ? null : decryptFor(session.key, r.display_name_enc),
      createdAt: r.created_at,
    }))
    .reverse();
}

// --- Notes -----------------------------------------------------------------------------------

export interface NoteRow {
  id: number;
  title: string;
  body: string;
  savedByName: string | null;
  createdAt: number;
}

export function saveNote(session: FamilySession, title: string, body: string): number {
  const res = session.db
    .prepare(
      `INSERT INTO notes (member_id, title_enc, body_enc, created_at) VALUES (?, ?, ?, ?)`
    )
    .run(
      session.actor.id,
      encryptFor(session.key, title),
      encryptFor(session.key, body),
      Date.now()
    );
  return Number(res.lastInsertRowid);
}

function decryptNoteRows(
  session: FamilySession,
  rows: {
    id: number;
    title_enc: string;
    body_enc: string;
    created_at: number;
    display_name_enc: string | null;
  }[]
): NoteRow[] {
  return rows.map((r) => ({
    id: r.id,
    title: decryptFor(session.key, r.title_enc),
    body: decryptFor(session.key, r.body_enc),
    savedByName: r.display_name_enc === null ? null : decryptFor(session.key, r.display_name_enc),
    createdAt: r.created_at,
  }));
}

const NOTE_SELECT = `SELECT n.id, n.title_enc, n.body_enc, n.created_at, mem.display_name_enc
                       FROM notes n JOIN members mem ON mem.id = n.member_id`;

export function listNotes(session: FamilySession, limit = 50): NoteRow[] {
  return decryptNoteRows(
    session,
    session.db.prepare(`${NOTE_SELECT} ORDER BY n.id DESC LIMIT ?`).all(limit) as never
  );
}

/**
 * Substring search over the family's notes, done in memory after decryption. The alternative —
 * a SQL LIKE — is impossible here by design: the columns are ciphertext, so the database cannot
 * read them and neither can anyone holding the file without the key. Families hold tens of
 * notes, not millions, so decrypt-then-filter is the right trade for a long while.
 */
export function searchNotes(session: FamilySession, query: string, limit = 10): NoteRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return listNotes(session, 500)
    .filter(
      (n) => n.title.toLowerCase().includes(needle) || n.body.toLowerCase().includes(needle)
    )
    .slice(0, limit);
}

// --- Documents -------------------------------------------------------------------------------

export interface DocumentRow {
  id: number;
  filename: string | null;
  caption: string | null;
  mimeType: string;
  extractedText: string;
  sentByName: string | null;
  createdAt: number;
}

export function saveDocument(
  session: FamilySession,
  doc: {
    filename?: string;
    caption?: string;
    mimeType: string;
    storedPath: string;
    extractedText: string;
  }
): number {
  const res = session.db
    .prepare(
      `INSERT INTO documents (member_id, filename_enc, caption_enc, mime_type, stored_path, extracted_text_enc, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      session.actor.id,
      doc.filename ? encryptFor(session.key, doc.filename) : null,
      doc.caption ? encryptFor(session.key, doc.caption) : null,
      doc.mimeType,
      doc.storedPath,
      encryptFor(session.key, doc.extractedText),
      Date.now()
    );
  return Number(res.lastInsertRowid);
}

export function listDocuments(session: FamilySession, limit = 50): DocumentRow[] {
  const rows = session.db
    .prepare(
      `SELECT d.id, d.filename_enc, d.caption_enc, d.mime_type, d.extracted_text_enc, d.created_at,
              mem.display_name_enc
         FROM documents d JOIN members mem ON mem.id = d.member_id
        ORDER BY d.id DESC LIMIT ?`
    )
    .all(limit) as {
    id: number;
    filename_enc: string | null;
    caption_enc: string | null;
    mime_type: string;
    extracted_text_enc: string;
    created_at: number;
    display_name_enc: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    filename: r.filename_enc === null ? null : decryptFor(session.key, r.filename_enc),
    caption: r.caption_enc === null ? null : decryptFor(session.key, r.caption_enc),
    mimeType: r.mime_type,
    extractedText: decryptFor(session.key, r.extracted_text_enc),
    sentByName: r.display_name_enc === null ? null : decryptFor(session.key, r.display_name_enc),
    createdAt: r.created_at,
  }));
}

export function searchDocuments(session: FamilySession, query: string, limit = 5): DocumentRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return listDocuments(session, 200)
    .filter(
      (d) =>
        d.extractedText.toLowerCase().includes(needle) ||
        (d.filename?.toLowerCase().includes(needle) ?? false) ||
        (d.caption?.toLowerCase().includes(needle) ?? false)
    )
    .slice(0, limit);
}

// --- Reminders -------------------------------------------------------------------------------

export interface ReminderRow {
  id: number;
  body: string;
  dueAt: number;
  createdByName: string | null;
  targetName: string | null;
  createdAt: number;
}

export function createReminder(
  session: FamilySession,
  body: string,
  dueAt: number,
  targetMemberId: number | null
): number {
  const res = session.db
    .prepare(
      `INSERT INTO reminders (created_by_member_id, target_member_id, body_enc, due_at, created_at)
         VALUES (?, ?, ?, ?, ?)`
    )
    .run(session.actor.id, targetMemberId, encryptFor(session.key, body), dueAt, Date.now());
  return Number(res.lastInsertRowid);
}

const REMINDER_SELECT = `
  SELECT r.id, r.body_enc, r.due_at, r.created_at,
         creator.display_name_enc AS creator_name_enc,
         target.display_name_enc  AS target_name_enc
    FROM reminders r
    JOIN members creator ON creator.id = r.created_by_member_id
    LEFT JOIN members target ON target.id = r.target_member_id`;

function decryptReminderRows(
  session: FamilySession,
  rows: {
    id: number;
    body_enc: string;
    due_at: number;
    created_at: number;
    creator_name_enc: string | null;
    target_name_enc: string | null;
  }[]
): ReminderRow[] {
  return rows.map((r) => ({
    id: r.id,
    body: decryptFor(session.key, r.body_enc),
    dueAt: r.due_at,
    createdByName:
      r.creator_name_enc === null ? null : decryptFor(session.key, r.creator_name_enc),
    targetName: r.target_name_enc === null ? null : decryptFor(session.key, r.target_name_enc),
    createdAt: r.created_at,
  }));
}

export function listUpcomingReminders(session: FamilySession, limit = 20): ReminderRow[] {
  return decryptReminderRows(
    session,
    session.db
      .prepare(`${REMINDER_SELECT} WHERE r.delivered_at IS NULL ORDER BY r.due_at ASC LIMIT ?`)
      .all(limit) as never
  );
}

/**
 * Reminders now due for this member — either addressed to them or to the whole family. Marks
 * them delivered in the same call, so the same reminder can't be shown twice.
 */
export function claimDueReminders(session: FamilySession, now = Date.now()): ReminderRow[] {
  const due = decryptReminderRows(
    session,
    session.db
      .prepare(
        `${REMINDER_SELECT}
          WHERE r.delivered_at IS NULL AND r.due_at <= ?
            AND (r.target_member_id IS NULL OR r.target_member_id = ?)
          ORDER BY r.due_at ASC`
      )
      .all(now, session.actor.id) as never
  );
  if (due.length > 0) {
    const mark = session.db.prepare(`UPDATE reminders SET delivered_at = ? WHERE id = ?`);
    const markAll = session.db.transaction((ids: number[]) => {
      for (const id of ids) mark.run(now, id);
    });
    markAll(due.map((r) => r.id));
  }
  return due;
}

// --- Relays (member-to-member messages) --------------------------------------------------------

export interface RelayRow {
  id: number;
  body: string;
  fromName: string | null;
  createdAt: number;
}

export function queueRelay(session: FamilySession, toMemberId: number, body: string): number {
  const res = session.db
    .prepare(
      `INSERT INTO relays (from_member_id, to_member_id, body_enc, created_at) VALUES (?, ?, ?, ?)`
    )
    .run(session.actor.id, toMemberId, encryptFor(session.key, body), Date.now());
  return Number(res.lastInsertRowid);
}

/**
 * Undelivered messages left for whoever is currently messaging, marked delivered as they're
 * handed over. Pull rather than push: WhatsApp only allows a business to message someone freely
 * within 24 hours of their last message, so a relay waits for the recipient to say something —
 * see the note in joyce/routes.ts.
 */
export function claimRelaysFor(session: FamilySession): RelayRow[] {
  const rows = session.db
    .prepare(
      `SELECT r.id, r.body_enc, r.created_at, sender.display_name_enc
         FROM relays r JOIN members sender ON sender.id = r.from_member_id
        WHERE r.to_member_id = ? AND r.delivered_at IS NULL
        ORDER BY r.id ASC`
    )
    .all(session.actor.id) as {
    id: number;
    body_enc: string;
    created_at: number;
    display_name_enc: string | null;
  }[];
  if (rows.length === 0) return [];

  const now = Date.now();
  const mark = session.db.prepare(`UPDATE relays SET delivered_at = ? WHERE id = ?`);
  const markAll = session.db.transaction((ids: number[]) => {
    for (const id of ids) mark.run(now, id);
  });
  markAll(rows.map((r) => r.id));

  return rows.map((r) => ({
    id: r.id,
    body: decryptFor(session.key, r.body_enc),
    fromName: r.display_name_enc === null ? null : decryptFor(session.key, r.display_name_enc),
    createdAt: r.created_at,
  }));
}
