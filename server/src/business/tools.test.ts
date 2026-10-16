import { describe, it, expect } from "vitest";
import { findOrCreateUserByEmail, setUserEdition } from "../db/store.js";
import { runTool, buildToolsForOwner, buildSystemPrompt } from "../ai/assistant.js";
import { periodRange } from "./tools.js";
import { listLedgerEntries } from "./ledgerStore.js";

let n = 0;
const user = (edition: "general" | "business") => {
  const u = findOrCreateUserByEmail(`tools-${Date.now()}-${++n}@example.com`);
  setUserEdition(u.id, edition);
  return u.id;
};

describe("business tools", () => {
  it("are offered to business users only", () => {
    const has = (id: number) => buildToolsForOwner(id).some((t) => "name" in t && t.name === "log_expense");
    expect(has(user("business"))).toBe(true);
    expect(has(user("general"))).toBe(false);
  });

  it("refuse to run for a general user", async () => {
    const res = await runTool(user("general"), "log_income", { amount: 450, date: "2026-10-12", from: "Dave" });
    expect(res).toMatchObject({ error: expect.stringContaining("business") });
  });

  it("log_income and log_expense write confirmed entries; pounds in, pence stored", async () => {
    const id = user("business");
    await runTool(id, "log_income", { amount: 450, date: "2026-10-12", from: "Dave" });
    await runTool(id, "log_expense", {
      amount: 32.5,
      date: "2026-10-12",
      paid_to: "Shell",
      category: "car_van_travel",
      business_use: "business",
    });
    expect(listLedgerEntries(id).map((r) => [r.direction, r.amountPence, r.status])).toEqual([
      ["out", 3250, "confirmed"],
      ["in", 45000, "confirmed"],
    ]);
  });

  it("rejects a bad amount with an error the model can read", async () => {
    const res = await runTool(user("business"), "log_income", { amount: -5, date: "2026-10-12", from: "Dave" });
    expect(res).toMatchObject({ error: expect.any(String) });
  });

  it("remove_ledger_entry takes an entry out of the books", async () => {
    const id = user("business");
    const { entry } = (await runTool(id, "log_expense", {
      amount: 10,
      date: "2026-10-12",
      paid_to: "Tesco",
      business_use: "personal",
    })) as { entry: { id: number } };
    expect(await runTool(id, "remove_ledger_entry", { entry_id: entry.id })).toMatchObject({ ok: true });
    expect(listLedgerEntries(id)).toHaveLength(0);
  });

  it("confirm_ledger_entry confirms a reviewed entry", async () => {
    const id = user("business");
    const { entry } = (await runTool(id, "log_expense", { amount: 48.2, date: "2026-10-12", paid_to: "Screwfix" })) as {
      entry: { id: number; status: string };
    };
    expect(entry.status).toBe("needs_review");
    const res = await runTool(id, "confirm_ledger_entry", { entry_id: entry.id, business_use: "business", category: "repairs" });
    expect(res).toMatchObject({ ok: true, entry: { status: "confirmed" } });
  });

  it("get_money_summary reports pounds for the tax year", async () => {
    const id = user("business");
    await runTool(id, "log_income", { amount: 450, date: "2026-10-12", from: "Dave" });
    const res = (await runTool(id, "get_money_summary", { period: "tax_year", today: "2026-10-16" })) as { income: string };
    expect(res.income).toBe("£450.00");
  });

  it("set_business_profile shows up in the prompt", async () => {
    const id = user("business");
    await runTool(id, "set_business_profile", { description: "plumber in Leeds" });
    expect(buildSystemPrompt(id)).toContain("plumber in Leeds");
  });

  it("the prompt lists entries waiting for review", async () => {
    const id = user("business");
    await runTool(id, "log_expense", { amount: 48.2, date: "2026-10-12", paid_to: "Screwfix" });
    expect(buildSystemPrompt(id)).toMatch(/Screwfix.*£48\.20/);
  });
});

describe("periodRange", () => {
  it("this_week starts Monday", () => {
    expect(periodRange("this_week", "2026-10-16")).toEqual({ from: "2026-10-12", to: "2026-10-16" });
  });
  it("last_week is the previous Monday to Sunday", () => {
    expect(periodRange("last_week", "2026-10-16")).toEqual({ from: "2026-10-05", to: "2026-10-11" });
  });
  it("tax_year runs from 6 April", () => {
    expect(periodRange("tax_year", "2026-10-16")).toEqual({ from: "2026-04-06", to: "2026-10-16" });
  });
  it("last_tax_year is the whole previous year", () => {
    expect(periodRange("last_tax_year", "2026-10-16")).toEqual({ from: "2025-04-06", to: "2026-04-05" });
  });
});
