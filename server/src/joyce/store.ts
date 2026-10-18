import { decryptFor, encryptFor } from "./familyKey.js";
import { syncReminderSchedule, type FamilyData, type FamilySession } from "./familyDb.js";

// Every read and write of family content. Note what these functions do not take: a family id, an
// owner id, a phone number, or anything else identifying whose data to touch. They take a
// FamilySession, which can only be produced by familyDb.ts from an inbound phone number, and
// they operate on `session.db` — a connection to that one family's file. Passing the "wrong"
// family is not a bug that can be written here, because there is no argument for it.
//
// The result is that the tenant-isolation sweep described in
// feature-to-do/tenant-isolation-audit.md has nothing to check in this file. There is no
// `WHERE family_id = ?` to forget, because every query is already confined to one database.

// --- The family's current join code --------------------------------------------------------------
//
// The registry holds only a hash of the join code (registry.ts), so a copy of the registry can't
// be used to join anyone's family. This keeps the code itself too, encrypted under the family's
// own key like everything else in this file, so a member can ask Joyce what it is. Written
// whenever the code is created, rotated, or used successfully to join — the last of those is
// what fills it in for families created before it was stored.

const JOIN_CODE_KEY = "join_code_enc";

export function setFamilyJoinCode(session: FamilySession, joinCode: string): void {
  session.db
    .prepare(
      `INSERT INTO family_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(JOIN_CODE_KEY, encryptFor(session.key, joinCode));
}

/** The family's current join code, or null if it hasn't been stored since it was last issued. */
export function getFamilyJoinCode(session: FamilySession): string | null {
  const row = session.db
    .prepare(`SELECT value FROM family_meta WHERE key = ?`)
    .get(JOIN_CODE_KEY) as { value: string } | undefined;
  return row ? decryptFor(session.key, row.value) : null;
}

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

/**
 * A message in the acting member's own conversation with Joyce — theirs, or her reply to them.
 * `wamid` is the member's WhatsApp message id, kept so a swipe-reply to it can find it. Returns
 * the message's id.
 */
export function appendMessage(
  session: FamilySession,
  role: "user" | "assistant",
  body: string,
  wamid?: string
): number {
  const res = session.db
    .prepare(
      `INSERT INTO messages (member_id, thread_member_id, role, body_enc, created_at, wamid)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    // Joyce's own messages have no sender member, but belong to the thread of whoever she's talking to.
    .run(
      role === "user" ? session.actor.id : null,
      session.actor.id,
      role,
      encryptFor(session.key, body),
      Date.now(),
      wamid ?? null
    );
  return Number(res.lastInsertRowid);
}

export interface StoredMessage {
  id: number;
  role: "user" | "assistant";
  /** Who sent it; null for Joyce's own messages. */
  memberId: number | null;
  body: string;
  createdAt: number;
}

function storedMessage(session: FamilySession, where: string, value: string | number): StoredMessage | null {
  const row = session.db
    .prepare(`SELECT id, role, member_id, body_enc, created_at FROM messages WHERE ${where} = ?`)
    .get(value) as
    | { id: number; role: "user" | "assistant"; member_id: number | null; body_enc: string; created_at: number }
    | undefined;
  return row
    ? {
        id: row.id,
        role: row.role,
        memberId: row.member_id,
        body: decryptFor(session.key, row.body_enc),
        createdAt: row.created_at,
      }
    : null;
}

/** The family's message with this WhatsApp id — what a swipe-reply points at. */
export function getMessageByWamid(session: FamilySession, wamid: string): StoredMessage | null {
  return storedMessage(session, "wamid", wamid);
}

export function getMessage(session: FamilySession, id: number): StoredMessage | null {
  return storedMessage(session, "id", id);
}

/**
 * Something Joyce sent a member without being asked (a reminder), kept in that member's
 * conversation like any reply of hers, so she can see later that she sent it.
 */
export function appendSentMessage(family: FamilyData, memberId: number, body: string): number {
  const res = family.db
    .prepare(
      `INSERT INTO messages (member_id, thread_member_id, role, body_enc, created_at)
       VALUES (NULL, ?, 'assistant', ?, ?)`
    )
    .run(memberId, encryptFor(family.key, body), Date.now());
  return Number(res.lastInsertRowid);
}

export interface HistoryEntry {
  role: "user" | "assistant";
  body: string;
  senderName: string | null;
  createdAt: number;
}

/**
 * The acting member's own conversation with Joyce, newest `limit` messages, oldest first. Only
 * theirs: another member's messages never appear here, so a short reply like "yes" can only be
 * read against what Joyce said to this person. Other members' conversations are reachable on
 * purpose through searchFamilyChat.
 */
export function recentHistory(session: FamilySession, limit = 40): HistoryEntry[] {
  const rows = session.db
    .prepare(
      `SELECT m.role, m.body_enc, m.created_at, mem.display_name_enc
         FROM messages m LEFT JOIN members mem ON mem.id = m.member_id
        WHERE m.thread_member_id = ?
        ORDER BY m.id DESC LIMIT ?`
    )
    .all(session.actor.id, limit) as {
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
/**
 * Ranks items by how many of the query's words they contain, most first, keeping only those with
 * at least one. Whole-phrase matching was too strict: the model searches in its own words
 * ("Leo trip payment"), which rarely appear verbatim in what a family member saved. Ties keep the
 * input order, which is newest first. Words under three letters are skipped as noise.
 */
function rankByWords<T>(items: T[], query: string, textOf: (item: T) => string, limit: number): T[] {
  const words = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u))].filter(
    (w) => w.length >= 3
  );
  if (words.length === 0) return [];
  return items
    .map((item) => {
      const text = textOf(item).toLowerCase();
      return { item, score: words.filter((w) => text.includes(w)).length };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.item);
}

export interface ChatHit {
  id: number;
  body: string;
  senderName: string | null;
  createdAt: number;
}

// How far back the chat search reads. Everything is decrypted to be searched, so it's bounded;
// anything worth keeping longer should be a note, which Joyce saves without being asked.
const CHAT_SEARCH_WINDOW = 1000;

/**
 * What any member has said to Joyce, searched by words — so something one person mentioned in
 * passing can still be found by another. Members' own messages only, not Joyce's replies, each
 * with who said it and when.
 */
export function searchFamilyChat(session: FamilySession, query: string, limit = 10): ChatHit[] {
  const rows = session.db
    .prepare(
      `SELECT m.id, m.body_enc, m.created_at, mem.display_name_enc
         FROM messages m LEFT JOIN members mem ON mem.id = m.member_id
        WHERE m.role = 'user' ORDER BY m.id DESC LIMIT ?`
    )
    .all(CHAT_SEARCH_WINDOW) as { id: number; body_enc: string; created_at: number; display_name_enc: string | null }[];
  const hits = rows.map((r) => ({
    id: r.id,
    body: decryptFor(session.key, r.body_enc),
    senderName: r.display_name_enc === null ? null : decryptFor(session.key, r.display_name_enc),
    createdAt: r.created_at,
  }));
  return rankByWords(hits, query, (h) => h.body, limit);
}

export function searchNotes(session: FamilySession, query: string, limit = 10): NoteRow[] {
  return rankByWords(listNotes(session, 500), query, (n) => `${n.title} ${n.body}`, limit);
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
    /** A bare filename inside the family's folder — see joyce/files.ts. */
    storedName: string;
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
      doc.storedName,
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

/** One document by its id within this family, for sending the original file back. */
export function getDocument(
  session: FamilySession,
  id: number
): { id: number; filename: string | null; mimeType: string; storedName: string } | null {
  const row = session.db
    .prepare(`SELECT id, filename_enc, mime_type, stored_path FROM documents WHERE id = ?`)
    .get(id) as
    | { id: number; filename_enc: string | null; mime_type: string; stored_path: string }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    filename: row.filename_enc === null ? null : decryptFor(session.key, row.filename_enc),
    mimeType: row.mime_type,
    storedName: row.stored_path,
  };
}

export function searchDocuments(session: FamilySession, query: string, limit = 5): DocumentRow[] {
  return rankByWords(
    listDocuments(session, 200),
    query,
    (d) => `${d.filename ?? ""} ${d.caption ?? ""} ${d.extractedText}`,
    limit
  );
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
  syncReminderSchedule(session);
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
 * Reminders now due for this member — addressed to them or to the whole family — that they
 * haven't received yet, whether because the reminder sender couldn't reach them or because it
 * hasn't run. Recorded as delivered to them in the same call, so nothing is handed over twice.
 */
export function claimDueReminders(session: FamilySession, now = Date.now()): ReminderRow[] {
  const due = decryptReminderRows(
    session,
    session.db
      .prepare(
        `${REMINDER_SELECT}
          WHERE r.delivered_at IS NULL AND r.due_at <= ?
            AND (r.target_member_id IS NULL OR r.target_member_id = ?)
            AND NOT EXISTS (SELECT 1 FROM reminder_deliveries d
                             WHERE d.reminder_id = r.id AND d.member_id = ?)
          ORDER BY r.due_at ASC`
      )
      .all(now, session.actor.id, session.actor.id) as never
  );
  for (const r of due) recordReminderDelivery(session, r.id, session.actor.id, now);
  if (due.length > 0) syncReminderSchedule(session);
  return due;
}

// --- Reminder sending (reminderDelivery.ts) ----------------------------------------------------

export interface ReminderRecipient {
  memberId: number;
  name: string | null;
  /** Null for a member who hasn't messaged since numbers started being kept. */
  phone: string | null;
  lastSeenAt: number;
}

export interface ReminderToPush {
  id: number;
  body: string;
  createdByName: string | null;
  /** Who still needs it: the target, or every member for a whole-family reminder. */
  recipients: ReminderRecipient[];
}

/** Due reminders the sender hasn't tried yet, with who still needs each one. */
export function listRemindersToPush(family: FamilyData, now = Date.now()): ReminderToPush[] {
  const rows = family.db
    .prepare(
      `SELECT r.id, r.body_enc, r.target_member_id, creator.display_name_enc AS creator_name_enc
         FROM reminders r JOIN members creator ON creator.id = r.created_by_member_id
        WHERE r.delivered_at IS NULL AND r.push_attempted_at IS NULL AND r.due_at <= ?
        ORDER BY r.due_at ASC`
    )
    .all(now) as {
    id: number;
    body_enc: string;
    target_member_id: number | null;
    creator_name_enc: string | null;
  }[];
  const members = family.db
    .prepare(`SELECT id, display_name_enc, phone_enc, last_seen_at FROM members`)
    .all() as { id: number; display_name_enc: string | null; phone_enc: string | null; last_seen_at: number }[];
  const delivered = family.db.prepare(
    `SELECT 1 FROM reminder_deliveries WHERE reminder_id = ? AND member_id = ?`
  );

  return rows.map((r) => ({
    id: r.id,
    body: decryptFor(family.key, r.body_enc),
    createdByName: r.creator_name_enc === null ? null : decryptFor(family.key, r.creator_name_enc),
    recipients: members
      .filter((m) => r.target_member_id === null || m.id === r.target_member_id)
      .filter((m) => !delivered.get(r.id, m.id))
      .map((m) => ({
        memberId: m.id,
        name: m.display_name_enc === null ? null : decryptFor(family.key, m.display_name_enc),
        phone: m.phone_enc === null ? null : decryptFor(family.key, m.phone_enc),
        lastSeenAt: m.last_seen_at,
      })),
  }));
}

/**
 * Records that a member has a reminder, and marks the reminder done once everyone it was for has
 * it: the target member, or every member of the family for a whole-family reminder.
 */
export function recordReminderDelivery(
  family: FamilyData,
  reminderId: number,
  memberId: number,
  now = Date.now()
): void {
  family.db
    .prepare(
      `INSERT INTO reminder_deliveries (reminder_id, member_id, delivered_at) VALUES (?, ?, ?)
       ON CONFLICT(reminder_id, member_id) DO NOTHING`
    )
    .run(reminderId, memberId, now);
  const outstanding = family.db
    .prepare(
      `SELECT COUNT(*) AS n FROM members m, reminders r
        WHERE r.id = ? AND (r.target_member_id IS NULL OR m.id = r.target_member_id)
          AND NOT EXISTS (SELECT 1 FROM reminder_deliveries d
                           WHERE d.reminder_id = r.id AND d.member_id = m.id)`
    )
    .get(reminderId) as { n: number };
  if (outstanding.n === 0) {
    family.db.prepare(`UPDATE reminders SET delivered_at = ? WHERE id = ?`).run(now, reminderId);
  }
}

/** The sender has had its one go at this reminder; anyone left gets it when they next message. */
export function markReminderPushAttempted(family: FamilyData, reminderId: number, now = Date.now()): void {
  family.db.prepare(`UPDATE reminders SET push_attempted_at = ? WHERE id = ?`).run(now, reminderId);
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

// --- Calendar ------------------------------------------------------------------------------------

export interface EventRow {
  id: number;
  title: string;
  notes: string | null;
  allDay: boolean;
  /** All-day events only: first and last day, inclusive, as written. */
  startDate: string | null;
  endDate: string | null;
  startsAt: number;
  endsAt: number;
  /** The member it's for, if it's for a member. */
  aboutMemberId: number | null;
  /** Who it's for by name — a member's name, or someone who isn't a member. Null: whole family. */
  aboutName: string | null;
  createdByName: string | null;
}

export interface NewEvent {
  title: string;
  notes?: string | null;
  allDay: boolean;
  startDate?: string | null;
  endDate?: string | null;
  startsAt: number;
  endsAt: number;
  aboutMemberId: number | null;
  /** Someone who isn't a member, e.g. a child without a phone. Ignored when aboutMemberId is set. */
  aboutLabel?: string | null;
}

const EVENT_SELECT = `
  SELECT e.id, e.title_enc, e.notes_enc, e.all_day, e.start_date, e.end_date, e.starts_at,
         e.ends_at, e.about_member_id, e.about_label_enc, about.display_name_enc AS about_name_enc,
         creator.display_name_enc AS creator_name_enc
    FROM events e
    JOIN members creator ON creator.id = e.created_by_member_id
    LEFT JOIN members about ON about.id = e.about_member_id`;

type EventDbRow = {
  id: number;
  title_enc: string;
  notes_enc: string | null;
  all_day: number;
  start_date: string | null;
  end_date: string | null;
  starts_at: number;
  ends_at: number;
  about_member_id: number | null;
  about_label_enc: string | null;
  about_name_enc: string | null;
  creator_name_enc: string | null;
};

function decryptEvent(family: FamilyData, r: EventDbRow): EventRow {
  const dec = (v: string | null) => (v === null ? null : decryptFor(family.key, v));
  return {
    id: r.id,
    title: decryptFor(family.key, r.title_enc),
    notes: dec(r.notes_enc),
    allDay: r.all_day === 1,
    startDate: r.start_date,
    endDate: r.end_date,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    aboutMemberId: r.about_member_id,
    aboutName: dec(r.about_name_enc) ?? dec(r.about_label_enc),
    createdByName: dec(r.creator_name_enc),
  };
}

function labelFor(family: FamilyData, event: NewEvent): string | null {
  const label = event.aboutMemberId === null ? event.aboutLabel?.trim() : null;
  return label ? encryptFor(family.key, label) : null;
}

export function addEvent(session: FamilySession, event: NewEvent): number {
  const now = Date.now();
  const res = session.db
    .prepare(
      `INSERT INTO events (created_by_member_id, about_member_id, about_label_enc, title_enc, notes_enc,
                           all_day, start_date, end_date, starts_at, ends_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      session.actor.id,
      event.aboutMemberId,
      labelFor(session, event),
      encryptFor(session.key, event.title),
      event.notes ? encryptFor(session.key, event.notes) : null,
      event.allDay ? 1 : 0,
      event.startDate ?? null,
      event.endDate ?? null,
      event.startsAt,
      event.endsAt,
      now,
      now
    );
  return Number(res.lastInsertRowid);
}

export function getEvent(family: FamilyData, id: number): EventRow | null {
  const row = family.db.prepare(`${EVENT_SELECT} WHERE e.id = ?`).get(id) as EventDbRow | undefined;
  return row ? decryptEvent(family, row) : null;
}

/** Events overlapping [fromMs, toMs), earliest first. */
export function listEventsBetween(family: FamilyData, fromMs: number, toMs: number): EventRow[] {
  return (
    family.db
      .prepare(`${EVENT_SELECT} WHERE e.starts_at < ? AND e.ends_at > ? ORDER BY e.starts_at ASC`)
      .all(toMs, fromMs) as EventDbRow[]
  ).map((r) => decryptEvent(family, r));
}

/** Every event, for the calendar subscription feed. */
export function listAllEvents(family: FamilyData): EventRow[] {
  return (family.db.prepare(`${EVENT_SELECT} ORDER BY e.starts_at ASC`).all() as EventDbRow[]).map((r) =>
    decryptEvent(family, r)
  );
}

/**
 * Other events that overlap this time and involve the same people: anything for the same person
 * (the same member, or the same name for someone who isn't a member) or for the whole family,
 * or — for a whole-family event — anything at all.
 */
export function findClashes(
  family: FamilyData,
  startsAt: number,
  endsAt: number,
  about: { memberId: number | null; name: string | null },
  excludeId?: number
): EventRow[] {
  const forWholeFamily = (memberId: number | null, name: string | null) => memberId === null && !name;
  const samePerson = (e: EventRow) =>
    about.memberId !== null
      ? e.aboutMemberId === about.memberId
      : !!about.name && e.aboutMemberId === null && e.aboutName?.toLowerCase() === about.name.toLowerCase();
  return listEventsBetween(family, startsAt, endsAt).filter(
    (e) =>
      e.id !== excludeId &&
      (forWholeFamily(about.memberId, about.name) || forWholeFamily(e.aboutMemberId, e.aboutName) || samePerson(e))
  );
}

export function updateEvent(session: FamilySession, id: number, event: NewEvent): boolean {
  const res = session.db
    .prepare(
      `UPDATE events SET about_member_id = ?, about_label_enc = ?, title_enc = ?, notes_enc = ?,
                         all_day = ?, start_date = ?, end_date = ?, starts_at = ?, ends_at = ?,
                         updated_at = ?
        WHERE id = ?`
    )
    .run(
      event.aboutMemberId,
      labelFor(session, event),
      encryptFor(session.key, event.title),
      event.notes ? encryptFor(session.key, event.notes) : null,
      event.allDay ? 1 : 0,
      event.startDate ?? null,
      event.endDate ?? null,
      event.startsAt,
      event.endsAt,
      Date.now(),
      id
    );
  return res.changes > 0;
}

export function deleteEvent(session: FamilySession, id: number): boolean {
  return session.db.prepare(`DELETE FROM events WHERE id = ?`).run(id).changes > 0;
}

// The current calendar link secret, kept encrypted so a member can ask for the link again. The
// registry holds only its hash (registry.ts's calendar_feeds), like the join code.
const CALENDAR_TOKEN_KEY = "calendar_token_enc";

export function setFamilyCalendarToken(session: FamilySession, token: string): void {
  session.db
    .prepare(
      `INSERT INTO family_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(CALENDAR_TOKEN_KEY, encryptFor(session.key, token));
}

export function getFamilyCalendarToken(session: FamilySession): string | null {
  const row = session.db
    .prepare(`SELECT value FROM family_meta WHERE key = ?`)
    .get(CALENDAR_TOKEN_KEY) as { value: string } | undefined;
  return row ? decryptFor(session.key, row.value) : null;
}

// --- The family admin ------------------------------------------------------------------------------
// Whoever started the family. The only thing it grants: deleting another member's message. Set
// when the family is created; for families made before that, the first member (lowest id),
// which is the person who created it.

const ADMIN_KEY = "admin_member_id";

export function setFamilyAdmin(session: FamilySession): void {
  session.db
    .prepare(
      `INSERT INTO family_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(ADMIN_KEY, String(session.actor.id));
}

export function getFamilyAdminId(family: FamilyData): number | null {
  const stored = family.db.prepare(`SELECT value FROM family_meta WHERE key = ?`).get(ADMIN_KEY) as
    | { value: string }
    | undefined;
  if (stored) return Number(stored.value);
  const first = family.db.prepare(`SELECT MIN(id) AS id FROM members`).get() as { id: number | null };
  return first.id;
}

// --- A delete waiting for confirmation ----------------------------------------------------------
// Per member, in the family's own file. Spent by the member's very next message whatever it is,
// and void after ten minutes — the same shape as leaving a family (leaving.ts).

const PENDING_DELETE_TTL_MS = 10 * 60 * 1000;
const pendingDeleteKey = (memberId: number) => `pending_delete:${memberId}`;

export interface PendingDelete {
  /** The message to delete. */
  messageId: number;
  /** The member's message asking for it ("delete this"), removed too once it's done. */
  requestMessageId: number | null;
}

export function setPendingDelete(session: FamilySession, pending: PendingDelete): void {
  session.db
    .prepare(
      `INSERT INTO family_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(pendingDeleteKey(session.actor.id), JSON.stringify({ ...pending, at: Date.now() }));
}

/** What this member asked to delete, if they asked within the last ten minutes. Clears it. */
export function takePendingDelete(session: FamilySession, now = Date.now()): PendingDelete | null {
  const k = pendingDeleteKey(session.actor.id);
  const row = session.db.prepare(`SELECT value FROM family_meta WHERE key = ?`).get(k) as
    | { value: string }
    | undefined;
  if (!row) return null;
  session.db.prepare(`DELETE FROM family_meta WHERE key = ?`).run(k);
  const { messageId, requestMessageId, at } = JSON.parse(row.value) as PendingDelete & { at: number };
  return now - at <= PENDING_DELETE_TTL_MS ? { messageId, requestMessageId: requestMessageId ?? null } : null;
}

// --- Google accounts ---------------------------------------------------------------------------

export interface GoogleAccountRow {
  id: number;
  memberId: number;
  memberName: string | null;
  isSelf: boolean;
  email: string;
  accessToken: string | null;
  refreshToken: string | null;
  expiryDate: number | null;
  timeZone: string;
}

/**
 * Connects a Google account for the person talking, replacing any they had before — one per
 * member. Google sometimes leaves out the refresh token on a repeat sign-in, so an existing one
 * is kept rather than overwritten with nothing.
 */
export function saveMyGoogleAccount(
  session: FamilySession,
  account: {
    email: string;
    accessToken: string | null;
    refreshToken: string | null;
    expiryDate: number | null;
    timeZone: string;
  }
): void {
  const enc = (v: string | null) => (v === null ? null : encryptFor(session.key, v));
  session.db
    .prepare(
      `INSERT INTO google_accounts
         (member_id, email_enc, access_token_enc, refresh_token_enc, expiry_date, time_zone, connected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(member_id) DO UPDATE SET
         email_enc = excluded.email_enc,
         access_token_enc = excluded.access_token_enc,
         refresh_token_enc = COALESCE(excluded.refresh_token_enc, google_accounts.refresh_token_enc),
         expiry_date = excluded.expiry_date,
         time_zone = excluded.time_zone,
         connected_at = excluded.connected_at`
    )
    .run(
      session.actor.id,
      encryptFor(session.key, account.email),
      enc(account.accessToken),
      enc(account.refreshToken),
      account.expiryDate,
      account.timeZone,
      Date.now()
    );
}

const GOOGLE_ACCOUNT_SELECT = `
  SELECT g.id, g.member_id, g.email_enc, g.access_token_enc, g.refresh_token_enc, g.expiry_date,
         g.time_zone, mem.display_name_enc
    FROM google_accounts g JOIN members mem ON mem.id = g.member_id`;

function decryptGoogleAccountRow(
  session: FamilySession,
  r: {
    id: number;
    member_id: number;
    email_enc: string;
    access_token_enc: string | null;
    refresh_token_enc: string | null;
    expiry_date: number | null;
    time_zone: string;
    display_name_enc: string | null;
  }
): GoogleAccountRow {
  const dec = (v: string | null) => (v === null ? null : decryptFor(session.key, v));
  return {
    id: r.id,
    memberId: r.member_id,
    memberName: dec(r.display_name_enc),
    isSelf: r.member_id === session.actor.id,
    email: decryptFor(session.key, r.email_enc),
    accessToken: dec(r.access_token_enc),
    refreshToken: dec(r.refresh_token_enc),
    expiryDate: r.expiry_date,
    timeZone: r.time_zone,
  };
}

/** Whether anyone in the family has connected Google — see calendarMode.ts. */
export function hasGoogleAccounts(family: FamilyData): boolean {
  return !!family.db.prepare(`SELECT 1 FROM google_accounts LIMIT 1`).get();
}

export function listGoogleAccounts(session: FamilySession): GoogleAccountRow[] {
  return (session.db.prepare(`${GOOGLE_ACCOUNT_SELECT} ORDER BY g.id ASC`).all() as never[]).map(
    (r) => decryptGoogleAccountRow(session, r)
  );
}

/** One account by id, within this family's file only — an id from anywhere else finds nothing. */
export function getGoogleAccount(session: FamilySession, id: number): GoogleAccountRow | null {
  const row = session.db.prepare(`${GOOGLE_ACCOUNT_SELECT} WHERE g.id = ?`).get(id);
  return row ? decryptGoogleAccountRow(session, row as never) : null;
}

export function getGoogleAccountForMember(
  session: FamilySession,
  memberId: number
): GoogleAccountRow | null {
  const row = session.db.prepare(`${GOOGLE_ACCOUNT_SELECT} WHERE g.member_id = ?`).get(memberId);
  return row ? decryptGoogleAccountRow(session, row as never) : null;
}

/** Stores tokens Google refreshed mid-request, so the next request doesn't refresh them again. */
export function updateGoogleTokens(
  session: FamilySession,
  id: number,
  tokens: { accessToken: string | null; refreshToken?: string; expiryDate: number | null }
): void {
  session.db
    .prepare(
      `UPDATE google_accounts
          SET access_token_enc = ?, expiry_date = ?,
              refresh_token_enc = COALESCE(?, refresh_token_enc)
        WHERE id = ?`
    )
    .run(
      tokens.accessToken === null ? null : encryptFor(session.key, tokens.accessToken),
      tokens.expiryDate,
      tokens.refreshToken ? encryptFor(session.key, tokens.refreshToken) : null,
      id
    );
}

/**
 * Disconnects the person talking — only ever their own account, never another member's. Returns
 * what was removed so the caller can revoke it at Google too, or null if they had none.
 */
export function deleteMyGoogleAccount(session: FamilySession): GoogleAccountRow | null {
  const existing = getGoogleAccountForMember(session, session.actor.id);
  if (!existing) return null;
  session.db.prepare(`DELETE FROM google_accounts WHERE member_id = ?`).run(session.actor.id);
  return existing;
}

// --- The family calendar -------------------------------------------------------------------------

export interface FamilyCalendarSetting {
  calendarId: string;
  name: string;
  timeZone: string;
  /** The member whose Google account owns it — the only one who can share it with others. */
  ownerMemberId: number;
}

const FAMILY_CALENDAR_KEY = "google_family_calendar";

/** The family's shared Google calendar, if one has been made. Kept encrypted in family_meta. */
export function getFamilyCalendar(session: FamilySession): FamilyCalendarSetting | null {
  const row = session.db
    .prepare(`SELECT value FROM family_meta WHERE key = ?`)
    .get(FAMILY_CALENDAR_KEY) as { value: string } | undefined;
  return row ? (JSON.parse(decryptFor(session.key, row.value)) as FamilyCalendarSetting) : null;
}

export function setFamilyCalendar(session: FamilySession, setting: FamilyCalendarSetting): void {
  session.db
    .prepare(
      `INSERT INTO family_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(FAMILY_CALENDAR_KEY, encryptFor(session.key, JSON.stringify(setting)));
}

export function clearFamilyCalendar(session: FamilySession): void {
  session.db.prepare(`DELETE FROM family_meta WHERE key = ?`).run(FAMILY_CALENDAR_KEY);
}
