import { describe, it, expect } from "vitest";
import { findOrCreateUserByEmail, appendWhatsAppMessage, searchWhatsAppHistory } from "./store.js";

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}
function uniquePhone(prefix: string): string {
  counter += 1;
  return `44${prefix}${Date.now()}${counter}`;
}

describe("searchWhatsAppHistory", () => {
  it("finds a message containing the query term (proves the FTS index and its insert trigger both work)", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("wa-search-hit"));
    const phone = uniquePhone("hit");
    appendWhatsAppMessage(user.id, phone, "user", "My passport number is X1234567");
    appendWhatsAppMessage(user.id, phone, "assistant", "Got it, noted.");

    const results = searchWhatsAppHistory(user.id, phone, "passport");
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain("X1234567");
  });

  it("returns no results when nothing matches", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("wa-search-miss"));
    const phone = uniquePhone("miss");
    appendWhatsAppMessage(user.id, phone, "user", "What's the weather like");

    expect(searchWhatsAppHistory(user.id, phone, "passport")).toHaveLength(0);
  });

  it("scopes results to the given phone — a match on another thread doesn't leak in", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("wa-search-phone-scope"));
    const phoneA = uniquePhone("a");
    const phoneB = uniquePhone("b");
    appendWhatsAppMessage(user.id, phoneA, "user", "My passport number is X1234567");

    expect(searchWhatsAppHistory(user.id, phoneB, "passport")).toHaveLength(0);
  });

  it("scopes results to the owner — a match under another owner doesn't leak in", () => {
    const userA = findOrCreateUserByEmail(uniqueEmail("wa-search-owner-a"));
    const userB = findOrCreateUserByEmail(uniqueEmail("wa-search-owner-b"));
    const phone = uniquePhone("owner-scope");
    appendWhatsAppMessage(userA.id, phone, "user", "My passport number is X1234567");

    expect(searchWhatsAppHistory(userB.id, phone, "passport")).toHaveLength(0);
  });

  it("returns an empty array for a blank query instead of matching everything", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("wa-search-blank"));
    const phone = uniquePhone("blank");
    appendWhatsAppMessage(user.id, phone, "user", "hello there");

    expect(searchWhatsAppHistory(user.id, phone, "   ")).toHaveLength(0);
  });

  it("doesn't throw on FTS special characters in the query", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("wa-search-special"));
    const phone = uniquePhone("special");
    appendWhatsAppMessage(user.id, phone, "user", "hello there");

    expect(() => searchWhatsAppHistory(user.id, phone, '"quoted" OR NOT * weird:query')).not.toThrow();
  });

  it("respects the limit parameter", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("wa-search-limit"));
    const phone = uniquePhone("limit");
    for (let i = 0; i < 5; i++) {
      appendWhatsAppMessage(user.id, phone, "user", `trip message ${i}`);
    }

    expect(searchWhatsAppHistory(user.id, phone, "trip", 2)).toHaveLength(2);
  });
});
