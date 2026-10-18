import { describe, it, expect } from "vitest";
import { findOrCreateUserByEmail, deleteUserCompletely, findRemainingOwnerReferences } from "../db/store.js";
import {
  insertLedgerEntry,
  updateLedgerEntry,
  softDeleteLedgerEntry,
  listLedgerEntries,
  listLedgerHistory,
  summariseLedger,
  counterpartyKey,
  getCounterpartyChoice,
  rememberCounterpartyChoice,
  type NewLedgerEntry,
} from "./ledgerStore.js";

let n = 0;
const owner = () => findOrCreateUserByEmail(`ledger-${Date.now()}-${++n}@example.com`).id;
const out = (over: Partial<NewLedgerEntry> = {}): NewLedgerEntry => ({
  direction: "out",
  amountPence: 4820,
  occurredOn: "2026-10-10",
  counterparty: "Screwfix",
  category: "repairs",
  businessUse: "business",
  status: "confirmed",
  source: "chat",
  ...over,
});

describe("ledgerStore", () => {
  it("inserts and lists entries newest first", () => {
    const id = owner();
    insertLedgerEntry(id, out({ occurredOn: "2026-10-01" }));
    insertLedgerEntry(id, out({ occurredOn: "2026-10-05" }));
    expect(listLedgerEntries(id).map((e) => e.occurredOn)).toEqual(["2026-10-05", "2026-10-01"]);
  });

  it("rejects non-positive or fractional amounts and bad dates", () => {
    const id = owner();
    expect(() => insertLedgerEntry(id, out({ amountPence: 0 }))).toThrow();
    expect(() => insertLedgerEntry(id, out({ amountPence: 12.5 }))).toThrow();
    expect(() => insertLedgerEntry(id, out({ occurredOn: "10/10/2026" }))).toThrow();
  });

  it("dedupes on source + sourceRef and reports created=false", () => {
    const id = owner();
    const a = insertLedgerEntry(id, out({ source: "whatsapp_doc", sourceRef: "doc:1:0" }));
    const b = insertLedgerEntry(id, out({ source: "whatsapp_doc", sourceRef: "doc:1:0", amountPence: 999 }));
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.entry.id).toBe(a.entry.id);
    expect(listLedgerEntries(id)).toHaveLength(1);
  });

  it("entries without a sourceRef are never deduped", () => {
    const id = owner();
    insertLedgerEntry(id, out());
    insertLedgerEntry(id, out());
    expect(listLedgerEntries(id)).toHaveLength(2);
  });

  it("writes history on update and soft delete, and hides deleted rows", () => {
    const id = owner();
    const { entry } = insertLedgerEntry(id, out());
    updateLedgerEntry(id, entry.id, { category: "cost_of_goods" }, "user");
    softDeleteLedgerEntry(id, entry.id, "user");
    expect(listLedgerEntries(id)).toHaveLength(0);
    const history = listLedgerHistory(id, entry.id);
    expect(history).toHaveLength(2);
    expect((history[0].after as { category: string }).category).toBe("cost_of_goods");
    expect((history[1].after as { deletedAt: number | null }).deletedAt).not.toBeNull();
  });

  it("does not touch another owner's entry", () => {
    const a = owner();
    const b = owner();
    const { entry } = insertLedgerEntry(a, out());
    expect(updateLedgerEntry(b, entry.id, { category: "other" }, "user")).toBeNull();
    expect(softDeleteLedgerEntry(b, entry.id, "user")).toBeNull();
  });

  it("summary counts only confirmed, business, non-deleted entries in range", () => {
    const id = owner();
    insertLedgerEntry(id, out({ amountPence: 1000 }));
    insertLedgerEntry(id, out({ amountPence: 2000, category: "phone_office" }));
    insertLedgerEntry(id, out({ amountPence: 5000, businessUse: "personal" }));
    insertLedgerEntry(id, out({ amountPence: 7000, status: "needs_review" }));
    insertLedgerEntry(id, out({ amountPence: 9000, occurredOn: "2025-01-01" }));
    const gone = insertLedgerEntry(id, out({ amountPence: 3000 })).entry;
    softDeleteLedgerEntry(id, gone.id, "user");
    insertLedgerEntry(id, {
      direction: "in",
      amountPence: 45000,
      occurredOn: "2026-10-12",
      counterparty: "Dave",
      businessUse: "business",
      status: "confirmed",
      source: "chat",
    });
    expect(summariseLedger(id, "2026-04-06", "2027-04-05")).toEqual({
      incomePence: 45000,
      expensesPence: 3000,
      byCategory: { repairs: 1000, phone_office: 2000 },
      needsReviewCount: 1,
    });
  });

  it("normalises counterparty names for remembered choices", () => {
    expect(counterpartyKey("SCREWFIX LTD")).toBe("screwfix");
    expect(counterpartyKey(" Screwfix. ")).toBe("screwfix");
    expect(counterpartyKey("B&Q plc")).toBe("b q");
    const id = owner();
    rememberCounterpartyChoice(id, "Screwfix Limited", "repairs", "business");
    expect(getCounterpartyChoice(id, "SCREWFIX")).toEqual({ category: "repairs", businessUse: "business" });
    expect(getCounterpartyChoice(id, "Wickes")).toBeNull();
  });

  it("deleteUserCompletely removes every ledger row", () => {
    const id = owner();
    const { entry } = insertLedgerEntry(id, out());
    updateLedgerEntry(id, entry.id, { category: "other" }, "user");
    rememberCounterpartyChoice(id, "Screwfix", "repairs", "business");
    deleteUserCompletely(id);
    expect(findRemainingOwnerReferences(id)).toEqual([]);
  });
});
