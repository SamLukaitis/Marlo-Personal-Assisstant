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
  resetOnboardingConnectionState,
  addPhoneNumberForUser,
  listPhoneNumbersForUser,
  getPendingSetup,
  upsertAccount,
  listAccounts,
  recordApiUsage,
  listRecentApiUsage,
  listPosterNotes,
  upsertReadEmail,
  searchReadEmails,
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

  // Regression test for the OTHER direction of the same bug: a to-do THIS owner created (not one
  // they replied to) that someone else replied to and read. Deleting admin_todos WHERE
  // created_by = ownerId removes the parent row while the other person's admin_todo_replies/
  // admin_todo_reply_reads rows still point at it via todo_id — violating THEIR FK, not this
  // owner's. This is the real production shape: a prolific to-do creator whose to-dos other
  // admins interacted with.
  it("does not throw when someone else replied to (and read) this owner's own admin_todos row", () => {
    const todoOwner = findOrCreateUserByEmail(uniqueEmail("todo-owner-2"));
    const otherAdmin = findOrCreateUserByEmail(uniqueEmail("other-admin"));
    const todoText = uniqueEmail("todo-text-2");
    addAdminTodo(todoText, todoOwner.id);
    const todo = listAdminTodos(todoOwner.id).find((t) => t.text === todoText)!;
    addAdminTodoReply(todo.id, otherAdmin.id, "reply text");
    markAdminTodoRepliesRead(todo.id, otherAdmin.id);

    expect(() => deleteUserCompletely(todoOwner.id)).not.toThrow();
    expect(getUser(todoOwner.id)).toBeNull();
  });

  // Regression test for the same bug shape one table generation later: read_emails.owner_id
  // declares NOT NULL REFERENCES users(id) (the search_read_emails cache) — added alongside the
  // rest of the reset, not after a production report this time, specifically because every prior
  // fix in this file was a report first.
  it("does not throw when the owner has a read_emails row, and the row is actually gone after", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("read-email-cache"));
    upsertReadEmail(user.id, {
      accountId: 1,
      accountEmail: "me@example.com",
      id: "msg-1",
      subject: "Test",
      from: "someone@example.com",
      snippet: "snippet",
      receivedAt: new Date().toISOString(),
    });

    expect(() => deleteUserCompletely(user.id)).not.toThrow();
    expect(getUser(user.id)).toBeNull();
    expect(searchReadEmails(user.id, "Test")).toEqual([]);
  });
});

describe("findRemainingOwnerReferences", () => {
  // This is the diagnostic that should have named the table on the very first occurrence of this
  // bug class instead of leaving nothing but a bare "FOREIGN KEY constraint failed" to debug —
  // verify it actually names a table it doesn't yet know to clear.
  it("names a table that still holds a row for the owner", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("dangling-ref"));
    setPendingSetup(user.id, "ask_briefing");

    expect(findRemainingOwnerReferences(user.id)).toEqual([
      "pending_setup.owner_id (1 row)",
      "onboarding_step_events.owner_id (1 row)",
    ]);
  });

  it("returns nothing once the owner has actually been purged", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("clean-ref"));
    setPendingSetup(user.id, "ask_briefing");
    deleteUserCompletely(user.id);

    expect(findRemainingOwnerReferences(user.id)).toEqual([]);
  });

  it("names read_emails specifically when a cached email is left behind", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("dangling-read-email"));
    upsertReadEmail(user.id, {
      accountId: 1,
      accountEmail: "me@example.com",
      id: "msg-1",
      subject: "Test",
      from: "someone@example.com",
      snippet: "snippet",
      receivedAt: new Date().toISOString(),
    });

    expect(findRemainingOwnerReferences(user.id)).toEqual(["read_emails.owner_id (1 row)"]);
  });
});

describe("resetOnboardingConnectionState", () => {
  // The whole point: replaying onboarding must not touch data-bearing tables. Only the
  // connection state (accounts, pending_setup, user_phone_numbers) should move.
  it("clears connection state but leaves data-bearing tables (usage, to-dos, poster board) alone", () => {
    const email = uniqueEmail("keep-data");
    const user = findOrCreateUserByEmail(email);
    addPhoneNumberForUser(user.id, "447900000111");
    upsertAccount(user.id, {
      provider: "google",
      email,
      accessToken: "tok",
      refreshToken: "refresh",
      expiryDate: Date.now() + 3600_000,
    });
    setPendingSetup(user.id, "ask_briefing");
    const todoText = uniqueEmail("todo-keep");
    addAdminTodo(todoText, user.id);
    const noteText = uniqueEmail("note-keep");
    addPosterNote(user.id, noteText);
    recordApiUsage(user.id, "whatsapp", "claude-sonnet-5", "chat", 10, 5, 0, 0);

    resetOnboardingConnectionState(user.id);

    // Connection state: gone.
    expect(listPhoneNumbersForUser(user.id)).toEqual([]);
    expect(listAccounts(user.id)).toEqual([]);
    expect(getPendingSetup(user.id)).toBeNull();

    // Data: untouched.
    expect(getUser(user.id)).not.toBeNull();
    expect(listAdminTodos(user.id).some((t) => t.text === todoText)).toBe(true);
    expect(listPosterNotes(50).some((n) => n.text === noteText)).toBe(true);
    expect(listRecentApiUsage(50).some((u) => u.ownerEmail === email)).toBe(true);
  });

  it("does not throw when the owner has no accounts, phones, or pending setup yet", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("bare"));
    expect(() => resetOnboardingConnectionState(user.id)).not.toThrow();
  });
});
