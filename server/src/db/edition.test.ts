import { describe, it, expect } from "vitest";
import {
  findOrCreateUserByEmail,
  findOrCreateUserByPhone,
  getUserEdition,
  setUserEdition,
  addInvitedPhone,
  isEditionId,
} from "./store.js";

let n = 0;
const email = () => `edition-${Date.now()}-${++n}@example.com`;
const phone = () => `4479${String(Date.now()).slice(-6)}${String(++n).padStart(2, "0")}`;

describe("user edition", () => {
  it("defaults to general", () => {
    expect(getUserEdition(findOrCreateUserByEmail(email()).id)).toBe("general");
  });

  it("can be set to business and back", () => {
    const u = findOrCreateUserByEmail(email());
    setUserEdition(u.id, "business");
    expect(getUserEdition(u.id)).toBe("business");
    setUserEdition(u.id, "general");
    expect(getUserEdition(u.id)).toBe("general");
  });

  it("rejects unknown editions", () => {
    const u = findOrCreateUserByEmail(email());
    expect(() => setUserEdition(u.id, "family" as never)).toThrow();
    expect(isEditionId("family")).toBe(false);
  });

  it("applies the invite's edition when the invited phone is bound to a new user", () => {
    const p = phone();
    addInvitedPhone(p, "business");
    const u = findOrCreateUserByPhone(p);
    expect(getUserEdition(u.id)).toBe("business");
  });

  it("an invite without an edition leaves the user on general", () => {
    const p = phone();
    addInvitedPhone(p);
    expect(getUserEdition(findOrCreateUserByPhone(p).id)).toBe("general");
  });
});
