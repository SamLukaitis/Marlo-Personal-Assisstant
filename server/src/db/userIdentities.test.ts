import { describe, it, expect } from "vitest";
import {
  findOrCreateUserByEmail,
  linkIdentity,
  getUserIdByIdentity,
  hasIdentity,
  deleteUserCompletely,
  findRemainingOwnerReferences,
  getUser,
} from "./store.js";

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}
function uniqueSubject(prefix: string): string {
  counter += 1;
  return `${prefix}-tenant:${prefix}-object-${Date.now()}-${counter}`;
}

describe("user_identities", () => {
  it("resolves a linked provider identity back to its user", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("identity-link"));
    const subject = uniqueSubject("link");

    linkIdentity(user.id, "microsoft", subject);

    expect(getUserIdByIdentity("microsoft", subject)).toBe(user.id);
    expect(hasIdentity(user.id, "microsoft")).toBe(true);
  });

  it("returns null for an identity nobody has linked", () => {
    expect(getUserIdByIdentity("microsoft", uniqueSubject("unlinked"))).toBeNull();
  });

  it("never re-points an identity that already belongs to another user", () => {
    const first = findOrCreateUserByEmail(uniqueEmail("identity-first"));
    const second = findOrCreateUserByEmail(uniqueEmail("identity-second"));
    const subject = uniqueSubject("taken");

    linkIdentity(first.id, "microsoft", subject);
    linkIdentity(second.id, "microsoft", subject);

    expect(getUserIdByIdentity("microsoft", subject)).toBe(first.id);
    expect(hasIdentity(second.id, "microsoft")).toBe(false);
  });

  // Same bug class deleteUserCompletely.test.ts guards: user_identities.user_id REFERENCES users(id).
  it("is cleared by deleteUserCompletely", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("identity-purge"));
    const subject = uniqueSubject("purge");
    linkIdentity(user.id, "microsoft", subject);

    expect(() => deleteUserCompletely(user.id)).not.toThrow();
    expect(getUser(user.id)).toBeNull();
    expect(getUserIdByIdentity("microsoft", subject)).toBeNull();
    expect(findRemainingOwnerReferences(user.id)).toEqual([]);
  });
});
