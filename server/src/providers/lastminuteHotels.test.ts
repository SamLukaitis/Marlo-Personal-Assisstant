import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { searchLastminuteHotels, isLastminuteHotelsEnabled, setLastminuteClientForTest } from "./lastminuteHotels.js";
import type { McpClient } from "../services/mcpClient.js";

const originalEnv = { ...process.env };
const callTool = vi.fn();
const fakeClient: McpClient = { callTool, listToolNames: async () => [], close: async () => {} };

function hotel(index: number, name: string, priceTotal: number, extra: Record<string, unknown> = {}) {
  return {
    index,
    internal_id_hotel: 1000 + index,
    name,
    stars: 4,
    rating: 87,
    reviews: 1165,
    distance_km: 0.2,
    facilities: ["Free WiFi", "Restaurant", "Bar", "Spa", "Pool", "Gym", "Parking"],
    image: "https://hotels.staticroot.com/x.jpg",
    price_total: priceTotal,
    currency: "GBP",
    cancellable: false,
    flight_direct: false,
    carrier: "",
    ...extra,
  };
}

const RESOLVED = { success: true, id: "150683", name: "Lisbon", country: "Portugal", country_code: "PT" };
const SEARCH = {
  success: true,
  showing_results: 3,
  price_range: { min: 300, max: 731.62, currency: "GBP" },
  products_summary: [
    hotel(1, "Pestana CR7 Lisboa", 731.62),
    hotel(2, "Casa Simples", 300, { stars: 0, rating: 0, cancellable: true }),
    hotel(3, "Hotel Mid", 450, { cancellable: true }),
  ],
  search_id: 744670011,
  message: "Prices shown are indicative.",
  _display_hint: "MUST render ALL hotels as a Markdown table",
};

function respond(resolve: unknown = RESOLVED, search: unknown = SEARCH) {
  callTool.mockReset().mockImplementation(async (name: string) => (name === "resolve_destination_id" ? resolve : search));
}

beforeEach(() => {
  respond();
  setLastminuteClientForTest(fakeClient);
});

afterEach(() => {
  setLastminuteClientForTest(null);
  process.env = { ...originalEnv };
});

const INPUT = { location: "Lisbon", checkIn: "2026-11-12", checkOut: "2026-11-15" };

describe("isLastminuteHotelsEnabled", () => {
  it("is on unless LASTMINUTE_HOTELS is off", () => {
    delete process.env.LASTMINUTE_HOTELS;
    expect(isLastminuteHotelsEnabled()).toBe(true);
    process.env.LASTMINUTE_HOTELS = " Off ";
    expect(isLastminuteHotelsEnabled()).toBe(false);
  });
});

describe("searchLastminuteHotels — request", () => {
  it("resolves the city, then searches with lastminute's arguments", async () => {
    await searchLastminuteHotels({ ...INPUT, adults: 1, sort: "highest_rating", minStars: 3, maxPricePerNight: 200, freeCancellation: true });
    expect(callTool).toHaveBeenNthCalledWith(1, "resolve_destination_id", { lang: "en", city_name: "Lisbon" });
    expect(callTool).toHaveBeenNthCalledWith(2, "search_only_hotel", {
      destination: "150683",
      date_from: "2026-11-12",
      date_to: "2026-11-15",
      adults: "1",
      lang: "en",
      sort: "review_score",
      max_results: 20,
      accommodation_type: "1,2,3,5,6,7,8,9,10,12,13,14",
      hotel_stars: "3,4,5",
    });
  });

  it("defaults to 2 adults sorted by lastminute's recommendation", async () => {
    await searchLastminuteHotels(INPUT);
    const args = callTool.mock.calls[1][1];
    expect(args).toMatchObject({ adults: "2", sort: "recommended" });
    expect(args).not.toHaveProperty("hotel_stars");
    expect(args).not.toHaveProperty("price");
  });

  it("falls back to the city part of an area it doesn't know", async () => {
    callTool.mockReset().mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name !== "resolve_destination_id") return SEARCH;
      return args.city_name === "Lisbon" ? RESOLVED : { success: false, message: "No exact match found.", suggestions: [] };
    });
    const result = await searchLastminuteHotels({ ...INPUT, location: "Alfama, Lisbon" });
    expect(callTool.mock.calls.map((c) => c[1].city_name ?? c[0])).toEqual(["Alfama, Lisbon", "Lisbon", "search_only_hotel"]);
    expect(result.location).toBe("Lisbon");
  });

  it("returns the suggestions instead of searching when the city isn't recognised", async () => {
    respond({
      success: false,
      message: "No exact match found. Suggestions returned.",
      suggestions: [
        { id: "1", name: "Paris", country: "France" },
        { id: "2", name: "Paris", country: "United States" },
      ],
    });
    const result = await searchLastminuteHotels({ ...INPUT, location: "Pariss" });
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(result.hotels).toEqual([]);
    expect(result.message).toBe('lastminute.com didn\'t recognise "Pariss" as a city. Did they mean: Paris, France; Paris, United States?');
  });

  it("throws when lastminute reports an error", async () => {
    respond({ success: false, error: "hints API unavailable" });
    await expect(searchLastminuteHotels(INPUT)).rejects.toThrow("hints API unavailable");
  });
});

describe("searchLastminuteHotels — response", () => {
  it("reshapes hotels into the Google Hotels result format with Booking.com links", async () => {
    const result = await searchLastminuteHotels(INPUT);
    expect(result.source).toContain("lastminute.com");
    expect(result).toMatchObject({ location: "Lisbon", nights: 3, adults: 2, currency: "GBP" });
    expect(result.hotels[0]).toEqual({
      name: "Pestana CR7 Lisboa",
      stars: 4,
      rating: "8.7/10 (1165 reviews)",
      totalPrice: 731.62,
      pricePerNight: 243.87,
      freeCancellation: false,
      amenities: ["Free WiFi", "Restaurant", "Bar", "Spa", "Pool", "Gym"],
      distanceKmFromCentre: 0.2,
      bookingUrl:
        "https://www.booking.com/searchresults.html?ss=Pestana+CR7+Lisboa%2C+Lisbon&checkin=2026-11-12&checkout=2026-11-15&group_adults=2&no_rooms=1",
    });
    // No stars or rating from lastminute means unknown, not zero.
    expect(result.hotels[1].stars).toBeUndefined();
    expect(result.hotels[1].rating).toBeUndefined();
  });

  it("filters by nightly price and free cancellation here", async () => {
    const result = await searchLastminuteHotels({ ...INPUT, maxPricePerNight: 160, freeCancellation: true });
    expect(result.hotels.map((h) => h.name)).toEqual(["Casa Simples", "Hotel Mid"]);
  });

  it("doesn't apply a budget in a currency lastminute can't price in", async () => {
    const result = await searchLastminuteHotels({ ...INPUT, maxPricePerNight: 160, currency: "eur" });
    expect(result.hotels).toHaveLength(3);
    expect(result.currency).toBe("GBP");
    expect(result.priceIs).toContain("can't price in EUR, so the budget wasn't applied");
  });

  it("says so when the filters leave nothing", async () => {
    const result = await searchLastminuteHotels({ ...INPUT, maxPricePerNight: 50 });
    expect(result.hotels).toEqual([]);
    expect(result.message).toBe("No hotels found for that search.");
  });

  it("caps the number of hotels", async () => {
    respond(RESOLVED, { ...SEARCH, products_summary: Array.from({ length: 20 }, (_, i) => hotel(i + 1, `H${i}`, 300)) });
    expect((await searchLastminuteHotels(INPUT)).hotels).toHaveLength(6);
  });

  it("passes a truncated raw payload through when the shape is unrecognised", async () => {
    respond(RESOLVED, { results: "x".repeat(5000) });
    const result = await searchLastminuteHotels(INPUT);
    expect(result.hotels).toEqual([]);
    expect(result.raw).toHaveLength(3000);
  });
});
