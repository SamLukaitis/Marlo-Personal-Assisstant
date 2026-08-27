import { describe, it, expect } from "vitest";
import {
  findOrCreateUserByEmail,
  createPendingAction,
  consumePendingAction,
  deleteExpiredPendingActions,
} from "./store.js";

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

describe("pending_actions", () => {
  it("creates a row and consumes it exactly once", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("consume-once"));
    const id = createPendingAction(user.id, "confirm", "Archive 3 emails?", JSON.stringify({ tool: "archive_messages", input: {} }));

    const row = consumePendingAction(id, user.id);
    expect(row).toEqual({
      id,
      ownerId: user.id,
      mode: "confirm",
      question: "Archive 3 emails?",
      contextJson: JSON.stringify({ tool: "archive_messages", input: {} }),
    });

    expect(consumePendingAction(id, user.id)).toBeNull();
  });

  it("rejects consumption by a different owner", () => {
    const owner = findOrCreateUserByEmail(uniqueEmail("real-owner"));
    const stranger = findOrCreateUserByEmail(uniqueEmail("stranger"));
    const id = createPendingAction(owner.id, "resume", "Which one?", JSON.stringify({ options: ["A", "B"] }));

    expect(consumePendingAction(id, stranger.id)).toBeNull();
    // Still consumable by the real owner afterward — the failed attempt didn't burn it.
    expect(consumePendingAction(id, owner.id)).not.toBeNull();
  });

  it("returns null for an unknown id", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("unknown-id"));
    expect(consumePendingAction("not-a-real-id", user.id)).toBeNull();
  });

  it("deleteExpiredPendingActions removes only rows past their TTL", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("sweep"));
    const freshId = createPendingAction(user.id, "confirm", "Archive?", "{}");
    deleteExpiredPendingActions();
    // A freshly created row (expires 24h from now) must survive a sweep run immediately after.
    expect(consumePendingAction(freshId, user.id)).not.toBeNull();
  });
});
