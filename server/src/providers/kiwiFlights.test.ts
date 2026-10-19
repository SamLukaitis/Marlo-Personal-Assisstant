import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { searchKiwiFlights, isKiwiFlightsEnabled, setKiwiClientForTest } from "./kiwiFlights.js";
import type { McpClient } from "../services/mcpClient.js";

const originalEnv = { ...process.env };
const callTool = vi.fn();
const fakeClient: McpClient = { callTool, listToolNames: async () => [], close: async () => {} };

function seg(carrierName: string, flightNumber: string, from: string, dep: string, to: string, arr: string, durationSeconds: number) {
  return { from, to, fromCity: "X", toCity: "Y", departureTime: dep, arrivalTime: arr, durationSeconds, carrier: "XX", carrierName, flightNumber, cabinClass: "Economy" };
}

const SAMPLE = {
  query: "London → Barcelona",
  currency: "GBP",
  resultsCount: 2,
  itineraries: [
    {
      id: "a",
      price: 79,
      priceFormatted: "79 GBP",
      bookingUrl: "https://kiwi.com/u/abc",
      imageId: "barcelona_es",
      baggage: { personalItem: 1, cabinBag: 0, checkedBag: 0 },
      outbound: {
        from: "STN",
        to: "BCN",
        durationSeconds: 7800,
        segments: [seg("Ryanair", "FR8214", "STN", "2026-11-20T21:15:00", "BCN", "2026-11-21T00:25:00", 7800)],
      },
      inbound: {
        from: "BCN",
        to: "LTN",
        segments: [seg("Wizz Air UK", "W95378", "BCN", "2026-11-23T16:10:00", "LTN", "2026-11-23T17:35:00", 8700)],
      },
    },
    {
      id: "b",
      price: 140,
      bookingUrl: "https://kiwi.com/u/def",
      baggage: { personalItem: 1, cabinBag: 1, checkedBag: 2 },
      outbound: {
        durationSeconds: 21600,
        segments: [
          seg("TAP Portugal", "TP1363", "LHR", "2026-11-20T06:00:00", "LIS", "2026-11-20T08:40:00", 9600),
          seg("TAP Portugal", "TP1030", "LIS", "2026-11-20T10:10:00", "BCN", "2026-11-20T13:00:00", 7800),
        ],
      },
      inbound: { segments: [seg("TAP Portugal", "TP1031", "BCN", "2026-11-23T14:00:00", "LHR", "2026-11-23T15:00:00", 7200)] },
    },
  ],
  searchTimeMs: 2000,
  error: null,
};

beforeEach(() => {
  callTool.mockReset().mockResolvedValue(SAMPLE);
  setKiwiClientForTest(fakeClient);
});

afterEach(() => {
  setKiwiClientForTest(null);
  process.env = { ...originalEnv };
});

describe("isKiwiFlightsEnabled", () => {
  it("is on unless KIWI_FLIGHTS is off", () => {
    delete process.env.KIWI_FLIGHTS;
    expect(isKiwiFlightsEnabled()).toBe(true);
    process.env.KIWI_FLIGHTS = " OFF ";
    expect(isKiwiFlightsEnabled()).toBe(false);
  });
});

describe("searchKiwiFlights — request", () => {
  it("maps a round trip into Kiwi's arguments, with self-transfer off", async () => {
    await searchKiwiFlights({
      from: "LHR,LGW",
      to: "BCN",
      departDate: "2026-11-20",
      returnDate: "2026-11-23",
      adults: 2,
      cabin: "business",
      maxStops: 0,
      currency: "eur",
      returnFor: "serpapi-token",
    });
    expect(callTool).toHaveBeenCalledWith("search-flight", {
      flyFrom: "LHR,LGW",
      flyTo: "BCN",
      departureDate: "20/11/2026",
      returnDate: "23/11/2026",
      adults: 2,
      currency: "EUR",
      locale: "en",
      sort: "price",
      allow_self_transfer: false,
      cabinClass: "C",
      max_sector_stopovers: 0,
    });
  });

  it("defaults to one adult in GBP with no optional filters", async () => {
    await searchKiwiFlights({ from: "LHR", to: "BCN", departDate: "2026-11-20" });
    const args = callTool.mock.calls[0][1];
    expect(args).toMatchObject({ adults: 1, currency: "GBP", departureDate: "20/11/2026" });
    expect(args).not.toHaveProperty("returnDate");
    expect(args).not.toHaveProperty("cabinClass");
    expect(args).not.toHaveProperty("max_sector_stopovers");
  });
});

describe("searchKiwiFlights — response", () => {
  it("reshapes itineraries into the Google Flights result format", async () => {
    const result = await searchKiwiFlights({ from: "LON", to: "BCN", departDate: "2026-11-20", returnDate: "2026-11-23" });
    expect(result.source).toContain("Kiwi.com");
    expect(result.roundTrip).toBe(true);
    expect(result.priceIs).toBe("round-trip total for 1 adult(s), GBP, including return flights");
    expect(result.flights[0]).toEqual({
      airlines: ["Ryanair", "Wizz Air UK"],
      stops: 0,
      price: 79,
      totalDurationMinutes: 130,
      bookingUrl: "https://kiwi.com/u/abc",
      legs: [
        { airline: "Ryanair", flightNumber: "FR8214", from: "STN", departs: "2026-11-20 21:15", to: "BCN", arrives: "2026-11-21 00:25", durationMinutes: 130, overnight: true },
      ],
      returnLegs: [
        { airline: "Wizz Air UK", flightNumber: "W95378", from: "BCN", departs: "2026-11-23 16:10", to: "LTN", arrives: "2026-11-23 17:35", durationMinutes: 145 },
      ],
      notes: [
        "Price includes 1 personal item, no cabin bag, no checked bag",
        "Flies home to LTN, not STN",
        "Out and back are on different airlines, as separate tickets",
      ],
    });
  });

  it("works out layovers between connecting legs", async () => {
    const result = await searchKiwiFlights({ from: "LHR", to: "BCN", departDate: "2026-11-20", returnDate: "2026-11-23" });
    const option = result.flights[1];
    expect(option.stops).toBe(1);
    expect(option.layovers).toEqual([{ airport: "LIS", durationMinutes: 90 }]);
    expect(option.notes).toEqual(["Price includes 1 personal item, 1 cabin bag, 2 checked bags"]);
  });

  it("caps the number of options", async () => {
    callTool.mockResolvedValueOnce({ ...SAMPLE, itineraries: Array.from({ length: 12 }, () => SAMPLE.itineraries[0]) });
    const result = await searchKiwiFlights({ from: "LHR", to: "BCN", departDate: "2026-11-20" });
    expect(result.flights).toHaveLength(6);
  });

  it("treats no itineraries as an empty answer", async () => {
    callTool.mockResolvedValueOnce({ ...SAMPLE, resultsCount: 0, itineraries: [] });
    const result = await searchKiwiFlights({ from: "LHR", to: "XXQ", departDate: "2026-11-20" });
    expect(result.flights).toEqual([]);
    expect(result.message).toBe("No flights found for that search.");
  });

  it("throws when Kiwi reports an error", async () => {
    callTool.mockResolvedValueOnce({ ...SAMPLE, itineraries: [], error: "Invalid date" });
    await expect(searchKiwiFlights({ from: "LHR", to: "BCN", departDate: "2026-11-20" })).rejects.toThrow("Invalid date");
  });

  it("passes a truncated raw payload through when the shape is unrecognised", async () => {
    callTool.mockResolvedValueOnce({ results: "x".repeat(5000) });
    const result = await searchKiwiFlights({ from: "LHR", to: "BCN", departDate: "2026-11-20" });
    expect(result.flights).toEqual([]);
    expect(result.raw).toHaveLength(3000);
  });
});
