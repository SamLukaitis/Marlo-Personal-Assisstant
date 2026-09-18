import { describe, it, expect } from "vitest";
import {
  findOrCreateUserByPhone,
  findOrCreateUserByEmail,
  addPhoneNumberForUser,
  resolveOwnerByPhone,
  getUser,
  listAllUserIds,
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
    const userCountBefore = listAllUserIds().length;

    const resolved = findOrCreateUserByPhone(phone);

    expect(resolved.id).toBe(existing.id);
    expect(resolved.email).toBe(`linked-${phone}@example.com`);
    // The returned id matching isn't proof alone — a bug that returned the right id while also
    // inserting a stray second users row would pass the two assertions above.
    expect(listAllUserIds().length).toBe(userCountBefore);
  });

  it("gives two different numbers two different accounts", () => {
    const a = findOrCreateUserByPhone(freshPhone());
    const b = findOrCreateUserByPhone(freshPhone());

    expect(a.id).not.toBe(b.id);
  });
});
