import { describe, it, expect } from "vitest";
import {
  getDb,
  findOrCreateUserByPhone,
  addPhoneNumberForUser,
  appendWhatsAppMessage,
  upsertFamilyLink,
  recordInboundMessage,
  getLastInboundAt,
  resolveOwnerByPhone,
  addInvitedPhone,
  isPhoneInvited,
  recordWaitlistRequest,
  upsertPendingRegistration,
  getPendingRegistration,
  getUser,
} from "../db/store.js";
import { createFamily } from "../joyce/registry.js";
import { changePhone, CLASSIFIED_PHONE_TABLES } from "./phoneChange.js";

let counter = 0;
function phone(): string {
  counter += 1;
  return `4477${String(counter).padStart(8, "0")}`;
}

function setup() {
  const oldP = phone();
  const newP = phone();
  const user = findOrCreateUserByPhone(oldP);
  return { oldP, newP, user };
}

describe("changePhone", () => {
  it("is a dry run unless asked to apply", () => {
    const { oldP, newP, user } = setup();
    appendWhatsAppMessage(user.id, oldP, "user", "hello");

    const plan = changePhone(oldP, newP, { apply: false });

    expect(plan.ok).toBe(true);
    expect(plan.applied).toBe(false);
    expect(plan.counts.whatsapp_messages).toBe(1);
    expect(resolveOwnerByPhone(oldP)).toBe(user.id);
    expect(resolveOwnerByPhone(newP)).toBeNull();
  });

  it("moves the binding, chat history and invite, and clears the 24h window", () => {
    const { oldP, newP, user } = setup();
    appendWhatsAppMessage(user.id, oldP, "user", "hello");
    appendWhatsAppMessage(user.id, oldP, "assistant", "hi");
    addInvitedPhone(oldP, undefined, "Sam");
    recordInboundMessage(oldP);

    const plan = changePhone(oldP, newP, { apply: true });

    expect(plan.applied).toBe(true);
    expect(resolveOwnerByPhone(newP)).toBe(user.id);
    expect(resolveOwnerByPhone(oldP)).toBeNull();
    expect(getLastInboundAt(newP)).toBeNull();
    expect(isPhoneInvited(newP)).toBe(true);
    expect(isPhoneInvited(oldP)).toBe(false);
    const rows = getDb().prepare(`SELECT phone FROM whatsapp_messages WHERE owner_id = ?`).all(user.id) as {
      phone: string;
    }[];
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.phone === newP)).toBe(true);
    // The account itself is untouched.
    expect(getUser(user.id)?.id).toBe(user.id);
  });

  it("clears stale registration bookkeeping the new number picked up beforehand", () => {
    const { oldP, newP } = setup();
    recordWaitlistRequest(newP);
    upsertPendingRegistration(newP, { step: "awaiting_name" });

    const plan = changePhone(oldP, newP, { apply: true });

    expect(plan.applied).toBe(true);
    expect(getPendingRegistration(newP)).toBeNull();
    expect(resolveOwnerByPhone(newP)).not.toBeNull();
  });

  it("moves the family link when the number is not in a Joyce family", () => {
    const { oldP, newP, user } = setup();
    upsertFamilyLink(user.id, oldP);

    changePhone(oldP, newP, { apply: true });

    const rows = getDb().prepare(`SELECT phone FROM family_links WHERE owner_id = ?`).all(user.id) as {
      phone: string;
    }[];
    expect(rows.map((r) => r.phone)).toEqual([newP]);
  });

  it("leaves the family link in place and warns when the old number is in a Joyce family", () => {
    const { oldP, newP, user } = setup();
    createFamily(oldP);
    upsertFamilyLink(user.id, oldP);

    const plan = changePhone(oldP, newP, { apply: true });

    expect(plan.applied).toBe(true);
    expect(plan.warnings.join(" ")).toContain("Joyce");
    const rows = getDb().prepare(`SELECT phone FROM family_links WHERE owner_id = ?`).all(user.id) as {
      phone: string;
    }[];
    expect(rows.map((r) => r.phone)).toEqual([oldP]);
    expect(resolveOwnerByPhone(newP)).toBe(user.id);
  });

  it("refuses when the new number belongs to a different account, changing nothing", () => {
    const { oldP, newP, user } = setup();
    const other = findOrCreateUserByPhone(newP);
    appendWhatsAppMessage(user.id, oldP, "user", "hello");

    const plan = changePhone(oldP, newP, { apply: true });

    expect(plan.ok).toBe(false);
    expect(plan.applied).toBe(false);
    expect(resolveOwnerByPhone(oldP)).toBe(user.id);
    expect(resolveOwnerByPhone(newP)).toBe(other.id);
  });

  it("refuses to merge when the new number already has chat history", () => {
    const { oldP, newP, user } = setup();
    appendWhatsAppMessage(user.id, newP, "user", "stray");

    const plan = changePhone(oldP, newP, { apply: true });

    expect(plan.ok).toBe(false);
    expect(plan.problems.join(" ")).toContain("whatsapp_messages");
    expect(resolveOwnerByPhone(oldP)).toBe(user.id);
  });

  it("refuses an old number that isn't bound, and bad formats", () => {
    expect(changePhone(phone(), phone(), { apply: true }).ok).toBe(false);
    expect(changePhone("07845500432", phone(), { apply: false }).problems.join(" ")).toContain("country code");
    const p = phone();
    expect(changePhone(p, p, { apply: false }).problems.join(" ")).toContain("same");
  });

  it("is atomic: a failure part-way leaves every table untouched", () => {
    const { oldP, newP, user } = setup();
    appendWhatsAppMessage(user.id, oldP, "user", "hello");
    const db = getDb();
    db.exec(`CREATE TRIGGER _boom BEFORE UPDATE ON user_phone_numbers BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    try {
      expect(() => changePhone(oldP, newP, { apply: true })).toThrow("boom");
    } finally {
      db.exec(`DROP TRIGGER _boom`);
    }
    const rows = db.prepare(`SELECT phone FROM whatsapp_messages WHERE owner_id = ?`).all(user.id) as {
      phone: string;
    }[];
    expect(rows.map((r) => r.phone)).toEqual([oldP]);
  });
});

// A new feature that stores a phone number in its own table would otherwise be silently left on the
// old number after a move. Add the table to phoneChange.ts (or to the exemptions here, with a reason).
describe("phone-keyed tables", () => {
  it("are all handled by changePhone", () => {
    const db = getDb();
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
      .all() as { name: string }[];
    const withPhone = tables
      .filter((t) => (db.prepare(`PRAGMA table_info("${t.name}")`).all() as { name: string }[]).some((c) => c.name === "phone"))
      .map((t) => t.name);
    expect(withPhone.filter((t) => !CLASSIFIED_PHONE_TABLES.includes(t))).toEqual([]);
  });
});
