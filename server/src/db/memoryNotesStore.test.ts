import { describe, it, expect } from "vitest";
import {
  findOrCreateUserByEmail,
  addMemoryNote,
  listDueMemoryReminders,
  markMemorySurfaced,
  removeMemoryNote,
  searchMemoryNotes,
} from "./store.js";

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

describe("addMemoryNote — triggerAt handling", () => {
  it("stores no trigger when triggerAt is omitted", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("no-trigger"));
    const note = addMemoryNote(user.id, "The Acme account is my priority business");
    expect(note.triggerAt).toBeNull();
    expect(note.lastSurfacedAt).toBeNull();
  });

  it("parses a valid ISO date into an epoch timestamp", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("valid-trigger"));
    const note = addMemoryNote(user.id, "Visa expires soon", "2026-09-12T00:00:00Z");
    expect(note.triggerAt).toBe(new Date("2026-09-12T00:00:00Z").getTime());
  });

  it("falls back to no trigger for an unparseable date instead of throwing", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("bad-trigger"));
    const note = addMemoryNote(user.id, "Some fact", "not a real date");
    expect(note.triggerAt).toBeNull();
  });
});

describe("listDueMemoryReminders", () => {
  it("returns a note whose trigger time has passed and hasn't been surfaced yet", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("due-basic"));
    const past = new Date(Date.now() - 60_000).toISOString();
    addMemoryNote(user.id, "Overdue reminder", past);

    const due = listDueMemoryReminders(user.id, Date.now());
    expect(due).toHaveLength(1);
    expect(due[0].content).toBe("Overdue reminder");
  });

  it("excludes notes whose trigger time is in the future", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("due-future"));
    const future = new Date(Date.now() + 60_000).toISOString();
    addMemoryNote(user.id, "Not yet due", future);

    const due = listDueMemoryReminders(user.id, Date.now());
    expect(due).toHaveLength(0);
  });

  it("excludes notes that have already been surfaced", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("due-surfaced"));
    const past = new Date(Date.now() - 60_000).toISOString();
    const note = addMemoryNote(user.id, "Already handled", past);
    markMemorySurfaced(user.id, note.id);

    const due = listDueMemoryReminders(user.id, Date.now());
    expect(due).toHaveLength(0);
  });

  it("excludes notes whose trigger time is more than 24 hours in the past (permanently-failing sends stop blocking later reminders)", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("due-stale"));
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    addMemoryNote(user.id, "Stuck reminder", stale);

    const due = listDueMemoryReminders(user.id, Date.now());
    expect(due).toHaveLength(0);
  });

  it("excludes ordinary notes with no trigger at all", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("due-notrigger"));
    addMemoryNote(user.id, "Just a fact, no deadline");

    const due = listDueMemoryReminders(user.id, Date.now());
    expect(due).toHaveLength(0);
  });

  it("scopes results by owner", () => {
    const userA = findOrCreateUserByEmail(uniqueEmail("due-owner-a"));
    const userB = findOrCreateUserByEmail(uniqueEmail("due-owner-b"));
    const past = new Date(Date.now() - 60_000).toISOString();
    addMemoryNote(userA.id, "A's reminder", past);

    expect(listDueMemoryReminders(userB.id, Date.now())).toHaveLength(0);
  });
});

describe("searchMemoryNotes", () => {
  it("finds a note containing the query term", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("search-basic"));
    addMemoryNote(user.id, "Allergic to shellfish");
    addMemoryNote(user.id, "Prefers window seats on flights");

    const results = searchMemoryNotes(user.id, "shellfish");
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("Allergic to shellfish");
  });

  it("requires all query terms to match (AND semantics)", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("search-and"));
    addMemoryNote(user.id, "Allergic to shellfish");
    addMemoryNote(user.id, "Allergic to peanuts");

    const results = searchMemoryNotes(user.id, "allergic shellfish");
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("Allergic to shellfish");
  });

  it("returns no results when nothing matches", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("search-none"));
    addMemoryNote(user.id, "Prefers window seats on flights");

    expect(searchMemoryNotes(user.id, "shellfish")).toHaveLength(0);
  });

  it("scopes results to the owner", () => {
    const userA = findOrCreateUserByEmail(uniqueEmail("search-owner-a"));
    const userB = findOrCreateUserByEmail(uniqueEmail("search-owner-b"));
    addMemoryNote(userA.id, "Allergic to shellfish");

    expect(searchMemoryNotes(userB.id, "shellfish")).toHaveLength(0);
  });

  it("no longer matches a note after it's removed", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("search-removed"));
    const note = addMemoryNote(user.id, "Allergic to shellfish");

    removeMemoryNote(user.id, note.id);

    expect(searchMemoryNotes(user.id, "shellfish")).toHaveLength(0);
  });

  it("doesn't throw on FTS special characters in the query", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("search-special"));
    addMemoryNote(user.id, "Visa expires 2026-09-12");

    expect(() => searchMemoryNotes(user.id, '"quoted" OR NOT * weird:query')).not.toThrow();
  });

  it("returns an empty array for a blank query instead of matching everything", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("search-blank"));
    addMemoryNote(user.id, "Allergic to shellfish");

    expect(searchMemoryNotes(user.id, "   ")).toHaveLength(0);
  });

  it("respects the limit parameter", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("search-limit"));
    addMemoryNote(user.id, "Trip note alpha");
    addMemoryNote(user.id, "Trip note beta");
    addMemoryNote(user.id, "Trip note gamma");

    expect(searchMemoryNotes(user.id, "trip", 2)).toHaveLength(2);
  });
});
