import { describe, it, expect } from "vitest";
import {
  appendWhatsAppMessage,
  deleteFamilyLink,
  deleteUserCompletely,
  findOrCreateUserByPhone,
  getFamilyLink,
  hasInboundWhatsAppMessage,
  listFamilyShares,
  logFamilyShare,
  markFamilySharesRemoved,
  upsertFamilyLink,
} from "./store.js";

let counter = 0;
function freshPhone(): string {
  counter += 1;
  return `44791000${String(counter).padStart(4, "0")}`;
}

function freshOwner() {
  const phone = freshPhone();
  return { phone, ownerId: findOrCreateUserByPhone(phone).id };
}

describe("family links", () => {
  it("links with the defaults, and linking again only changes settings", () => {
    const { phone, ownerId } = freshOwner();
    const first = upsertFamilyLink(ownerId, phone);
    expect(first).toMatchObject({ tripsMode: "ask", availabilityOn: true });

    const second = upsertFamilyLink(ownerId, phone, { tripsMode: "auto" });
    expect(second).toMatchObject({ tripsMode: "auto", availabilityOn: true, linkedAt: first.linkedAt });

    const third = upsertFamilyLink(ownerId, phone, { availabilityOn: false });
    expect(third).toMatchObject({ tripsMode: "auto", availabilityOn: false });
  });

  it("deletes a link", () => {
    const { phone, ownerId } = freshOwner();
    upsertFamilyLink(ownerId, phone);
    deleteFamilyLink(ownerId, phone);
    expect(getFamilyLink(ownerId, phone)).toBeNull();
  });

  it("keeps the share log per phone and marks removals without deleting the rows", () => {
    const { phone, ownerId } = freshOwner();
    const other = freshOwner();
    logFamilyShare(ownerId, phone, "note", "Builder", 7);
    logFamilyShare(other.ownerId, other.phone, "note", "Plumber", 8);

    expect(listFamilyShares(ownerId, phone).map((s) => [s.label, s.joyceItemId])).toEqual([["Builder", 7]]);

    markFamilySharesRemoved(ownerId, phone);
    expect(listFamilyShares(ownerId, phone)).toEqual([]);
    expect(listFamilyShares(ownerId, phone, { includeRemoved: true })[0].removedAt).not.toBeNull();
    expect(listFamilyShares(other.ownerId, other.phone)).toHaveLength(1);
  });

  it("only counts a number once it has sent Marlowe a message", () => {
    const { phone, ownerId } = freshOwner();
    expect(hasInboundWhatsAppMessage(ownerId, phone)).toBe(false);
    appendWhatsAppMessage(ownerId, phone, "assistant", "hello");
    expect(hasInboundWhatsAppMessage(ownerId, phone)).toBe(false);
    appendWhatsAppMessage(ownerId, phone, "user", "hi");
    expect(hasInboundWhatsAppMessage(ownerId, phone)).toBe(true);
  });

  it("is removed with the account", () => {
    const { phone, ownerId } = freshOwner();
    upsertFamilyLink(ownerId, phone);
    logFamilyShare(ownerId, phone, "note", "Builder", 1);
    deleteUserCompletely(ownerId);
    expect(getFamilyLink(ownerId, phone)).toBeNull();
    expect(listFamilyShares(ownerId, phone, { includeRemoved: true })).toEqual([]);
  });
});
