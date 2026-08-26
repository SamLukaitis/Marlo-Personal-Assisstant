import { describe, it, expect, vi } from "vitest";
import {
  setPendingInvoiceForward,
  getPendingInvoiceForward,
  clearPendingInvoiceForward,
} from "./xeroInvoiceConfirmation.js";
import { findOrCreateUserByEmail } from "../db/store.js";

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

describe("pending Xero invoice forward", () => {
  it("returns null when nothing is pending", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("invoice-pending-none"));
    expect(getPendingInvoiceForward(user.id)).toBeNull();
  });

  it("round-trips what was set", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("invoice-pending-set"));
    setPendingInvoiceForward(user.id, { accountId: 7, messageId: "m123", subject: "Invoice from Acme" });
    const pending = getPendingInvoiceForward(user.id);
    expect(pending).toMatchObject({ accountId: 7, messageId: "m123", subject: "Invoice from Acme" });
  });

  it("is cleared after clearPendingInvoiceForward", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("invoice-pending-clear"));
    setPendingInvoiceForward(user.id, { accountId: 1, messageId: "m1", subject: "X" });
    clearPendingInvoiceForward(user.id);
    expect(getPendingInvoiceForward(user.id)).toBeNull();
  });

  it("expires after 24 hours so a much-later reply isn't mistaken for a confirmation", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("invoice-pending-stale"));
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      setPendingInvoiceForward(user.id, { accountId: 1, messageId: "m1", subject: "X" });
      vi.setSystemTime(new Date("2026-01-02T01:00:00Z")); // 25 hours later
      expect(getPendingInvoiceForward(user.id)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("scopes pending state by owner", () => {
    const a = findOrCreateUserByEmail(uniqueEmail("invoice-pending-owner-a"));
    const b = findOrCreateUserByEmail(uniqueEmail("invoice-pending-owner-b"));
    setPendingInvoiceForward(a.id, { accountId: 1, messageId: "m1", subject: "X" });
    expect(getPendingInvoiceForward(b.id)).toBeNull();
  });
});
