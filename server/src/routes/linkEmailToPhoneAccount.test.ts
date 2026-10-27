import { describe, it, expect } from "vitest";
import { resolveRegistrationUser } from "./authRoutes.js";
import {
  findOrCreateUserByPhone,
  findOrCreateUserByEmail,
  getUser,
  resolveOwnerByPhone,
  listAllUserIds,
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
    const userCountBefore = listAllUserIds().length;

    const result = resolveRegistrationUser(phone, email);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.userId).toBe(phoneOnly.id);
    expect(getUser(phoneOnly.id)?.email).toBe(email);
    // The name of this test is the claim under test: matching the returned id alone would also
    // pass if a stray second users row got created alongside it.
    expect(listAllUserIds().length).toBe(userCountBefore);
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

  it("refuses to swap the mailbox on an account that already has a different one linked", () => {
    const phone = freshPhone();
    const phoneOnly = findOrCreateUserByPhone(phone);
    const gmail = `gmail-${phone}@example.com`;
    // Link Gmail first, same way the earlier test does.
    const first = resolveRegistrationUser(phone, gmail);
    expect(first.kind).toBe("ok");

    // Later, the same person tries to link Outlook — a different, still-unclaimed address.
    const outlook = `outlook-${phone}@example.com`;
    const result = resolveRegistrationUser(phone, outlook);

    expect(result.kind).toBe("account_exists");
    // The row keeps the address it already had — nothing moved, nothing overwritten.
    expect(getUser(phoneOnly.id)?.email).toBe(gmail);
  });

  it("re-linking the same address the account already has succeeds without a redundant write", () => {
    const phone = freshPhone();
    const phoneOnly = findOrCreateUserByPhone(phone);
    const email = `repeat-${phone}@example.com`;
    const first = resolveRegistrationUser(phone, email);
    expect(first.kind).toBe("ok");

    const result = resolveRegistrationUser(phone, email);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.userId).toBe(phoneOnly.id);
    expect(getUser(phoneOnly.id)?.email).toBe(email);
  });
});

// Both refusals used to come back as the same bare "account_exists", and the WhatsApp message
// behind it said "that email already belongs to a Marlo account I can't confirm is yours" —
// which is simply untrue when the address belongs to nobody and the real obstacle is the account
// already having one of its own. It sent a real user (the app owner, replaying his own
// onboarding with a fresh test Outlook address) hunting for the account holding that address,
// and then reaching for the account-merge script. The two cases need to be told apart.
describe("resolveRegistrationUser — why it refused", () => {
  it("reports the address being taken by someone else", () => {
    const phone = freshPhone();
    findOrCreateUserByPhone(phone);
    const someoneElse = `taken-${phone}@example.com`;
    findOrCreateUserByEmail(someoneElse);

    const result = resolveRegistrationUser(phone, someoneElse);

    expect(result).toEqual({ kind: "account_exists", reason: "email_belongs_to_another_account" });
  });

  it("reports the account already having its own address, and says which", () => {
    const phone = freshPhone();
    findOrCreateUserByPhone(phone);
    const mine = `mine-${phone}@example.com`;
    expect(resolveRegistrationUser(phone, mine).kind).toBe("ok");

    const result = resolveRegistrationUser(phone, `other-${phone}@example.com`);

    expect(result).toEqual({
      kind: "account_exists",
      reason: "account_has_different_email",
      currentEmail: mine,
    });
  });
});
