import { describe, it, expect } from "vitest";
import { resolveRegistrationUser } from "./authRoutes.js";
import {
  findOrCreateUserByPhone,
  findOrCreateUserByEmail,
  getUser,
  resolveOwnerByPhone,
  listAllUserIds,
  listPhoneNumbersForUser,
  addPhoneNumberForUser,
  resetOnboardingConnectionState,
} from "../db/store.js";

let counter = 0;
function freshPhone(): string {
  counter += 1;
  return `44793000${String(counter).padStart(4, "0")}`;
}

// Replay-onboarding used to DELETE the user_phone_numbers row, which threw away the one fact the
// re-onboarding needed: this number belongs to THAT account. Tapping "No" at the email question
// then minted a brand new phone-only account, so the original account still owned the address and
// the new one owned the number — and every later attempt to connect the mailbox was refused with
// "That email already belongs to a Marlowe account", forever, with no user-reachable way out.
describe("replay onboarding — the number stays owned by the account that was replayed", () => {
  it("the 'No' tap re-onboards onto the original account instead of creating a second one", () => {
    const phone = freshPhone();
    const email = `replay-${phone}@example.com`;
    const original = findOrCreateUserByPhone(phone);
    expect(resolveRegistrationUser(phone, email).kind).toBe("ok");
    const userCountBefore = listAllUserIds().length;

    resetOnboardingConnectionState(original.id);

    // Replay's whole point: the number stops resolving, so the next inbound WhatsApp message
    // re-enters handlePendingRegistration rather than going straight to normal chat.
    expect(resolveOwnerByPhone(phone)).toBeNull();
    // ...and Settings must not still list it as a bound number. handleAwaitingEmail's
    // "already connected elsewhere" guard reads this same list, so a leftover row there would
    // block the type-your-email branch of re-onboarding.
    expect(listPhoneNumbersForUser(original.id)).toHaveLength(0);

    // The "No" tap at the email-confirm step (whatsappRegistration.ts).
    const reclaimed = findOrCreateUserByPhone(phone);

    expect(reclaimed.id).toBe(original.id);
    expect(listAllUserIds().length).toBe(userCountBefore);
    expect(resolveOwnerByPhone(phone)).toBe(original.id);
    // The account keeps the address it always had, so it is the same row, not a lookalike.
    expect(getUser(original.id)?.email).toBe(email);
  });

  it("the mailbox can be reconnected after a replay, which is the loop this fixes", () => {
    const phone = freshPhone();
    const email = `reconnect-${phone}@example.com`;
    const original = findOrCreateUserByPhone(phone);
    expect(resolveRegistrationUser(phone, email).kind).toBe("ok");

    resetOnboardingConnectionState(original.id);
    findOrCreateUserByPhone(phone); // the "No" tap

    const result = resolveRegistrationUser(phone, email);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.userId).toBe(original.id);
  });

  it("re-binding the number through Settings after a replay works too", () => {
    const phone = freshPhone();
    const original = findOrCreateUserByEmail(`settings-${counter}@example.com`);
    addPhoneNumberForUser(original.id, phone);

    resetOnboardingConnectionState(original.id);
    expect(resolveOwnerByPhone(phone)).toBeNull();

    addPhoneNumberForUser(original.id, phone);

    expect(resolveOwnerByPhone(phone)).toBe(original.id);
    expect(listPhoneNumbersForUser(original.id)).toHaveLength(1);
  });

  it("a replayed number still cannot be taken over by a different account", () => {
    const phone = freshPhone();
    const original = findOrCreateUserByPhone(phone);
    const stranger = findOrCreateUserByEmail(`stranger-${counter}@example.com`);

    resetOnboardingConnectionState(original.id);

    expect(() => addPhoneNumberForUser(stranger.id, phone)).toThrow(/already registered/i);
    expect(resolveOwnerByPhone(phone)).toBeNull();
  });
});
