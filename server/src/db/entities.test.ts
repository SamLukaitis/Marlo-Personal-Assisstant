import { describe, it, expect } from "vitest";
import {
  findOrCreateUserByEmail,
  saveDocument,
  saveEntity,
  getEntity,
  listEntities,
  updateEntity,
  linkRecords,
  getRelatedEntities,
} from "./store.js";

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

describe("generic entity + link store", () => {
  it("saves an entity, links it to a document, and reads it back via getRelatedEntities", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("entities-roundtrip"));

    const document = saveDocument(user.id, {
      phone: "447000000001",
      filename: "boarding-pass.pdf",
      mimeType: "application/pdf",
      storedPath: "/tmp/fake",
      caption: null,
      title: "Test boarding pass",
      extractedText: "some text",
      category: "travel",
    });

    const entity = saveEntity(user.id, {
      type: "travel_checkin",
      data: { country: "France", city: "Paris", checkedInAt: 1700000000000 },
      confidence: 0.9,
    });
    expect(entity.type).toBe("travel_checkin");
    expect(entity.data).toEqual({ country: "France", city: "Paris", checkedInAt: 1700000000000 });
    expect(entity.status).toBe("active");

    linkRecords(user.id, {
      relation: "extracted_from",
      from: { type: "entity", id: entity.id },
      to: { type: "document", id: document.id },
    });

    const related = getRelatedEntities(user.id, { type: "document", id: document.id });
    expect(related).toHaveLength(1);
    expect(related[0].id).toBe(entity.id);
    expect(related[0].data).toEqual(entity.data);
  });

  it("round-trips a fetched entity through getEntity and JSON.parses its data", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("entities-get"));
    const saved = saveEntity(user.id, { type: "expense", data: { vendor: "Acme", amountPence: 500 } });

    const fetched = getEntity(user.id, saved.id);
    expect(fetched?.data).toEqual({ vendor: "Acme", amountPence: 500 });
  });

  it("filters listEntities by type and status", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("entities-list"));
    saveEntity(user.id, { type: "expense", data: { vendor: "A" } });
    saveEntity(user.id, { type: "expense", data: { vendor: "B" }, status: "needs_review" });
    saveEntity(user.id, { type: "trip", data: { label: "London" } });

    const expenses = listEntities(user.id, { type: "expense" });
    expect(expenses).toHaveLength(2);
    expect(expenses.every((e) => e.type === "expense")).toBe(true);

    const needsReview = listEntities(user.id, { status: "needs_review" });
    expect(needsReview).toHaveLength(1);
    expect(needsReview[0].data).toEqual({ vendor: "B" });
  });

  it("updates an entity's data/status/confidence without touching the rest", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("entities-update"));
    const saved = saveEntity(user.id, { type: "expense", data: { vendor: "A" }, confidence: 0.5 });

    const updated = updateEntity(user.id, saved.id, { status: "archived" });
    expect(updated.status).toBe("archived");
    expect(updated.data).toEqual({ vendor: "A" });
    expect(updated.confidence).toBe(0.5);
  });

  it("scopes entities per owner — one user's entities are invisible to another", () => {
    const userA = findOrCreateUserByEmail(uniqueEmail("entities-owner-a"));
    const userB = findOrCreateUserByEmail(uniqueEmail("entities-owner-b"));
    const entity = saveEntity(userA.id, { type: "expense", data: { vendor: "A" } });

    expect(getEntity(userB.id, entity.id)).toBeNull();
    expect(listEntities(userB.id, { type: "expense" })).toHaveLength(0);
  });

  it("groups an expense, a booking, and a document under a trip via belongs_to/relates_to links", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("entities-trip"));

    const trip = saveEntity(user.id, {
      type: "trip",
      data: { label: "Lisbon, 12-15 Jun 2026", startDate: "2026-06-12", endDate: "2026-06-15" },
    });
    const expense = saveEntity(user.id, {
      type: "expense",
      data: { vendor: "Hotel Eva", amountPence: 1850, currency: "EUR", date: "2026-06-12" },
    });
    const document = saveDocument(user.id, {
      phone: "447000000002",
      filename: "boarding-pass.pdf",
      mimeType: "application/pdf",
      storedPath: "/tmp/fake",
      caption: null,
      title: "Boarding pass",
      extractedText: "some text",
      category: "travel",
    });

    linkRecords(user.id, {
      relation: "belongs_to",
      from: { type: "entity", id: expense.id },
      to: { type: "entity", id: trip.id },
    });
    linkRecords(user.id, {
      relation: "relates_to",
      from: { type: "document", id: document.id },
      to: { type: "entity", id: trip.id },
    });

    const related = getRelatedEntities(user.id, { type: "entity", id: trip.id });
    expect(related).toHaveLength(1);
    expect(related[0].id).toBe(expense.id);
  });
});
