import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import path from "node:path";
import {
  findOrCreateUserByEmail,
  addFact,
  addMemoryNote,
  forgetFacts,
  listRecentlyForgottenFacts,
  listCoreProfile,
  listActiveFactsForEntity,
  listNewestActiveFacts,
  searchActiveFacts,
  searchMemoryNotes,
  listMemoryNotes,
  findOrCreateEntity,
} from "./store.js";

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

describe("addFact", () => {
  it("defaults to kind fact, source told, no entity", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("fact-defaults"));
    const fact = addFact(user.id, { content: "Likes oat milk" });
    expect(fact).toMatchObject({ content: "Likes oat milk", kind: "fact", source: "told", entityId: null });
  });

  it("addMemoryNote rows read back with the same defaults", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("fact-legacy-defaults"));
    const note = addMemoryNote(user.id, "Legacy note");
    expect(note).toMatchObject({ kind: "fact", source: "told", entityId: null });
  });

  it("supersedes an active fact of the same owner, hiding it from every active read", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("fact-supersede"));
    const old = addFact(user.id, { content: "Lives in Paris", kind: "core" });
    const next = addFact(user.id, { content: "Lives in London", kind: "core", supersedesId: old.id });

    expect(listCoreProfile(user.id).map((f) => f.id)).toEqual([next.id]);
    expect(searchActiveFacts(user.id, "Paris")).toEqual([]);
    expect(listMemoryNotes(user.id).map((f) => f.id)).toEqual([next.id]);
  });

  it("ignores supersedesId pointing at another owner's fact", () => {
    const owner = findOrCreateUserByEmail(uniqueEmail("fact-supersede-owner"));
    const intruder = findOrCreateUserByEmail(uniqueEmail("fact-supersede-intruder"));
    const theirs = addFact(owner.id, { content: "Owner fact" });

    addFact(intruder.id, { content: "Intruder fact", supersedesId: theirs.id });

    expect(listMemoryNotes(owner.id).map((f) => f.id)).toEqual([theirs.id]);
  });
});

describe("forgetFacts", () => {
  it("soft-deletes only this owner's active facts and reports which ids changed", () => {
    const owner = findOrCreateUserByEmail(uniqueEmail("forget-owner"));
    const other = findOrCreateUserByEmail(uniqueEmail("forget-other"));
    const mine = addFact(owner.id, { content: "Allergic to shellfish" });
    const theirs = addFact(other.id, { content: "Allergic to peanuts" });

    expect(forgetFacts(owner.id, [mine.id, theirs.id, 999_999])).toEqual([mine.id]);
    expect(searchMemoryNotes(owner.id, "shellfish")).toEqual([]);
    expect(listMemoryNotes(other.id).map((f) => f.id)).toEqual([theirs.id]);
    // Forgetting twice is a no-op, not an error.
    expect(forgetFacts(owner.id, [mine.id])).toEqual([]);
  });
});

describe("listRecentlyForgottenFacts", () => {
  it("lists this owner's forgotten facts since a time, newest first", () => {
    const owner = findOrCreateUserByEmail(uniqueEmail("forgotten-list"));
    const other = findOrCreateUserByEmail(uniqueEmail("forgotten-list-other"));
    const a = addFact(owner.id, { content: "A" });
    const b = addFact(owner.id, { content: "B" });
    addFact(owner.id, { content: "Still active" });
    const theirs = addFact(other.id, { content: "Theirs" });
    forgetFacts(owner.id, [a.id]);
    forgetFacts(owner.id, [b.id]);
    forgetFacts(other.id, [theirs.id]);

    expect(listRecentlyForgottenFacts(owner.id, 0).map((f) => f.id)).toEqual([b.id, a.id]);
    expect(listRecentlyForgottenFacts(owner.id, 0, 1).map((f) => f.id)).toEqual([b.id]);
    expect(listRecentlyForgottenFacts(owner.id, Date.now() + 60_000)).toEqual([]);
  });
});

describe("listCoreProfile", () => {
  it("returns only active core facts, oldest first, keeping the newest `limit`", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("core-profile"));
    addFact(user.id, { content: "Not core" });
    const a = addFact(user.id, { content: "Name is Sam", kind: "core" });
    const b = addFact(user.id, { content: "Partner is Anna", kind: "core" });
    const c = addFact(user.id, { content: "Works at Acme", kind: "core" });

    expect(listCoreProfile(user.id).map((f) => f.id)).toEqual([a.id, b.id, c.id]);
    expect(listCoreProfile(user.id, 2).map((f) => f.id)).toEqual([b.id, c.id]);
  });
});

describe("listActiveFactsForEntity / listNewestActiveFacts", () => {
  it("scopes to one entity, newest first", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("entity-facts"));
    const sarah = findOrCreateEntity(user.id, "person", "Sarah");
    const f1 = addFact(user.id, { content: "Sarah handles invoicing", entityId: sarah.id });
    addFact(user.id, { content: "Unrelated" });
    const f2 = addFact(user.id, { content: "Sarah prefers email", entityId: sarah.id });

    expect(listActiveFactsForEntity(user.id, sarah.id).map((f) => f.id)).toEqual([f2.id, f1.id]);
  });

  it("listNewestActiveFacts can exclude core", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("newest-facts"));
    addFact(user.id, { content: "Name is Sam", kind: "core" });
    const f = addFact(user.id, { content: "Likes jazz", kind: "preference" });
    expect(listNewestActiveFacts(user.id, { excludeCore: true }).map((r) => r.id)).toEqual([f.id]);
  });
});

describe("searchActiveFacts", () => {
  it("mode all requires every term; mode any matches any term and drops stopwords", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("search-modes"));
    const shell = addFact(user.id, { content: "Allergic to shellfish" });
    const seats = addFact(user.id, { content: "Prefers window seats" });

    expect(searchActiveFacts(user.id, "shellfish seats", { mode: "all" })).toEqual([]);
    expect(
      searchActiveFacts(user.id, "what about the shellfish and seats", { mode: "any" })
        .map((f) => f.id)
        .sort()
    ).toEqual([shell.id, seats.id].sort());
  });

  it("excludeIds drops exactly those facts; a query of only stopwords returns nothing", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("search-exclude"));
    const shown = addFact(user.id, { content: "Lives in Lisbon", kind: "core" });
    const older = addFact(user.id, { content: "Born in Lisbon", kind: "core" });
    expect(searchActiveFacts(user.id, "Lisbon", { mode: "any", excludeIds: [shown.id] }).map((f) => f.id)).toEqual([
      older.id,
    ]);
    expect(searchActiveFacts(user.id, "the and of", { mode: "any" })).toEqual([]);
  });
});

describe("legacy reminder rows stay out of the assistant-facing fact reads", () => {
  it("a note with a trigger is not a fact", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("reminder-rows"));
    const reminder = addMemoryNote(user.id, "Dentist crown appointment", new Date(Date.now() + 86_400_000).toISOString());
    const sarah = findOrCreateEntity(user.id, "person", "Sarah");
    // No write path sets kind/entity on a reminder row; force them so every read's filter is exercised.
    const raw = new Database(path.join(process.env.DATA_DIR!, "app.db"));
    raw.prepare(`UPDATE memory_notes SET kind = 'core', entity_id = ? WHERE id = ?`).run(sarah.id, reminder.id);
    raw.close();

    expect(listCoreProfile(user.id)).toEqual([]);
    expect(listActiveFactsForEntity(user.id, sarah.id)).toEqual([]);
    expect(listNewestActiveFacts(user.id)).toEqual([]);
    expect(searchActiveFacts(user.id, "dentist", { mode: "any" })).toEqual([]);
    // The Setup page still lists it.
    expect(listMemoryNotes(user.id).map((f) => f.id)).toEqual([reminder.id]);
  });

  it("never returns another owner's facts", () => {
    const a = findOrCreateUserByEmail(uniqueEmail("search-owner-a"));
    const b = findOrCreateUserByEmail(uniqueEmail("search-owner-b"));
    addFact(a.id, { content: "Secret zebra fact" });
    expect(searchActiveFacts(b.id, "zebra", { mode: "any" })).toEqual([]);
  });
});
