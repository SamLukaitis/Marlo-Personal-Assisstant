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
});
