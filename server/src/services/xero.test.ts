import { describe, it, expect } from "vitest";
import { getXeroForwardingEmail, setXeroForwardingEmail } from "./xero.js";
import { findOrCreateUserByEmail } from "../db/store.js";

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

describe("xero forwarding address", () => {
  it("returns null when nothing has been saved yet", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("xero-unset"));
    expect(getXeroForwardingEmail(user.id)).toBeNull();
  });

  it("trims and saves a valid address", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("xero-valid"));
    setXeroForwardingEmail(user.id, "  abc123@bills.xero.com  ");
    expect(getXeroForwardingEmail(user.id)).toBe("abc123@bills.xero.com");
  });

  it("rejects a malformed address without saving it", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("xero-invalid"));
    expect(() => setXeroForwardingEmail(user.id, "not-an-email")).toThrow(
      '"not-an-email" doesn\'t look like a valid email address.'
    );
    expect(getXeroForwardingEmail(user.id)).toBeNull();
  });

  it("scopes the address by owner", () => {
    const a = findOrCreateUserByEmail(uniqueEmail("xero-owner-a"));
    const b = findOrCreateUserByEmail(uniqueEmail("xero-owner-b"));
    setXeroForwardingEmail(a.id, "a@bills.xero.com");
    expect(getXeroForwardingEmail(b.id)).toBeNull();
  });
});
