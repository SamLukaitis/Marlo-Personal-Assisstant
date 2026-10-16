import { describe, it, expect } from "vitest";
import { findOrCreateUserByEmail, setUserEdition } from "../db/store.js";
import { detectIncome, incomeFromMail } from "./incomeDetector.js";
import { onAutomatedMail } from "../editions/index.js";
import { listLedgerEntries } from "./ledgerStore.js";

const mail = (from: string, subject: string, snippet = "") => ({ from, subject, snippet, receivedAt: "2026-10-12T09:00:00Z" });

describe("detectIncome", () => {
  it("Stripe payout with the amount in the subject", () => {
    expect(detectIncome(mail("Stripe <notifications@stripe.com>", "Your £1,240.50 payout is on the way"))).toEqual({
      amountPence: 124050,
      counterparty: "Stripe",
      occurredOn: "2026-10-12",
    });
  });

  it("SumUp payout with the amount in the body", () => {
    expect(detectIncome(mail("SumUp <no-reply@sumup.com>", "Payout sent", "We've sent £86.00 to your bank account"))?.amountPence).toBe(8600);
  });

  it("PayPal money received names the payer", () => {
    expect(detectIncome(mail("PayPal <service@paypal.co.uk>", "You've got money", "Dave Smith sent you £450.00 GBP"))).toMatchObject({
      amountPence: 45000,
      counterparty: "Dave Smith",
    });
  });

  it("an invoice marked paid", () => {
    expect(detectIncome(mail("Xero <messaging@xero.com>", "Invoice INV-0042 has been paid", "Acme Ltd paid £300.00"))?.amountPence).toBe(30000);
  });

  it("remittance advice", () => {
    expect(
      detectIncome(mail("accounts@acme.co.uk", "Remittance advice", "Payment of £300.00 has been made to your account"))?.amountPence
    ).toBe(30000);
  });

  it.each([
    ["money the user paid", mail("PayPal <service@paypal.co.uk>", "Receipt for your payment to Screwfix", "You paid £48.20")],
    ["a refund", mail("Amazon <auto@amazon.co.uk>", "Your refund of £12.00 has been processed")],
    ["a payout with no amount", mail("Stripe <notifications@stripe.com>", "Your payout is on the way", "no amount here")],
    ["money the user sent", mail("bank@example.com", "You sent £50.00 to Dave")],
    ["an ordinary invoice due", mail("billing@ee.co.uk", "Your bill is ready", "Your bill of £32.00 is due on 1 Nov")],
  ])("ignores %s", (_label, m) => {
    expect(detectIncome(m)).toBeNull();
  });
});

describe("incomeFromMail / onAutomatedMail", () => {
  let n = 0;
  const user = (edition: "general" | "business") => {
    const u = findOrCreateUserByEmail(`inc-${Date.now()}-${++n}@example.com`);
    setUserEdition(u.id, edition);
    return u.id;
  };
  const msg = { accountId: 1, id: "m1", ...mail("Stripe <notifications@stripe.com>", "Your £100.00 payout is on the way") };

  it("logs detected income for review, once per message", () => {
    const id = user("business");
    expect(incomeFromMail(id, [msg])).toBe(1);
    expect(incomeFromMail(id, [msg])).toBe(0);
    expect(listLedgerEntries(id)).toEqual([
      expect.objectContaining({ direction: "in", amountPence: 10000, status: "needs_review", source: "email", sourceRef: "email:1:m1" }),
    ]);
  });

  it("does nothing for general users", () => {
    const id = user("general");
    onAutomatedMail(id, [msg]);
    expect(listLedgerEntries(id)).toHaveLength(0);
  });

  it("business users get the entry through the hook", () => {
    const id = user("business");
    onAutomatedMail(id, [msg]);
    expect(listLedgerEntries(id)).toHaveLength(1);
  });
});
