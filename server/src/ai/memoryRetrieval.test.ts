import { describe, it, expect } from "vitest";
import { retrieveRelevantMemory, mentionsName, RELEVANT_MEMORY_HEADER } from "./memoryRetrieval.js";
import {
  findOrCreateUserByEmail,
  findOrCreateEntity,
  addEntityAlias,
  addFact,
  forgetFacts,
  linkEntitiesOnce,
} from "../db/store.js";

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

describe("mentionsName", () => {
  it("matches whole words case-insensitively", () => {
    expect(mentionsName("is sam coming?", "Sam")).toBe(true);
    expect(mentionsName("my Samsung broke", "Sam")).toBe(false);
    expect(mentionsName("ask Sarah Jones", "sarah jones")).toBe(true);
  });

  it("treats regex metacharacters in names literally", () => {
    expect(() => mentionsName("anything", "C++ (Guild)")).not.toThrow();
    expect(mentionsName("meeting at C++ (Guild) today", "C++ (Guild)")).toBe(true);
    expect(mentionsName("Dr. Who is on", "Dr. Who")).toBe(true);
    expect(mentionsName("DrX Who is on", "Dr. Who")).toBe(false);
  });

  it("never matches a blank name", () => {
    expect(mentionsName("anything", "  ")).toBe(false);
  });
});

describe("retrieveRelevantMemory", () => {
  it("returns null when nothing matches", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("retrieve-none"));
    addFact(user.id, { content: "Likes jazz" });
    expect(retrieveRelevantMemory(user.id, "what's the weather")).toBeNull();
  });

  it("pulls a mentioned entity's facts (with ids) and its relations", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("retrieve-entity"));
    const sarah = findOrCreateEntity(user.id, "person", "Sarah");
    const acme = findOrCreateEntity(user.id, "organisation", "Acme");
    linkEntitiesOnce(user.id, sarah.id, "works_at", acme.id);
    const fact = addFact(user.id, { content: "Sarah is the user's accountant", entityId: sarah.id });

    const block = retrieveRelevantMemory(user.id, "can you email sarah about the invoice")!;

    expect(block.startsWith(RELEVANT_MEMORY_HEADER)).toBe(true);
    expect(block).toContain(`- [#${fact.id}] Sarah is the user's accountant`);
    expect(block).toContain("- Sarah —works_at→ Acme");
  });

  it("matches an entity by alias", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("retrieve-alias"));
    const anna = findOrCreateEntity(user.id, "person", "Anna");
    addEntityAlias(user.id, anna.id, "my wife");
    addFact(user.id, { content: "Anna is vegetarian", entityId: anna.id });
    expect(retrieveRelevantMemory(user.id, "book dinner for me and my wife")).toContain("Anna is vegetarian");
  });

  it("finds unlinked facts by keyword, skipping core, forgotten and other owners' facts", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("retrieve-fts"));
    const other = findOrCreateUserByEmail(uniqueEmail("retrieve-fts-other"));
    addFact(user.id, { content: "Allergic to shellfish" });
    addFact(user.id, { content: "Lives near the shellfish market", kind: "core" });
    const gone = addFact(user.id, { content: "Loves shellfish platters" });
    forgetFacts(user.id, [gone.id]);
    addFact(other.id, { content: "Other person's shellfish fact" });

    const block = retrieveRelevantMemory(user.id, "any good shellfish places?")!;

    expect(block).toContain("Allergic to shellfish");
    expect(block).not.toContain("market");
    expect(block).not.toContain("platters");
    expect(block).not.toContain("Other person");
  });

  it("caps output at 12 facts", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("retrieve-cap"));
    const bob = findOrCreateEntity(user.id, "person", "Bob");
    for (let i = 0; i < 20; i++) addFact(user.id, { content: `Bob fact number ${i} about tennis`, entityId: bob.id });
    const block = retrieveRelevantMemory(user.id, "tennis with Bob")!;
    expect(block.split("\n").filter((l) => l.startsWith("- [#")).length).toBeLessThanOrEqual(12);
  });

  it("returns null for blank text", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("retrieve-blank"));
    expect(retrieveRelevantMemory(user.id, "   ")).toBeNull();
  });
});
