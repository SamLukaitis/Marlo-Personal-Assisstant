import { describe, it, expect, vi } from "vitest";
import { findOrCreateUserByEmail } from "../db/store.js";
import { recordExpense, recordIncome, confirmEntry } from "./ledger.js";
import { getCounterpartyChoice, rememberCounterpartyChoice } from "./ledgerStore.js";

let n = 0;
const owner = () => findOrCreateUserByEmail(`rules-${Date.now()}-${++n}@example.com`).id;
const base = { amountPence: 4820, occurredOn: "2026-10-10", counterparty: "Screwfix", source: "whatsapp_doc" as const };

describe("recordExpense", () => {
  it("a category the user stated is confirmed and remembered", async () => {
    const id = owner();
    const guess = vi.fn();
    const { entry } = await recordExpense(id, { ...base, source: "chat", category: "repairs", businessUse: "business" }, guess);
    expect(entry.status).toBe("confirmed");
    expect(guess).not.toHaveBeenCalled();
    expect(getCounterpartyChoice(id, "SCREWFIX LTD")).toEqual({ category: "repairs", businessUse: "business" });
  });

  it("a remembered counterparty is confirmed without asking the model", async () => {
    const id = owner();
    rememberCounterpartyChoice(id, "Screwfix", "repairs", "business");
    const guess = vi.fn();
    const { entry } = await recordExpense(id, base, guess);
    expect(entry).toMatchObject({ status: "confirmed", category: "repairs", businessUse: "business" });
    expect(guess).not.toHaveBeenCalled();
  });

  it("a model guess is stored but needs review", async () => {
    const id = owner();
    const { entry } = await recordExpense(id, base, async () => ({ category: "repairs", businessUse: "business" }));
    expect(entry).toMatchObject({ status: "needs_review", category: "repairs", businessUse: "business" });
  });

  it("no guess at all still records the entry for review", async () => {
    const id = owner();
    const { entry } = await recordExpense(id, base, async () => null);
    expect(entry).toMatchObject({ status: "needs_review", category: null, businessUse: "unsure" });
  });

  it("a failing guesser does not lose the entry", async () => {
    const id = owner();
    const { entry } = await recordExpense(id, base, async () => {
      throw new Error("api down");
    });
    expect(entry.status).toBe("needs_review");
  });
});

describe("recordIncome", () => {
  it("income told in chat is confirmed", () => {
    const { entry } = recordIncome(owner(), { amountPence: 45000, occurredOn: "2026-10-12", counterparty: "Dave", source: "chat" });
    expect(entry.status).toBe("confirmed");
  });
  it("income spotted in email needs review", () => {
    const { entry } = recordIncome(owner(), {
      amountPence: 45000,
      occurredOn: "2026-10-12",
      counterparty: "Stripe",
      source: "email",
      sourceRef: "email:1:abc",
    });
    expect(entry.status).toBe("needs_review");
  });
});

describe("confirmEntry", () => {
  it("confirms, applies the choice and remembers the counterparty", async () => {
    const id = owner();
    const { entry } = await recordExpense(id, base, async () => ({ category: "repairs", businessUse: "business" }));
    const confirmed = confirmEntry(id, entry.id, { category: "cost_of_goods" });
    expect(confirmed).toMatchObject({ status: "confirmed", category: "cost_of_goods", businessUse: "business" });
    expect(getCounterpartyChoice(id, "Screwfix")?.category).toBe("cost_of_goods");
  });
  it("can mark an entry personal", async () => {
    const id = owner();
    const { entry } = await recordExpense(id, base, async () => null);
    expect(confirmEntry(id, entry.id, { businessUse: "personal" })).toMatchObject({ status: "confirmed", businessUse: "personal" });
  });
  it("an unsure entry can't be confirmed without a business/personal answer", async () => {
    const id = owner();
    const { entry } = await recordExpense(id, base, async () => null);
    expect(() => confirmEntry(id, entry.id, { category: "repairs" })).toThrow(/business or personal/);
  });
});
