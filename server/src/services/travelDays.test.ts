import { describe, it, expect } from "vitest";
import { findOrCreateUserByEmail, saveCheckin, listAllCheckinsAscending } from "../db/store.js";
import { countTravelDays } from "./travelDays.js";

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

// Regression check for docs/entities-and-links-guide.md §7 step 2: saveCheckin/
// listAllCheckinsAscending now read and write through the generic `entities` table instead of
// the raw travel_checkins table. This proves the Schengen-style day count comes out identical
// through that new path — countTravelDays itself is untouched, so this is really testing that the
// entities round trip (JSON-encode on save, JSON-decode + re-sort on read) preserves the exact
// values the day-counter depends on.
describe("countTravelDays via the entities-backed checkin store", () => {
  it("counts Schengen days correctly across a border crossing", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("traveldays-regression"));

    const day0 = Date.UTC(2024, 0, 1, 8, 0, 0); // 2024-01-01, enters France (Schengen)
    const day4 = Date.UTC(2024, 0, 5, 8, 0, 0); // 2024-01-05, crosses into the UK (not Schengen)
    const windowStart = day0;
    const windowEnd = Date.UTC(2024, 0, 7, 8, 0, 0); // 2024-01-07

    saveCheckin(user.id, { country: "France", city: "Paris", checkedInAt: day0 });
    saveCheckin(user.id, { country: "United Kingdom", city: "London", checkedInAt: day4 });

    const checkins = listAllCheckinsAscending(user.id);
    expect(checkins).toHaveLength(2);
    expect(checkins[0].country).toBe("France");
    expect(checkins[1].country).toBe("United Kingdom");

    const result = countTravelDays(checkins, "schengen", windowStart, windowEnd);
    expect(result.totalDaysInWindow).toBe(7);
    expect(result.daysPresent).toBe(4); // Jan 1-4 in France; Jan 5-7 in the UK don't count
  });
});
