import { describe, it, expect } from "vitest";
import {
  findOrCreateUserByPhone,
  findOrCreateUserByEmail,
  addPhoneNumberForUser,
  resolveOwnerByPhone,
  getUser,
} from "./store.js";

let counter = 0;
function freshPhone(): string {
  counter += 1;
  return `44790000${String(counter).padStart(4, "0")}`;
}

describe("findOrCreateUserByPhone", () => {
  it("creates an account with no email and binds the phone to it", () => {
    const phone = freshPhone();

    const user = findOrCreateUserByPhone(phone);

    expect(user.email).toBeNull();
    expect(resolveOwnerByPhone(phone)).toBe(user.id);
    expect(getUser(user.id)?.email).toBeNull();
  });

  it("returns the existing owner instead of creating a second account", () => {
    const phone = freshPhone();
    const first = findOrCreateUserByPhone(phone);

    const second = findOrCreateUserByPhone(phone);

    expect(second.id).toBe(first.id);
  });

  it("returns the existing owner when the number already belongs to an email account", () => {
    const phone = freshPhone();
    const existing = findOrCreateUserByEmail(`linked-${phone}@example.com`);
    addPhoneNumberForUser(existing.id, phone);

    const resolved = findOrCreateUserByPhone(phone);

    expect(resolved.id).toBe(existing.id);
    expect(resolved.email).toBe(`linked-${phone}@example.com`);
  });

  it("gives two different numbers two different accounts", () => {
    const a = findOrCreateUserByPhone(freshPhone());
    const b = findOrCreateUserByPhone(freshPhone());

    expect(a.id).not.toBe(b.id);
  });
});
