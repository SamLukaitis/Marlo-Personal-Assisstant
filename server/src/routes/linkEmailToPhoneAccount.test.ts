import { describe, it, expect } from "vitest";
import { resolveRegistrationUser } from "./authRoutes.js";
import {
  findOrCreateUserByPhone,
  findOrCreateUserByEmail,
  getUser,
  resolveOwnerByPhone,
} from "../db/store.js";

let counter = 0;
function freshPhone(): string {
  counter += 1;
  return `44792000${String(counter).padStart(4, "0")}`;
}

describe("resolveRegistrationUser", () => {
  it("fills in the email on the existing phone-only account rather than making a second one", () => {
    const phone = freshPhone();
    const phoneOnly = findOrCreateUserByPhone(phone);
    const email = `linked-${phone}@example.com`;

    const result = resolveRegistrationUser(phone, email);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.userId).toBe(phoneOnly.id);
    expect(getUser(phoneOnly.id)?.email).toBe(email);
  });

  it("refuses when that email already belongs to a different account, leaving both intact", () => {
    const phone = freshPhone();
    const phoneOnly = findOrCreateUserByPhone(phone);
    const email = `taken-${phone}@example.com`;
    const other = findOrCreateUserByEmail(email);

    const result = resolveRegistrationUser(phone, email);

    expect(result.kind).toBe("account_exists");
    expect(getUser(phoneOnly.id)?.email).toBeNull();
    expect(resolveOwnerByPhone(phone)).toBe(phoneOnly.id);
    expect(getUser(other.id)?.email).toBe(email);
  });

  it("creates a fresh account when the number is not known yet", () => {
    const phone = freshPhone();
    const email = `brand-new-${phone}@example.com`;

    const result = resolveRegistrationUser(phone, email);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(getUser(result.userId)?.email).toBe(email);
  });
});
