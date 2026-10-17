import type { FamilyData } from "./familyDb.js";
import { syncReminderSchedule } from "./familyDb.js";
import { decryptFor } from "./familyKey.js";
import { deleteFamilyFileFromDisk } from "./files.js";
import { deleteFlaggedRequest } from "./adminRecords.js";

// Where everything Joyce keeps came from, and taking it all back out.
//
// Every item Joyce stores is linked (the `derivations` table) to what it was made from: the
// member's message that started the turn, plus anything whose content she read during that turn
// — a note she looked up, a document she searched, an event she listed. Her own reply is linked
// the same way. So a letter about a trip, the trip event she put on the calendar from it, a
// reminder about the event, and the reply where she told someone the dates all trace back to the
// message that carried the letter.
//
// Deleting a message follows those links outward and removes everything reachable. That errs
// towards removing too much: something made in a turn where Joyce also happened to read the
// deleted item goes with it. For someone deleting something incorrect or personal, removing a
// little too much is the right side to be on.
//
// Links only exist from when this was added (2026-10-17). Deleting an older message removes just
// that message: nothing was recorded about what came from it.

export type ItemType = "message" | "document" | "note" | "event" | "reminder" | "relay" | "flag";

export interface Item {
  type: ItemType;
  id: number;
}

const key = (i: Item) => `${i.type}:${i.id}`;

/** Links `item` to each of `sources`. Duplicates and self-links are ignored. */
export function recordDerivation(family: FamilyData, item: Item, sources: Item[]): void {
  const insert = family.db.prepare(
    `INSERT INTO derivations (item_type, item_id, source_type, source_id) VALUES (?, ?, ?, ?)
     ON CONFLICT DO NOTHING`
  );
  for (const source of sources) {
    if (source.type === item.type && source.id === item.id) continue;
    insert.run(item.type, item.id, source.type, source.id);
  }
}

/** The item and everything made from it, directly or through other items. */
export function collectDerived(family: FamilyData, root: Item): Item[] {
  const children = family.db.prepare(
    `SELECT item_type AS type, item_id AS id FROM derivations WHERE source_type = ? AND source_id = ?`
  );
  const seen = new Map<string, Item>([[key(root), root]]);
  const queue: Item[] = [root];
  while (queue.length > 0) {
    const next = queue.shift()!;
    for (const child of children.all(next.type, next.id) as Item[]) {
      if (seen.has(key(child))) continue;
      seen.set(key(child), child);
      queue.push(child);
    }
  }
  return [...seen.values()];
}

const short = (text: string, max = 80) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/**
 * Plain lines describing what deleting `items` would remove, for the confirmation message.
 * Joyce's own replies are counted rather than quoted.
 */
export function describeItems(family: FamilyData, items: Item[]): string[] {
  const dec = (v: string | null) => (v === null ? null : decryptFor(family.key, v));
  const lines: string[] = [];
  let replies = 0;
  for (const item of items) {
    switch (item.type) {
      case "message": {
        const row = family.db.prepare(`SELECT role, body_enc FROM messages WHERE id = ?`).get(item.id) as
          | { role: string; body_enc: string }
          | undefined;
        if (!row) break;
        if (row.role === "assistant") replies++;
        else lines.push(`The message "${short(dec(row.body_enc)!)}"`);
        break;
      }
      case "document": {
        const row = family.db
          .prepare(`SELECT filename_enc, caption_enc FROM documents WHERE id = ?`)
          .get(item.id) as { filename_enc: string | null; caption_enc: string | null } | undefined;
        if (row) lines.push(`The file "${short(dec(row.filename_enc) ?? dec(row.caption_enc) ?? "photo")}"`);
        break;
      }
      case "note": {
        const row = family.db.prepare(`SELECT title_enc FROM notes WHERE id = ?`).get(item.id) as
          | { title_enc: string }
          | undefined;
        if (row) lines.push(`The note "${short(dec(row.title_enc)!)}"`);
        break;
      }
      case "event": {
        const row = family.db.prepare(`SELECT title_enc FROM events WHERE id = ?`).get(item.id) as
          | { title_enc: string }
          | undefined;
        if (row) lines.push(`The calendar event "${short(dec(row.title_enc)!)}"`);
        break;
      }
      case "reminder": {
        const row = family.db.prepare(`SELECT body_enc FROM reminders WHERE id = ?`).get(item.id) as
          | { body_enc: string }
          | undefined;
        if (row) lines.push(`The reminder "${short(dec(row.body_enc)!)}"`);
        break;
      }
      case "relay": {
        const row = family.db.prepare(`SELECT body_enc FROM relays WHERE id = ?`).get(item.id) as
          | { body_enc: string }
          | undefined;
        if (row) lines.push(`The message passed on: "${short(dec(row.body_enc)!)}"`);
        break;
      }
      case "flag":
        break;
    }
  }
  if (replies > 0) lines.push(`${replies} of my replies that used it`);
  return lines;
}

/** Removes every item, its links, and any file on disk. Returns how many items were removed. */
export function deleteItems(family: FamilyData, items: Item[]): number {
  const db = family.db;
  let removed = 0;
  const run = db.transaction(() => {
    for (const item of items) {
      switch (item.type) {
        case "message":
          removed += db.prepare(`DELETE FROM messages WHERE id = ?`).run(item.id).changes;
          break;
        case "document": {
          const row = db.prepare(`SELECT stored_path FROM documents WHERE id = ?`).get(item.id) as
            | { stored_path: string }
            | undefined;
          if (row) deleteFamilyFileFromDisk(family, row.stored_path);
          removed += db.prepare(`DELETE FROM documents WHERE id = ?`).run(item.id).changes;
          break;
        }
        case "note":
          removed += db.prepare(`DELETE FROM notes WHERE id = ?`).run(item.id).changes;
          break;
        case "event":
          removed += db.prepare(`DELETE FROM events WHERE id = ?`).run(item.id).changes;
          break;
        case "reminder":
          db.prepare(`DELETE FROM reminder_deliveries WHERE reminder_id = ?`).run(item.id);
          removed += db.prepare(`DELETE FROM reminders WHERE id = ?`).run(item.id).changes;
          break;
        case "relay":
          removed += db.prepare(`DELETE FROM relays WHERE id = ?`).run(item.id).changes;
          break;
        case "flag":
          deleteFlaggedRequest(item.id);
          removed++;
          break;
      }
      db.prepare(`DELETE FROM derivations WHERE (item_type = ? AND item_id = ?) OR (source_type = ? AND source_id = ?)`).run(
        item.type,
        item.id,
        item.type,
        item.id
      );
    }
  });
  run();
  // A deleted reminder may have been the next one due.
  syncReminderSchedule(family);
  return removed;
}
