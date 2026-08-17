import { describe, it, expect } from "vitest";
import { findOrCreateUserByEmail, getEnabledTools, setToolEnabled } from "./store.js";

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

describe("user_enabled_tools", () => {
  it("returns an empty set for a user who hasn't enabled anything", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("no-tools"));
    expect(getEnabledTools(user.id)).toEqual(new Set());
  });

  it("enabling a tool makes it appear in the enabled set", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("enable-teams"));
    setToolEnabled(user.id, "teams", true);
    expect(getEnabledTools(user.id)).toEqual(new Set(["teams"]));
  });

  it("enabling twice does not error or duplicate", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("enable-twice"));
    setToolEnabled(user.id, "travel", true);
    setToolEnabled(user.id, "travel", true);
    expect(getEnabledTools(user.id)).toEqual(new Set(["travel"]));
  });

  it("disabling removes it from the enabled set", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("disable"));
    setToolEnabled(user.id, "teams", true);
    setToolEnabled(user.id, "teams", false);
    expect(getEnabledTools(user.id)).toEqual(new Set());
  });

  it("rejects an unknown tool key", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("bad-key"));
    expect(() => setToolEnabled(user.id, "finance" as never, true)).toThrow("unknown tool");
  });

  it("is scoped per owner — enabling for one user doesn't affect another", () => {
    const userA = findOrCreateUserByEmail(uniqueEmail("owner-a"));
    const userB = findOrCreateUserByEmail(uniqueEmail("owner-b"));
    setToolEnabled(userA.id, "teams", true);
    expect(getEnabledTools(userB.id)).toEqual(new Set());
  });
});
