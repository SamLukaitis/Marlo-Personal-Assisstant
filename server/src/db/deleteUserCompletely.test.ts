import { describe, it, expect } from "vitest";
import {
  findOrCreateUserByEmail,
  deleteUserCompletely,
  setPendingSetup,
  createPendingAction,
  getUser,
  saveDocument,
  saveMatchKeys,
} from "./store.js";

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

describe("deleteUserCompletely", () => {
  // Regression test: pending_setup and pending_actions both declare
  // `owner_id INTEGER NOT NULL REFERENCES users(id)`. Before this fix, deleteUserCompletely never
  // cleared either table, so deleting a user who'd gone through post-connect setup (pending_setup)
  // or hit an ask_user_choice prompt (pending_actions) violated that foreign key and the whole
  // purge transaction threw — exactly the "reset test phone" bug reported against a real,
  // actively-used account (which had rows in both).
  it("does not throw when the owner has a pending_setup row", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("pending-setup"));
    setPendingSetup(user.id, "ask_briefing");

    expect(() => deleteUserCompletely(user.id)).not.toThrow();
    expect(getUser(user.id)).toBeNull();
  });

  it("does not throw when the owner has a pending_actions row", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("pending-action"));
    createPendingAction(user.id, "confirm", "Archive 3 emails?", "{}");

    expect(() => deleteUserCompletely(user.id)).not.toThrow();
    expect(getUser(user.id)).toBeNull();
  });

  // Regression test: document_match_keys.document_id REFERENCES documents(id). deleteUserCompletely
  // used to delete documents before document_match_keys, so an owner with any matched document
  // (e.g. a saved booking/receipt) hit "FOREIGN KEY constraint failed" on reset.
  it("does not throw when the owner has a document with match keys", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("doc-match-keys"));
    const doc = saveDocument(user.id, {
      phone: "447900000000",
      filename: null,
      mimeType: "application/pdf",
      storedPath: "/tmp/fake-reset-test",
      caption: null,
      title: "Test Booking",
      extractedText: "text",
      category: "travel",
    });
    saveMatchKeys(user.id, doc.id, { referenceCode: "ABCD1234" });

    expect(() => deleteUserCompletely(user.id)).not.toThrow();
    expect(getUser(user.id)).toBeNull();
  });
});
