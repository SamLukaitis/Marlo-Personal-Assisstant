// Moves one Marlo account from one WhatsApp number to another with nothing else changed — for
// someone whose SIM or WhatsApp number changed. Run by scripts/changePhone.ts (npm run
// change-phone); the logic lives here so it can be tested.
//
// Account data (mail, calendar, trips, settings) is keyed by owner_id and never moves. What does
// move is every table keyed by the phone number itself, listed below. A test
// (phoneChange.test.ts) fails if a new table gains a `phone` column that isn't classified here, so
// a future feature can't silently be left behind on the old number.
//
// Joyce keeps its own phone-keyed registry (an HMAC of the number, in per-family encrypted
// databases) which this does NOT touch. If the old number is in a Joyce family, the three Marlo
// tables that mirror that link (family_links, family_link_shares, family_trips) are left on the old
// number too, so the two sides stay consistent, and the result says so.
import type Database from "better-sqlite3";
import { getDb, normalizePhone } from "../db/store.js";
import { isInJoyceFamily } from "../bridge/index.js";
import { internationalPhoneError } from "./phoneFormat.js";

// Data that follows the person. If the new number already has rows here, nothing is moved: merging
// two histories silently would be worse than stopping.
const MOVE_TABLES = [
  "whatsapp_messages",
  "whatsapp_conversation_summaries",
  "documents",
  "phone_actions",
  "memory_extraction_cursors",
  "proactive_deliveries",
] as const;

// Mirrors the Joyce family link; see the header comment.
const JOYCE_LINKED_TABLES = ["family_links", "family_link_shares", "family_trips"] as const;

// Bookkeeping about a number rather than a person's data. The new number's rows are stale by
// definition (e.g. a half-finished registration from messaging Marlo before this move), so they
// are cleared and the old number's rows take their place.
const TRANSIENT_TABLES = [
  "invited_phones",
  "waitlist_requests",
  "replay_parked_phones",
  "pending_whatsapp_registrations",
] as const;

// Handled by hand in changePhone().
const BINDING_TABLE = "user_phone_numbers";

export const CLASSIFIED_PHONE_TABLES: readonly string[] = [
  ...MOVE_TABLES,
  ...JOYCE_LINKED_TABLES,
  ...TRANSIENT_TABLES,
  BINDING_TABLE,
];

export interface PhoneChangePlan {
  ok: boolean;
  applied: boolean;
  oldPhone: string;
  newPhone: string;
  ownerId: number | null;
  // Human-readable reasons nothing was (or would be) done. Empty when ok.
  problems: string[];
  warnings: string[];
  // Rows per table that moved, or would move.
  counts: Record<string, number>;
}

function count(db: Database.Database, table: string, phone: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE phone = ?`).get(phone) as { n: number }).n;
}

export function changePhone(
  oldInput: string,
  newInput: string,
  opts: { apply: boolean },
  db: Database.Database = getDb()
): PhoneChangePlan {
  const oldPhone = normalizePhone(oldInput);
  const newPhone = normalizePhone(newInput);
  const plan: PhoneChangePlan = {
    ok: false,
    applied: false,
    oldPhone,
    newPhone,
    ownerId: null,
    problems: [],
    warnings: [],
    counts: {},
  };

  for (const [label, phone] of [["old", oldPhone], ["new", newPhone]] as const) {
    const formatError = internationalPhoneError(phone);
    if (formatError) plan.problems.push(`The ${label} number: ${formatError}`);
  }
  if (oldPhone === newPhone) plan.problems.push("The old and new numbers are the same.");
  if (plan.problems.length) return plan;

  const oldBinding = db.prepare(`SELECT user_id AS userId FROM ${BINDING_TABLE} WHERE phone = ?`).get(oldPhone) as
    | { userId: number }
    | undefined;
  if (!oldBinding) {
    plan.problems.push(`${oldPhone} isn't bound to any account, so there is nothing to move.`);
    return plan;
  }
  plan.ownerId = oldBinding.userId;

  const newBinding = db.prepare(`SELECT user_id AS userId FROM ${BINDING_TABLE} WHERE phone = ?`).get(newPhone) as
    | { userId: number }
    | undefined;
  if (newBinding) {
    plan.problems.push(
      `${newPhone} is already bound to account ${newBinding.userId}` +
        (newBinding.userId === oldBinding.userId ? " (the same account)." : ", a different account.") +
        " Remove that binding first if it's a leftover."
    );
  }

  const inJoyce = isInJoyceFamily(oldPhone);
  if (inJoyce) {
    plan.warnings.push(
      `${oldPhone} is in a Joyce family. Joyce isn't moved by this script, so the family link and shared trips stay on ${oldPhone}; the Joyce side needs its own move.`
    );
  }
  if (isInJoyceFamily(newPhone)) {
    plan.warnings.push(`${newPhone} is already in a Joyce family.`);
  }

  const moving = inJoyce ? [...MOVE_TABLES] : [...MOVE_TABLES, ...JOYCE_LINKED_TABLES];
  for (const table of moving) {
    const clash = count(db, table, newPhone);
    if (clash > 0) {
      plan.problems.push(`${table} already has ${clash} row(s) for ${newPhone}; refusing to merge two histories.`);
    }
  }
  if (plan.problems.length) return plan;

  for (const table of [...moving, ...TRANSIENT_TABLES, BINDING_TABLE]) {
    plan.counts[table] = count(db, table, oldPhone);
  }
  plan.ok = true;
  if (!opts.apply) return plan;

  db.transaction(() => {
    for (const table of TRANSIENT_TABLES) {
      db.prepare(`DELETE FROM "${table}" WHERE phone = ?`).run(newPhone);
    }
    for (const table of [...moving, ...TRANSIENT_TABLES]) {
      db.prepare(`UPDATE "${table}" SET phone = ? WHERE phone = ?`).run(newPhone, oldPhone);
    }
    // last_inbound_at reset on purpose: the new number has never messaged Marlo, so there is no
    // open 24h window. Carrying the old timestamp would make outbound.ts send free-form text that
    // WhatsApp then rejects, instead of a template.
    db.prepare(`UPDATE ${BINDING_TABLE} SET phone = ?, last_inbound_at = NULL WHERE phone = ?`).run(
      newPhone,
      oldPhone
    );
  })();
  plan.applied = true;
  return plan;
}
