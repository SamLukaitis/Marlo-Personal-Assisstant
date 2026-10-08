import { describe, it, expect } from "vitest";
import {
  findOrCreateUserByEmail,
  getAttentionItem,
  insertAttentionItem,
  updateAttentionItem,
  listAttentionItems,
  countCappedAttentionSentSince,
} from "./store.js";

let counter = 0;
function newOwner(): number {
  counter += 1;
  return findOrCreateUserByEmail(`attention-store-${Date.now()}-${counter}@example.com`).id;
}

const details = { summary: "Your *Hilton Lisbon* stay is confirmed for *12–15 Oct*." };

describe("attention_items store", () => {
  it("inserts and reads back an item by event key, with details round-tripped", () => {
    const ownerId = newOwner();
    const row = insertAttentionItem(ownerId, {
      eventKey: "ref:ABC123",
      source: "email",
      category: "reservation_confirmed",
      tier: "scheduled",
      status: "pending",
      details: { ...details, reference: "ABC123", kind: "hotel" },
      surfaceAt: 1_000,
    });
    const read = getAttentionItem(ownerId, "ref:ABC123");
    expect(read?.id).toBe(row.id);
    expect(read?.details.reference).toBe("ABC123");
    expect(read?.surfaceAt).toBe(1_000);
    expect(read?.acknowledgedAt).toBeNull();
  });

  it("scopes event keys per owner", () => {
    const a = newOwner();
    const b = newOwner();
    insertAttentionItem(a, { eventKey: "ref:SAME", source: "email", category: "x", tier: "brief", status: "pending", details, surfaceAt: null });
    expect(getAttentionItem(b, "ref:SAME")).toBeNull();
    expect(() =>
      insertAttentionItem(b, { eventKey: "ref:SAME", source: "email", category: "x", tier: "brief", status: "pending", details, surfaceAt: null })
    ).not.toThrow();
  });

  it("patches only the given fields and bumps updatedAt", () => {
    const ownerId = newOwner();
    const row = insertAttentionItem(ownerId, { eventKey: "k1", source: "email", category: "x", tier: "scheduled", status: "pending", details, surfaceAt: 5 });
    const updated = updateAttentionItem(ownerId, row.id, { status: "sent", sentAt: 42 });
    expect(updated.status).toBe("sent");
    expect(updated.sentAt).toBe(42);
    expect(updated.tier).toBe("scheduled");
    expect(updated.surfaceAt).toBe(5);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(row.updatedAt);
  });

  it("lists pending items due before a time, soonest first", () => {
    const ownerId = newOwner();
    insertAttentionItem(ownerId, { eventKey: "late", source: "email", category: "x", tier: "scheduled", status: "pending", details, surfaceAt: 300 });
    insertAttentionItem(ownerId, { eventKey: "early", source: "email", category: "x", tier: "scheduled", status: "pending", details, surfaceAt: 100 });
    insertAttentionItem(ownerId, { eventKey: "future", source: "email", category: "x", tier: "scheduled", status: "pending", details, surfaceAt: 900 });
    insertAttentionItem(ownerId, { eventKey: "done", source: "email", category: "x", tier: "scheduled", status: "sent", details, surfaceAt: 50 });
    const due = listAttentionItems(ownerId, { statuses: ["pending"], dueBefore: 500 });
    expect(due.map((r) => r.eventKey)).toEqual(["early", "late"]);
  });

  it("counts sent items since a time, excluding exempt categories", () => {
    const ownerId = newOwner();
    const a = insertAttentionItem(ownerId, { eventKey: "a", source: "email", category: "invoice_due", tier: "interrupt", status: "pending", details, surfaceAt: 1 });
    const b = insertAttentionItem(ownerId, { eventKey: "b", source: "email", category: "flight_change", tier: "interrupt", status: "pending", details, surfaceAt: 1 });
    const c = insertAttentionItem(ownerId, { eventKey: "c", source: "email", category: "reservation_confirmed", tier: "scheduled", status: "pending", details, surfaceAt: 1 });
    updateAttentionItem(ownerId, a.id, { status: "sent", sentAt: 1_000 });
    updateAttentionItem(ownerId, b.id, { status: "sent", sentAt: 1_000 });
    updateAttentionItem(ownerId, c.id, { status: "sent", sentAt: 10 }); // before the window
    expect(countCappedAttentionSentSince(ownerId, 500, ["flight_change", "security_alert"])).toBe(1);
  });
});
