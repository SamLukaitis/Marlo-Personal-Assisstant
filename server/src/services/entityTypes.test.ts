import { describe, it, expect } from "vitest";
import { getEntityTypeDef } from "./entityTypes.js";
import { validateTravelMovement, type TravelMovement } from "./travelValidation.js";

describe("entity type registry", () => {
  it("registers travel_checkin with a validate that delegates straight to validateTravelMovement", () => {
    const def = getEntityTypeDef("travel_checkin");
    expect(def).toBeDefined();

    const movement: TravelMovement = {
      arrivalCountry: "France",
      arrivalCity: "Paris",
      arrivalDateTime: "2024-01-01T08:00:00Z",
    };
    const uploadedAt = new Date("2024-01-01T09:00:00Z");

    expect(def!.validate(movement, { uploadedAt })).toEqual(validateTravelMovement(movement, uploadedAt));
  });

  it("returns undefined for an unregistered type", () => {
    expect(getEntityTypeDef("nonexistent")).toBeUndefined();
  });
});
