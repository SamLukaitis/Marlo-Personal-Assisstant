import { describe, it, expect } from "vitest";
import {
  findOrCreateUserByEmail,
  deleteUserCompletely,
  setPendingSetup,
  createPendingAction,
  getUser,
  saveDocument,
  saveMatchKeys,
  addAdminTodo,
  addPosterNote,
  addAdminTodoReply,
  markAdminTodoRepliesRead,
  listAdminTodos,
  findRemainingOwnerReferences,
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

  // Regression test: admin_todos.created_by and poster_notes.author_id both declare
  // `NOT NULL REFERENCES users(id)` (Portal admin feature, commit 686d173). deleteUserCompletely
  // never cleared either table, so an admin who'd used their own Portal to-do list or poster board
  // hit "FOREIGN KEY constraint failed" on reset — reported against the app owner's own account.
  it("does not throw when the owner has an admin_todos row", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("admin-todo"));
    addAdminTodo("test todo", user.id);

    expect(() => deleteUserCompletely(user.id)).not.toThrow();
    expect(getUser(user.id)).toBeNull();
  });

  it("does not throw when the owner has a poster_notes row", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("poster-note"));
    addPosterNote(user.id, "test note");

    expect(() => deleteUserCompletely(user.id)).not.toThrow();
    expect(getUser(user.id)).toBeNull();
  });

  // Regression test: admin_todo_replies.author_id and admin_todo_reply_reads.user_id both declare
  // NOT NULL REFERENCES users(id) (threaded to-do replies, commit c16615f). deleteUserCompletely
  // only ever cleared admin_todos WHERE created_by = ownerId, which doesn't touch a reply this
  // owner left on someone ELSE's still-existing to-do, or their own read-tracking row — same bug
  // shape as the admin_todos/poster_notes case above, one table generation later.
  it("does not throw when the owner has replied to (and read) someone else's admin_todos row", () => {
    const todoOwner = findOrCreateUserByEmail(uniqueEmail("todo-owner"));
    const replier = findOrCreateUserByEmail(uniqueEmail("todo-replier"));
    const todoText = uniqueEmail("todo-text"); // unique text to find this exact todo below
    addAdminTodo(todoText, todoOwner.id);
    const todo = listAdminTodos(todoOwner.id).find((t) => t.text === todoText)!;
    addAdminTodoReply(todo.id, replier.id, "reply text");
    markAdminTodoRepliesRead(todo.id, replier.id);

    expect(() => deleteUserCompletely(replier.id)).not.toThrow();
    expect(getUser(replier.id)).toBeNull();
  });
});

describe("findRemainingOwnerReferences", () => {
  // This is the diagnostic that should have named the table on the very first occurrence of this
  // bug class instead of leaving nothing but a bare "FOREIGN KEY constraint failed" to debug —
  // verify it actually names a table it doesn't yet know to clear.
  it("names a table that still holds a row for the owner", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("dangling-ref"));
    setPendingSetup(user.id, "ask_briefing");

    expect(findRemainingOwnerReferences(user.id)).toEqual(["pending_setup.owner_id (1 row)"]);
  });

  it("returns nothing once the owner has actually been purged", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("clean-ref"));
    setPendingSetup(user.id, "ask_briefing");
    deleteUserCompletely(user.id);

    expect(findRemainingOwnerReferences(user.id)).toEqual([]);
  });
});
