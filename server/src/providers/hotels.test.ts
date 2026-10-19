import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { searchHotels, isHotelsConfigured, nightsBetween } from "./hotels.js";

const originalEnv = { ...process.env };
const fetchMock = vi.fn();

function property(name: string, perNight: number | null, extra: Record<string, unknown> = {}) {
  return {
    type: "hotel",
    name,
    description: "A long description the model doesn't need",
    link: `https://${name.toLowerCase().replace(/\s+/g, "")}.example.com`,
    gps_coordinates: { latitude: 38.71, longitude: -9.14 },
    check_in_time: "3:00 PM",
    ...(perNight === null
      ? {}
      : {
          rate_per_night: { lowest: `£${perNight}`, extracted_lowest: perNight, before_taxes_fees: "£1", extracted_before_taxes_fees: 1 },
          total_rate: { lowest: `£${perNight * 3}`, extracted_lowest: perNight * 3 },
        }),
    images: [{ thumbnail: "https://img.example.com/t.jpg", original_image: "https://img.example.com/o.jpg" }],
    nearby_places: [{ name: "Rossio", transportations: [{ type: "Walking", duration: "5 min" }] }],
    hotel_class: "4-star hotel",
    extracted_hotel_class: 4,
    overall_rating: 4.4,
    reviews: 1520,
    amenities: ["Free Wi-Fi", "Breakfast ($)", "Pool", "Air conditioning", "Bar", "Restaurant", "Spa", "Gym"],
    property_token: "tok",
    ...extra,
  };
}

const SAMPLE = {
  search_metadata: { status: "Success", google_hotels_url: "https://www.google.com/travel/search?q=Lisbon" },
  ads: [{ name: "Sponsored Hotel", extracted_price: 50 }],
  properties: [
    property("Sold Out Inn", null),
    property("Hotel Avenida", 120, {
      deal: "22% less than usual",
      deal_description: "Great deal",
      prices: [
        { source: "Booking.com", logo: "x", rate_per_night: { lowest: "£120", extracted_lowest: 120 }, free_cancellation: true },
        { source: "Expedia", rate_per_night: { lowest: "£125", extracted_lowest: 125 } },
        { source: "Hotels.com", rate_per_night: { extracted_lowest: 126 } },
        { source: "Agoda", rate_per_night: { extracted_lowest: 130 } },
      ],
    }),
    property("Casa Baixa", 95, { extracted_hotel_class: undefined, hotel_class: "3-star hotel", link: undefined }),
  ],
};

function okJson(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

beforeEach(() => {
  process.env.SERPAPI_API_KEY = "serp-key";
  fetchMock.mockReset().mockResolvedValue(okJson(SAMPLE));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...originalEnv };
});

const INPUT = { location: "Lisbon", checkIn: "2026-11-12", checkOut: "2026-11-15" };

describe("isHotelsConfigured / nightsBetween", () => {
  it("needs a SerpApi key", () => {
    expect(isHotelsConfigured()).toBe(true);
    process.env.SERPAPI_API_KEY = "  ";
    expect(isHotelsConfigured()).toBe(false);
  });

  it("counts whole nights", () => {
    expect(nightsBetween("2026-11-12", "2026-11-15")).toBe(3);
    expect(nightsBetween("2026-11-15", "2026-11-12")).toBe(-3);
    expect(nightsBetween("bad", "2026-11-12")).toBe(0);
  });
});

describe("searchHotels — request", () => {
  it("maps every filter into SerpApi's parameters", async () => {
    await searchHotels({ ...INPUT, adults: 1, sort: "lowest_price", maxPricePerNight: 150.7, minStars: 4, freeCancellation: true, currency: "eur" });
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.origin + url.pathname).toBe("https://serpapi.com/search.json");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      engine: "google_hotels",
      api_key: "serp-key",
      q: "Lisbon",
      check_in_date: "2026-11-12",
      check_out_date: "2026-11-15",
      adults: "1",
      currency: "EUR",
      gl: "uk",
      hl: "en",
      sort_by: "3",
      max_price: "150",
      hotel_class: "4,5",
      free_cancellation: "true",
    });
  });

  it("defaults to 2 adults in GBP, sorted by relevance, with no filters", async () => {
    await searchHotels(INPUT);
    const params = new URL(fetchMock.mock.calls[0][0] as string).searchParams;
    expect(params.get("adults")).toBe("2");
    expect(params.get("currency")).toBe("GBP");
    for (const p of ["sort_by", "max_price", "hotel_class", "free_cancellation"]) expect(params.has(p)).toBe(false);
  });
});

describe("searchHotels — response", () => {
  it("trims each property, leaves out ads and puts unpriced places last", async () => {
    const result = await searchHotels(INPUT);
    expect(result).toMatchObject({
      location: "Lisbon",
      nights: 3,
      adults: 2,
      currency: "GBP",
      googleHotelsUrl: "https://www.google.com/travel/search?q=Lisbon",
    });
    expect(result.source).toBeUndefined();
    expect(result.hotels.map((h) => h.name)).toEqual(["Hotel Avenida", "Casa Baixa", "Sold Out Inn"]);
    expect(result.hotels[0]).toEqual({
      name: "Hotel Avenida",
      kind: "hotel",
      stars: 4,
      rating: "4.4/5 (1520 reviews)",
      pricePerNight: 120,
      totalPrice: 360,
      deal: "Great deal",
      amenities: ["Free Wi-Fi", "Breakfast ($)", "Pool", "Air conditioning", "Bar", "Restaurant"],
      sellers: [
        { source: "Booking.com", perNight: 120, freeCancellation: true },
        { source: "Expedia", perNight: 125 },
        { source: "Hotels.com", perNight: 126 },
      ],
      website: "https://hotelavenida.example.com",
    });
    expect(result.hotels[1]).toMatchObject({ stars: 3, pricePerNight: 95 });
    expect(result.hotels[1].website).toBeUndefined();
    expect(result.hotels[2].pricePerNight).toBeUndefined();
  });

  it("caps the number of hotels", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ ...SAMPLE, properties: Array.from({ length: 15 }, (_, i) => property(`H${i}`, 100 + i)) }));
    expect((await searchHotels(INPUT)).hotels).toHaveLength(6);
  });

  it("treats Google's no-results error as an empty answer", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ error: "Google Hotels hasn't returned any results for this query." }));
    const result = await searchHotels(INPUT);
    expect(result.hotels).toEqual([]);
    expect(result.message).toBe("No hotels found for that search.");
  });

  it("throws on any other error", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ error: "Your account has run out of searches." }, 429));
    await expect(searchHotels(INPUT)).rejects.toThrow("run out of searches");
    fetchMock.mockResolvedValueOnce(okJson(null, 502));
    await expect(searchHotels(INPUT)).rejects.toThrow("HTTP 502");
  });

  it("passes a truncated raw payload through when the shape is unrecognised", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ name: "One Hotel", description: "x".repeat(5000) }));
    const result = await searchHotels(INPUT);
    expect(result.hotels).toEqual([]);
    expect(result.raw).toHaveLength(3000);
  });
});
