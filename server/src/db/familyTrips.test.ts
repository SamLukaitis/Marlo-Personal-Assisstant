import { describe, expect, it } from "vitest";
import {
  deleteFamilyTrip,
  deleteFamilyTrips,
  deleteUserCompletely,
  findOrCreateUserByPhone,
  getFamilyTrip,
  listFamilyTrips,
  saveFamilyTrip,
  upsertFamilyLink,
  type FamilyTripRow,
} from "./store.js";

let counter = 0;
function freshOwner() {
  counter += 1;
  const phone = `44791500${String(counter).padStart(4, "0")}`;
  return { phone, ownerId: findOrCreateUserByPhone(phone).id };
}

const trip = (key: string, patch: Partial<FamilyTripRow> = {}): FamilyTripRow => ({
  tripKey: key,
  startDate: "2099-03-10",
  endDate: "2099-03-17",
  country: "Portugal",
  state: "asked",
  shareCountry: null,
  joyceTripId: null,
  ...patch,
});

describe("the country switch", () => {
  it("is off for a new link and for a link that predates it, and changes only when asked", () => {
    const { phone, ownerId } = freshOwner();
    expect(upsertFamilyLink(ownerId, phone).tripsCountry).toBe(false);
    expect(upsertFamilyLink(ownerId, phone, { tripsCountry: true })).toMatchObject({ tripsCountry: true, tripsMode: "ask" });
    expect(upsertFamilyLink(ownerId, phone, { tripsMode: "auto" })).toMatchObject({ tripsCountry: true, tripsMode: "auto" });
  });
});

describe("family trips", () => {
  it("round-trips a trip and its decision, per owner and phone", () => {
    const a = freshOwner();
    const b = freshOwner();
    saveFamilyTrip(a.ownerId, a.phone, trip("1"));
    saveFamilyTrip(a.ownerId, a.phone, trip("1", { state: "shared", shareCountry: true, joyceTripId: 4 }));
    saveFamilyTrip(b.ownerId, b.phone, trip("1", { state: "declined", shareCountry: false }));

    expect(getFamilyTrip(a.ownerId, a.phone, "1")).toEqual(
      trip("1", { state: "shared", shareCountry: true, joyceTripId: 4 })
    );
    expect(listFamilyTrips(a.ownerId, a.phone)).toHaveLength(1);
    expect(getFamilyTrip(b.ownerId, b.phone, "1")?.state).toBe("declined");
    expect(getFamilyTrip(a.ownerId, b.phone, "1")).toBeNull();
  });

  it("deletes one trip or all of a phone's trips", () => {
    const { phone, ownerId } = freshOwner();
    saveFamilyTrip(ownerId, phone, trip("1"));
    saveFamilyTrip(ownerId, phone, trip("2"));
    deleteFamilyTrip(ownerId, phone, "1");
    expect(listFamilyTrips(ownerId, phone).map((t) => t.tripKey)).toEqual(["2"]);
    deleteFamilyTrips(ownerId, phone);
    expect(listFamilyTrips(ownerId, phone)).toEqual([]);
  });

  it("is removed with the account", () => {
    const { phone, ownerId } = freshOwner();
    upsertFamilyLink(ownerId, phone);
    saveFamilyTrip(ownerId, phone, trip("1"));
    deleteUserCompletely(ownerId);
    expect(listFamilyTrips(ownerId, phone)).toEqual([]);
  });
});
