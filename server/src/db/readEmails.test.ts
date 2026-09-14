import { describe, it, expect } from "vitest";
import { findOrCreateUserByEmail, upsertReadEmail, searchReadEmails } from "./store.js";

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

function fakeMessage(overrides: Partial<Parameters<typeof upsertReadEmail>[1]> = {}) {
  return {
    accountId: 1,
    accountEmail: "test@example.com",
    id: "msg-1",
    subject: "Your order shipped",
    from: "orders@shop.com",
    snippet: "Package on its way",
    receivedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("upsertReadEmail + searchReadEmails", () => {
  it("stores metadata for a listed message with no body yet", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("read-emails-metadata"));
    upsertReadEmail(user.id, fakeMessage());

    const results = searchReadEmails(user.id, "shipped");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      accountId: 1,
      accountEmail: "test@example.com",
      messageId: "msg-1",
      subject: "Your order shipped",
      from: "orders@shop.com",
      snippet: "Package on its way",
      body: null,
    });
  });

  it("re-listing the same message updates the row instead of creating a duplicate", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("read-emails-relist"));
    upsertReadEmail(user.id, fakeMessage({ snippet: "old snippet" }));
    upsertReadEmail(user.id, fakeMessage({ snippet: "new snippet" }));

    const results = searchReadEmails(user.id, "snippet");
    expect(results).toHaveLength(1);
    expect(results[0].snippet).toBe("new snippet");
  });

  it("a later get_message call adds the full body onto the existing row", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("read-emails-body"));
    upsertReadEmail(user.id, fakeMessage());
    upsertReadEmail(user.id, fakeMessage({ body: "Full email text with the tracking number 12345." }));

    const results = searchReadEmails(user.id, "tracking number");
    expect(results).toHaveLength(1);
    expect(results[0].body).toBe("Full email text with the tracking number 12345.");
  });

  it("a later metadata-only re-list does not clobber a body already saved by get_message", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("read-emails-preserve-body"));
    upsertReadEmail(user.id, fakeMessage({ body: "Full body text." }));
    upsertReadEmail(user.id, fakeMessage({ snippet: "refreshed snippet" }));

    const results = searchReadEmails(user.id, "refreshed");
    expect(results).toHaveLength(1);
    expect(results[0].body).toBe("Full body text.");
  });

  it("distinguishes messages by (account, message id) — same message id on a different account is a separate row", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("read-emails-diff-account"));
    upsertReadEmail(user.id, fakeMessage({ accountId: 1, snippet: "account one" }));
    upsertReadEmail(user.id, fakeMessage({ accountId: 2, snippet: "account two" }));

    const results = searchReadEmails(user.id, "account");
    expect(results).toHaveLength(2);
  });

  it("matches on subject, sender, snippet, or body", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("read-emails-match-fields"));
    upsertReadEmail(user.id, fakeMessage({ id: "m1", subject: "Electrician quote" }));
    upsertReadEmail(user.id, fakeMessage({ id: "m2", from: "billing@electrician.co" }));
    upsertReadEmail(user.id, fakeMessage({ id: "m3", body: "Please find the electrician's invoice attached." }));
    upsertReadEmail(user.id, fakeMessage({ id: "m4", subject: "Unrelated" }));

    const results = searchReadEmails(user.id, "electrician");
    expect(results.map((r) => r.messageId).sort()).toEqual(["m1", "m2", "m3"]);
  });

  it("scopes results per owner", () => {
    const userA = findOrCreateUserByEmail(uniqueEmail("read-emails-owner-a"));
    const userB = findOrCreateUserByEmail(uniqueEmail("read-emails-owner-b"));
    upsertReadEmail(userA.id, fakeMessage());

    expect(searchReadEmails(userB.id, "shipped")).toHaveLength(0);
  });

  it("respects an explicit limit", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("read-emails-limit"));
    for (let i = 0; i < 5; i++) {
      upsertReadEmail(user.id, fakeMessage({ id: `m${i}`, subject: `Notice ${i}` }));
    }

    expect(searchReadEmails(user.id, "Notice", 2)).toHaveLength(2);
  });
});
