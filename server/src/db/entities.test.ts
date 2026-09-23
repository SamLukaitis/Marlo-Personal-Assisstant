import { describe, it, expect } from "vitest";
import {
  findOrCreateUserByEmail,
  saveDocument,
  saveEntity,
  getEntity,
  listEntities,
  updateEntity,
  deleteEntity,
  linkRecords,
  getRelatedEntities,
  findOrCreateEntity,
  addEntityAlias,
  findEntityByName,
  listRememberedEntities,
  linkEntitiesOnce,
  listEntityRelations,
  isReservedEntityType,
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

  it("deleteEntity: removes the row and any links pointing at it", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("entities-delete"));
    const trip = saveEntity(user.id, { type: "trip", data: { label: "Lisbon" } });
    const expense = saveEntity(user.id, {
      type: "expense",
      data: { vendor: "Hotel Eva", amountPence: 1850, currency: "EUR", date: "2026-06-12" },
    });
    linkRecords(user.id, {
      relation: "belongs_to",
      from: { type: "entity", id: expense.id },
      to: { type: "entity", id: trip.id },
    });

    deleteEntity(user.id, expense.id);

    expect(getEntity(user.id, expense.id)).toBeNull();
    expect(getRelatedEntities(user.id, { type: "entity", id: trip.id })).toHaveLength(0);
  });

  it("deleteEntity: is owner-scoped — cannot delete another owner's entity", () => {
    const userA = findOrCreateUserByEmail(uniqueEmail("entities-delete-owner-a"));
    const userB = findOrCreateUserByEmail(uniqueEmail("entities-delete-owner-b"));
    const entity = saveEntity(userA.id, { type: "expense", data: { vendor: "A" } });

    deleteEntity(userB.id, entity.id);

    expect(getEntity(userA.id, entity.id)).not.toBeNull();
  });
});

describe("remember → entities bridge", () => {
  it("find-or-create: creates a new entity on first call", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("findorcreate-new"));
    const entity = findOrCreateEntity(user.id, "person", "Sarah");
    expect(entity.type).toBe("person");
    expect(entity.data).toEqual({ name: "Sarah", aliases: [] });
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

  it("addEntityAlias: adds a trimmed alias once, ignoring the name itself and duplicates", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("alias-add"));
    const entity = findOrCreateEntity(user.id, "person", "Sarah");
    addEntityAlias(user.id, entity.id, "  Sarah Jones ");
    addEntityAlias(user.id, entity.id, "sarah jones");
    const after = addEntityAlias(user.id, entity.id, "SARAH");
    expect(after.data.aliases).toEqual(["Sarah Jones"]);
  });

  it("findEntityByName: matches an alias, and findOrCreateEntity reuses the aliased entity", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("alias-find"));
    const entity = findOrCreateEntity(user.id, "person", "Sarah");
    addEntityAlias(user.id, entity.id, "Sarah Jones");
    expect(findEntityByName(user.id, "sarah jones")?.id).toBe(entity.id);
    expect(findOrCreateEntity(user.id, "person", "Sarah Jones").id).toBe(entity.id);
  });

  it("listRememberedEntities: lists only remembered entities with name and aliases", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("list-remembered"));
    saveEntity(user.id, {
      type: "booking",
      data: { kind: "hotel", name: "Hotel Eva", reference: "ABC", startDate: "2026-01-01", endDate: null },
    });
    const sarah = findOrCreateEntity(user.id, "person", "Sarah");
    expect(listRememberedEntities(user.id)).toEqual([
      { id: sarah.id, type: "person", name: "Sarah", aliases: [], updatedAt: sarah.updatedAt },
    ]);
  });

  it("linkEntitiesOnce: creates a labelled link once and never a self-link", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("link-once"));
    const sarah = findOrCreateEntity(user.id, "person", "Sarah");
    const acme = findOrCreateEntity(user.id, "organisation", "Acme");
    expect(linkEntitiesOnce(user.id, sarah.id, "works_at", acme.id)).toBe(true);
    expect(linkEntitiesOnce(user.id, sarah.id, "works_at", acme.id)).toBe(false);
    expect(linkEntitiesOnce(user.id, sarah.id, "works_at", sarah.id)).toBe(false);

    expect(listEntityRelations(user.id, sarah.id)).toEqual([
      { relation: "works_at", direction: "out", entity: { id: acme.id, type: "organisation", name: "Acme" } },
    ]);
    expect(listEntityRelations(user.id, acme.id)).toEqual([
      { relation: "works_at", direction: "in", entity: { id: sarah.id, type: "person", name: "Sarah" } },
    ]);
  });

  it("listEntityRelations: skips links to non-remembered entities", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("relations-skip"));
    const sarah = findOrCreateEntity(user.id, "person", "Sarah");
    const trip = saveEntity(user.id, { type: "trip", data: { name: "Lisbon trip" } });
    linkRecords(user.id, { relation: "belongs_to", from: { type: "entity", id: sarah.id }, to: { type: "entity", id: trip.id } });
    expect(listEntityRelations(user.id, sarah.id)).toEqual([]);
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

  it("findEntityByName: ignores a same-owner entity with no name field at all, without throwing", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("find-by-name-no-name-field"));
    saveEntity(user.id, {
      type: "travel_checkin",
      data: { country: "France", city: "Paris", checkedInAt: Date.now() },
    });
    const sarah = findOrCreateEntity(user.id, "person", "Sarah");

    expect(() => findEntityByName(user.id, "Sarah")).not.toThrow();
    expect(findEntityByName(user.id, "Sarah")?.id).toBe(sarah.id);
    expect(findEntityByName(user.id, "France")).toBeNull();
  });

  it("findEntityByName: never returns a booking, even though it structurally has a name string", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("find-by-name-booking"));
    saveEntity(user.id, {
      type: "booking",
      data: { kind: "hotel", name: "Hotel Eva", reference: "ABC", startDate: "2026-01-01", endDate: null },
    });
    findOrCreateEntity(user.id, "person", "Sarah");

    expect(findEntityByName(user.id, "Hotel Eva")).toBeNull();
  });

  it("find-or-create: rejects a blank or whitespace-only name", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("findorcreate-blank"));
    expect(() => findOrCreateEntity(user.id, "person", "")).toThrow();
    expect(() => findOrCreateEntity(user.id, "person", "   ")).toThrow();
  });

  it("findEntityByName: returns null (not a throw, not a false match) for a blank name", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("find-by-name-blank"));
    findOrCreateEntity(user.id, "person", "Sarah");
    expect(findEntityByName(user.id, "")).toBeNull();
    expect(findEntityByName(user.id, "   ")).toBeNull();
  });

  it("find-or-create: normalises type (trim+lowercase) so 'Person' and 'person ' resolve to the same entity", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("findorcreate-type-normalise"));
    const first = findOrCreateEntity(user.id, "Person", "Sarah");
    const second = findOrCreateEntity(user.id, "person ", "Sarah");
    expect(second.id).toBe(first.id);
    expect(first.type).toBe("person");
    expect(listEntities(user.id, { type: "person" })).toHaveLength(1);
  });

  it("isReservedEntityType: true (case/whitespace-insensitive) for types owned by other pipelines", () => {
    expect(isReservedEntityType("Booking")).toBe(true);
    expect(isReservedEntityType(" expense ")).toBe(true);
    expect(isReservedEntityType("travel_checkin")).toBe(true);
    expect(isReservedEntityType("trip")).toBe(true);
    expect(isReservedEntityType("important_email")).toBe(true);
    expect(isReservedEntityType("person")).toBe(false);
  });

  it("find-or-create: throws for a reserved entity type", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("findorcreate-reserved"));
    expect(() => findOrCreateEntity(user.id, "booking", "Hilton")).toThrow(/reserved entity type/);
  });
});
