import { describe, it, expect } from "vitest";
import { findOrCreateUserByEmail, setUserEdition } from "../db/store.js";
import { receiptToLedger } from "./receipts.js";
import { onReceiptSaved } from "../editions/index.js";
import { listLedgerEntries } from "./ledgerStore.js";

let n = 0;
const user = (edition: "general" | "business") => {
  const u = findOrCreateUserByEmail(`rcpt-${Date.now()}-${++n}@example.com`);
  setUserEdition(u.id, edition);
  return u.id;
};
const expense = (over: Record<string, unknown> = {}) => ({
  type: "expense" as const,
  status: "active",
  data: { vendor: "Screwfix", amountPence: 4820, currency: "GBP", date: "2026-10-10", ...over },
});
const noGuess = async () => null;

describe("receiptToLedger", () => {
  it("adds one needs-review entry per GBP expense, linked to the document", async () => {
    const id = user("business");
    const created = await receiptToLedger(
      id,
      { id: 501, source: "whatsapp" },
      [expense(), expense({ vendor: "Wickes", amountPence: 999 })],
      noGuess
    );
    expect(created).toBe(2);
    const rows = listLedgerEntries(id);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.documentId === 501 && r.source === "whatsapp_doc" && r.status === "needs_review")).toBe(true);
  });

  it("ignores derived bookings", async () => {
    const id = user("business");
    expect(await receiptToLedger(id, { id: 506, source: "whatsapp" }, [{ type: "booking", status: "active", data: {} }], noGuess)).toBe(0);
  });

  it("is idempotent for the same document", async () => {
    const id = user("business");
    await receiptToLedger(id, { id: 502, source: "whatsapp" }, [expense()], noGuess);
    expect(await receiptToLedger(id, { id: 502, source: "whatsapp" }, [expense()], noGuess)).toBe(0);
    expect(listLedgerEntries(id)).toHaveLength(1);
  });

  it("skips non-GBP expenses rather than storing them as pence", async () => {
    const id = user("business");
    expect(await receiptToLedger(id, { id: 503, source: "whatsapp" }, [expense({ currency: "EUR", amountPence: 1200 })], noGuess)).toBe(0);
    expect(listLedgerEntries(id)).toHaveLength(0);
  });

  it("marks email-sourced documents as email", async () => {
    const id = user("business");
    await receiptToLedger(id, { id: 504, source: "email" }, [expense()], noGuess);
    expect(listLedgerEntries(id)[0].source).toBe("email");
  });
});

describe("onReceiptSaved", () => {
  it("does nothing for general users", async () => {
    const id = user("general");
    await onReceiptSaved(id, { id: 505, source: "whatsapp" }, [expense()]);
    expect(listLedgerEntries(id)).toHaveLength(0);
  });
});
