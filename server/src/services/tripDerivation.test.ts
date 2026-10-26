import { describe, expect, it } from "vitest";
import { deriveTrips, parseCountry } from "./tripDerivation.js";
import type { BookingData } from "./entityValidation.js";

const hotel = (id: number, startDate: string, endDate: string | null, name = "Hotel Eva, Faro") => ({
  id,
  data: { kind: "hotel", name, reference: "R1", startDate, endDate } as BookingData,
});
const flight = (id: number, startDate: string, name = "FR1234 LIS→FAO") => ({
  id,
  data: { kind: "flight", name, reference: "R1", startDate, endDate: null } as BookingData,
});

const TODAY = "2099-01-01";

describe("deriveTrips", () => {
  it("makes one trip from a hotel stay, keyed by its booking", () => {
    expect(deriveTrips([hotel(5, "2099-03-10", "2099-03-17")], TODAY)).toEqual([
      { key: "5", startDate: "2099-03-10", endDate: "2099-03-17", destination: "Hotel Eva, Faro" },
    ]);
  });

  it("joins flights and a stay that are close in time, and keys the trip by the earliest booking", () => {
    const trips = deriveTrips(
      [hotel(9, "2099-03-10", "2099-03-17"), flight(7, "2099-03-09"), flight(8, "2099-03-18", "FR9 FAO→LIS")],
      TODAY
    );
    expect(trips).toHaveLength(1);
    expect(trips[0]).toMatchObject({ key: "7", startDate: "2099-03-09", endDate: "2099-03-18" });
  });

  it("makes a trip from an outbound and a return flight with no hotel", () => {
    const trips = deriveTrips([flight(1, "2099-05-01"), flight(2, "2099-05-08", "FR2 FAO→LIS")], TODAY);
    expect(trips).toEqual([
      expect.objectContaining({ key: "1", startDate: "2099-05-01", endDate: "2099-05-08" }),
    ]);
    expect(trips[0].destination).toContain("FAO");
  });

  it("reads connecting flights as one leg, so an outbound with a connection is not mistaken for a return", () => {
    const trips = deriveTrips(
      [
        flight(1, "2099-05-01", "BA1 LHR→MAD"),
        flight(2, "2099-05-01", "BA2 MAD→FAO"),
        flight(3, "2099-05-08", "BA3 FAO→MAD"),
        flight(4, "2099-05-08", "BA4 MAD→LHR"),
      ],
      TODAY
    );
    expect(trips).toEqual([expect.objectContaining({ key: "1", startDate: "2099-05-01", endDate: "2099-05-08" })]);
    expect(trips[0].destination).toContain("FAO");
  });

  it("pairs flights in order into separate trips, and skips an outbound with no return in sight", () => {
    const trips = deriveTrips(
      [
        flight(1, "2099-02-01"),
        flight(2, "2099-02-05"),
        flight(3, "2099-06-01"),
        flight(4, "2099-09-01"),
        flight(5, "2099-09-04"),
      ],
      TODAY
    );
    expect(trips.map((t) => [t.key, t.startDate, t.endDate])).toEqual([
      ["1", "2099-02-01", "2099-02-05"],
      ["4", "2099-09-01", "2099-09-04"],
    ]);
  });

  it("does not make a trip from a lone one-way flight, or a stay with no check-out", () => {
    expect(deriveTrips([flight(1, "2099-05-01")], TODAY)).toEqual([]);
    expect(deriveTrips([hotel(1, "2099-05-01", null)], TODAY)).toEqual([]);
  });

  it("keeps trips far apart separate, soonest first", () => {
    const trips = deriveTrips([hotel(2, "2099-06-01", "2099-06-03"), hotel(1, "2099-03-01", "2099-03-03")], TODAY);
    expect(trips.map((t) => t.key)).toEqual(["1", "2"]);
  });

  it("drops trips that are over but keeps one under way", () => {
    expect(deriveTrips([hotel(1, "2098-12-01", "2098-12-05")], TODAY)).toEqual([]);
    expect(deriveTrips([hotel(1, "2098-12-30", "2099-01-03")], TODAY)).toHaveLength(1);
  });
});

describe("parseCountry", () => {
  it("keeps a plain country name", () => {
    expect(parseCountry("Portugal")).toBe("Portugal");
    expect(parseCountry('"Portugal".')).toBe("Portugal");
  });

  it("refuses anything that isn't clearly a country", () => {
    expect(parseCountry("UNKNOWN")).toBeNull();
    expect(parseCountry("I'm not sure which country")).toBeNull();
    expect(parseCountry("")).toBeNull();
    expect(parseCountry("Hotel Eva, 12 Rua de Faro 8000")).toBeNull();
  });
});
