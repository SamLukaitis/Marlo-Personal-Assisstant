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
  findOrCreateEntity,
  appendEntityNote,
  findEntityByName,
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

describe("remember → entities bridge", () => {
  it("find-or-create: creates a new entity on first call", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("findorcreate-new"));
    const entity = findOrCreateEntity(user.id, "person", "Sarah");
    expect(entity.type).toBe("person");
    expect(entity.data).toEqual({ name: "Sarah", notes: [] });
  });

  it("find-or-create: dedupes by owner+type+lowercased name, ignoring case/whitespace", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("findorcreate-dedupe"));
    const first = findOrCreateEntity(user.id, "person", "Sarah");
    const second = findOrCreateEntity(user.id, "person", "  sarah ");
    expect(second.id).toBe(first.id);
    expect(listEntities(user.id, { type: "person" })).toHaveLength(1);
  });

  it("find-or-create: same name under a different type is a different entity", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("findorcreate-difftype"));
    const person = findOrCreateEntity(user.id, "person", "Lisbon");
    const place = findOrCreateEntity(user.id, "place", "Lisbon");
    expect(person.id).not.toBe(place.id);
  });

  it("find-or-create: scopes by owner — one user's entity is invisible to another", () => {
    const userA = findOrCreateUserByEmail(uniqueEmail("findorcreate-owner-a"));
    const userB = findOrCreateUserByEmail(uniqueEmail("findorcreate-owner-b"));
    const a = findOrCreateEntity(userA.id, "person", "Sarah");
    const b = findOrCreateEntity(userB.id, "person", "Sarah");
    expect(b.id).not.toBe(a.id);
  });

  it("appendEntityNote: appends a timestamped note without clobbering prior ones", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("append-note"));
    const entity = findOrCreateEntity(user.id, "person", "Sarah");
    const afterFirst = appendEntityNote(user.id, entity.id, "Handles invoicing");
    expect(afterFirst.data.notes).toHaveLength(1);
    expect(afterFirst.data.notes[0].text).toBe("Handles invoicing");
    expect(typeof afterFirst.data.notes[0].at).toBe("number");

    const afterSecond = appendEntityNote(user.id, entity.id, "Prefers email over calls");
    expect(afterSecond.data.notes).toHaveLength(2);
    expect(afterSecond.data.notes[0].text).toBe("Handles invoicing");
    expect(afterSecond.data.notes[1].text).toBe("Prefers email over calls");
  });

  it("findEntityByName: matches case-insensitively and trims whitespace", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("find-by-name"));
    const entity = findOrCreateEntity(user.id, "person", "Sarah");
    const found = findEntityByName(user.id, "  SARAH  ");
    expect(found?.id).toBe(entity.id);
  });

  it("findEntityByName: respects an optional type filter", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("find-by-name-type"));
    findOrCreateEntity(user.id, "person", "Lisbon");
    const place = findOrCreateEntity(user.id, "place", "Lisbon");
    expect(findEntityByName(user.id, "Lisbon", "place")?.id).toBe(place.id);
    expect(findEntityByName(user.id, "Lisbon", "project")).toBeNull();
  });

  it("findEntityByName: returns null when nothing matches", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("find-by-name-miss"));
    expect(findEntityByName(user.id, "Nobody")).toBeNull();
  });
});
