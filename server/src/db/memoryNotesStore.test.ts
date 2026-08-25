import { describe, it, expect } from "vitest";
import { findOrCreateUserByEmail, addMemoryNote, listDueMemoryReminders, markMemorySurfaced } from "./store.js";

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
