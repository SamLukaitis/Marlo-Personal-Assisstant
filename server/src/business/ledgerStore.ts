// SQL for the business ledger (tables: db/migrations/businessLedger.ts). Rules that decide WHAT
// gets written live in ledger.ts; this file only guarantees integrity: validation, dedupe,
// owner scoping, history on every change, and soft deletes only.
import { getDb } from "../db/store.js";

export type Direction = "in" | "out";
export type BusinessUse = "business" | "personal" | "unsure";
export type LedgerStatus = "confirmed" | "needs_review";
export type LedgerSource = "whatsapp_doc" | "email" | "chat" | "bank";
export type ChangedBy = "user" | "assistant" | "system";

export interface LedgerEntry {
  id: number;
  ownerId: number;
  direction: Direction;
  amountPence: number;
  occurredOn: string;
  counterparty: string | null;
  description: string | null;
  category: string | null;
  businessUse: BusinessUse;
  status: LedgerStatus;
  source: LedgerSource;
  documentId: number | null;
  sourceRef: string | null;
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface NewLedgerEntry {
  direction: Direction;
  amountPence: number;
  occurredOn: string;
  counterparty?: string | null;
  description?: string | null;
  category?: string | null;
  businessUse: BusinessUse;
  status: LedgerStatus;
  source: LedgerSource;
  documentId?: number | null;
  sourceRef?: string | null;
}

export type LedgerPatch = Partial<
  Pick<LedgerEntry, "amountPence" | "occurredOn" | "counterparty" | "description" | "category" | "businessUse" | "status">
>;

const SELECT = `SELECT id, owner_id AS ownerId, direction, amount_pence AS amountPence, occurred_on AS occurredOn,
  counterparty, description, category, business_use AS businessUse, status, source, document_id AS documentId,
  source_ref AS sourceRef, deleted_at AS deletedAt, created_at AS createdAt, updated_at AS updatedAt
  FROM ledger_entries`;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validate(e: Pick<LedgerEntry, "amountPence" | "occurredOn">): void {
  if (!Number.isInteger(e.amountPence) || e.amountPence <= 0) {
    throw new Error(`amountPence must be a positive whole number of pence, got ${e.amountPence}`);
  }
  if (!ISO_DATE.test(e.occurredOn) || Number.isNaN(Date.parse(e.occurredOn))) {
    throw new Error(`occurredOn must be YYYY-MM-DD, got "${e.occurredOn}"`);
  }
}

export function getLedgerEntry(ownerId: number, id: number): LedgerEntry | null {
  return (getDb().prepare(`${SELECT} WHERE owner_id = ? AND id = ?`).get(ownerId, id) as LedgerEntry | undefined) ?? null;
}

export function insertLedgerEntry(ownerId: number, e: NewLedgerEntry): { entry: LedgerEntry; created: boolean } {
  validate(e);
  const db = getDb();
  if (e.sourceRef) {
    const existing = db
      .prepare(`${SELECT} WHERE owner_id = ? AND source = ? AND source_ref = ?`)
      .get(ownerId, e.source, e.sourceRef) as LedgerEntry | undefined;
    if (existing) return { entry: existing, created: false };
  }
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO ledger_entries (owner_id, direction, amount_pence, occurred_on, counterparty, description, category,
         business_use, status, source, document_id, source_ref, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      ownerId,
      e.direction,
      e.amountPence,
      e.occurredOn,
      e.counterparty ?? null,
      e.description ?? null,
      e.category ?? null,
      e.businessUse,
      e.status,
      e.source,
      e.documentId ?? null,
      e.sourceRef ?? null,
      now,
      now
    );
  return { entry: getLedgerEntry(ownerId, Number(info.lastInsertRowid))!, created: true };
}

function writeWithHistory(
  ownerId: number,
  id: number,
  changedBy: ChangedBy,
  apply: (before: LedgerEntry) => void
): LedgerEntry | null {
  const db = getDb();
  return db.transaction(() => {
    const before = getLedgerEntry(ownerId, id);
    if (!before) return null;
    apply(before);
    const after = getLedgerEntry(ownerId, id)!;
    db.prepare(
      `INSERT INTO ledger_entry_history (entry_id, owner_id, changed_at, changed_by, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, ownerId, Date.now(), changedBy, JSON.stringify(before), JSON.stringify(after));
    return after;
  })();
}

const PATCH_COLUMNS: Record<keyof LedgerPatch, string> = {
  amountPence: "amount_pence",
  occurredOn: "occurred_on",
  counterparty: "counterparty",
  description: "description",
  category: "category",
  businessUse: "business_use",
  status: "status",
};

export function updateLedgerEntry(ownerId: number, id: number, patch: LedgerPatch, changedBy: ChangedBy): LedgerEntry | null {
  const keys = (Object.keys(patch) as (keyof LedgerPatch)[]).filter((k) => patch[k] !== undefined);
  return writeWithHistory(ownerId, id, changedBy, (before) => {
    validate({ amountPence: patch.amountPence ?? before.amountPence, occurredOn: patch.occurredOn ?? before.occurredOn });
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${PATCH_COLUMNS[k]} = ?`).join(", ");
    getDb()
      .prepare(`UPDATE ledger_entries SET ${sets}, updated_at = ? WHERE owner_id = ? AND id = ?`)
      .run(...keys.map((k) => patch[k] as string | number | null), Date.now(), ownerId, id);
  });
}

export function softDeleteLedgerEntry(ownerId: number, id: number, changedBy: ChangedBy): LedgerEntry | null {
  return writeWithHistory(ownerId, id, changedBy, () => {
    const now = Date.now();
    getDb()
      .prepare(`UPDATE ledger_entries SET deleted_at = ?, updated_at = ? WHERE owner_id = ? AND id = ?`)
      .run(now, now, ownerId, id);
  });
}

export function listLedgerEntries(
  ownerId: number,
  f: { from?: string; to?: string; direction?: Direction; status?: LedgerStatus; category?: string; limit?: number } = {}
): LedgerEntry[] {
  const where = ["owner_id = ?", "deleted_at IS NULL"];
  const args: (string | number)[] = [ownerId];
  if (f.from) {
    where.push("occurred_on >= ?");
    args.push(f.from);
  }
  if (f.to) {
    where.push("occurred_on <= ?");
    args.push(f.to);
  }
  if (f.direction) {
    where.push("direction = ?");
    args.push(f.direction);
  }
  if (f.status) {
    where.push("status = ?");
    args.push(f.status);
  }
  if (f.category) {
    where.push("category = ?");
    args.push(f.category);
  }
  args.push(f.limit ?? 50);
  return getDb()
    .prepare(`${SELECT} WHERE ${where.join(" AND ")} ORDER BY occurred_on DESC, id DESC LIMIT ?`)
    .all(...args) as LedgerEntry[];
}

export function listLedgerHistory(
  ownerId: number,
  entryId: number
): { changedAt: number; changedBy: ChangedBy; before: unknown; after: unknown }[] {
  return (
    getDb()
      .prepare(
        `SELECT changed_at AS changedAt, changed_by AS changedBy, before_json AS b, after_json AS a
         FROM ledger_entry_history WHERE owner_id = ? AND entry_id = ? ORDER BY id ASC`
      )
      .all(ownerId, entryId) as { changedAt: number; changedBy: ChangedBy; b: string; a: string }[]
  ).map((r) => ({ changedAt: r.changedAt, changedBy: r.changedBy, before: JSON.parse(r.b), after: JSON.parse(r.a) }));
}

export function summariseLedger(
  ownerId: number,
  from: string,
  to: string
): { incomePence: number; expensesPence: number; byCategory: Record<string, number>; needsReviewCount: number } {
  const db = getDb();
  const counted = `owner_id = ? AND deleted_at IS NULL AND status = 'confirmed' AND business_use = 'business' AND occurred_on BETWEEN ? AND ?`;
  const totals = db
    .prepare(`SELECT direction, SUM(amount_pence) AS total FROM ledger_entries WHERE ${counted} GROUP BY direction`)
    .all(ownerId, from, to) as { direction: Direction; total: number }[];
  const cats = db
    .prepare(
      `SELECT category, SUM(amount_pence) AS total FROM ledger_entries WHERE ${counted} AND direction = 'out' GROUP BY category`
    )
    .all(ownerId, from, to) as { category: string | null; total: number }[];
  const review = db
    .prepare(`SELECT COUNT(*) AS c FROM ledger_entries WHERE owner_id = ? AND deleted_at IS NULL AND status = 'needs_review'`)
    .get(ownerId) as { c: number };
  return {
    incomePence: totals.find((t) => t.direction === "in")?.total ?? 0,
    expensesPence: totals.find((t) => t.direction === "out")?.total ?? 0,
    byCategory: Object.fromEntries(cats.map((c) => [c.category ?? "uncategorised", c.total])),
    needsReviewCount: review.c,
  };
}

const COMPANY_SUFFIXES = /\b(ltd|limited|plc|llp|inc|uk|co)\b/g;

// "SCREWFIX LTD", "Screwfix." and "screwfix" are the same supplier for remembered choices.
export function counterpartyKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(COMPANY_SUFFIXES, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function getCounterpartyChoice(
  ownerId: number,
  counterparty: string
): { category: string | null; businessUse: BusinessUse } | null {
  const key = counterpartyKey(counterparty);
  if (!key) return null;
  return (
    (getDb()
      .prepare(
        `SELECT category, business_use AS businessUse FROM ledger_counterparty_choices WHERE owner_id = ? AND counterparty_key = ?`
      )
      .get(ownerId, key) as { category: string | null; businessUse: BusinessUse } | undefined) ?? null
  );
}

export function rememberCounterpartyChoice(
  ownerId: number,
  counterparty: string,
  category: string | null,
  businessUse: BusinessUse
): void {
  const key = counterpartyKey(counterparty);
  if (!key) return;
  getDb()
    .prepare(
      `INSERT INTO ledger_counterparty_choices (owner_id, counterparty_key, category, business_use, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(owner_id, counterparty_key) DO UPDATE SET category = excluded.category, business_use = excluded.business_use, updated_at = excluded.updated_at`
    )
    .run(ownerId, key, category, businessUse, Date.now());
}
