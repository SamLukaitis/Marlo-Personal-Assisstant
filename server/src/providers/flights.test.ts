import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { searchFlights, isFlightsConfigured } from "./flights.js";

const originalEnv = { ...process.env };
const fetchMock = vi.fn();

function leg(airline: string, num: string, from: string, dep: string, to: string, arr: string, duration: number) {
  return {
    departure_airport: { name: `${from} Airport`, id: from, time: dep },
    arrival_airport: { name: `${to} Airport`, id: to, time: arr },
    duration,
    airplane: "Airbus A320",
    airline,
    airline_logo: "https://www.gstatic.com/flights/airline_logos/70px/XX.png",
    travel_class: "Economy",
    flight_number: num,
    legroom: "29 in",
    extensions: ["Average legroom (29 in)", "Carbon emissions estimate: 85 kg"],
  };
}

const SAMPLE = {
  search_metadata: { status: "Success", google_flights_url: "https://www.google.com/travel/flights?hl=en&q=x" },
  best_flights: [
    {
      flights: [leg("British Airways", "BA 478", "LHR", "2026-11-20 07:05", "BCN", "2026-11-20 10:20", 135)],
      total_duration: 135,
      price: 142,
      type: "Round trip",
      extensions: ["Checked baggage for a fee"],
      departure_token: "tok-ba",
      carbon_emissions: { this_flight: 85000 },
    },
  ],
  other_flights: [
    {
      flights: [
        { ...leg("Vueling", "VY 7821", "LGW", "2026-11-20 06:00", "ORY", "2026-11-20 08:15", 75), often_delayed_by_over_30_min: true },
        { ...leg("Vueling", "VY 1001", "ORY", "2026-11-20 11:00", "BCN", "2026-11-20 12:40", 100), overnight: false },
      ],
      layovers: [{ duration: 165, name: "Paris Orly", id: "ORY" }],
      total_duration: 400,
      price: 120,
      departure_token: "tok-vy",
    },
    {
      flights: [leg("Ryanair", "FR 1234", "STN", "2026-11-20 21:15", "BCN", "2026-11-21 00:25", 130)],
      total_duration: 130,
      price: 71,
      departure_token: "tok-fr",
    },
  ],
  price_insights: { lowest_price: 71, price_level: "low", typical_price_range: [90, 160], price_history: [[1, 2]] },
};

function respond(body: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce({ ok: status < 400, status, json: async () => body });
}

function calledParams(): URLSearchParams {
  return new URL(fetchMock.mock.calls[0][0] as string).searchParams;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  process.env.SERPAPI_API_KEY = "serp-key";
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...originalEnv };
});

describe("isFlightsConfigured", () => {
  it("is true only with a non-blank key", () => {
    expect(isFlightsConfigured()).toBe(true);
    process.env.SERPAPI_API_KEY = "  ";
    expect(isFlightsConfigured()).toBe(false);
  });
});

describe("searchFlights — request", () => {
  it("sends a round trip with the mapped options", async () => {
    respond(SAMPLE);
    await searchFlights({
      from: " LHR,LGW ",
      to: "BCN",
      departDate: "2026-11-20",
      returnDate: "2026-11-23",
      adults: 2,
      cabin: "business",
      maxStops: 0,
      currency: "eur",
    });
    const p = calledParams();
    expect(p.get("engine")).toBe("google_flights");
    expect(p.get("api_key")).toBe("serp-key");
    expect(p.get("departure_id")).toBe("LHR,LGW");
    expect(p.get("arrival_id")).toBe("BCN");
    expect(p.get("outbound_date")).toBe("2026-11-20");
    expect(p.get("return_date")).toBe("2026-11-23");
    expect(p.get("type")).toBe("1");
    expect(p.get("adults")).toBe("2");
    expect(p.get("travel_class")).toBe("3");
    expect(p.get("stops")).toBe("1");
    expect(p.get("currency")).toBe("EUR");
  });

  it("defaults to a one-way, one adult, GBP search with no optional filters", async () => {
    respond(SAMPLE);
    await searchFlights({ from: "LHR", to: "BCN", departDate: "2026-11-20" });
    const p = calledParams();
    expect(p.get("type")).toBe("2");
    expect(p.get("currency")).toBe("GBP");
    for (const k of ["return_date", "adults", "travel_class", "stops", "departure_token"]) expect(p.has(k)).toBe(false);
  });

  it("passes returnFor as the departure token", async () => {
    respond(SAMPLE);
    await searchFlights({ from: "LHR", to: "BCN", departDate: "2026-11-20", returnDate: "2026-11-23", returnFor: "tok-ba" });
    expect(calledParams().get("departure_token")).toBe("tok-ba");
  });
});

describe("searchFlights — response", () => {
  it("trims options: best first, then the rest cheapest first", async () => {
    respond(SAMPLE);
    const r = await searchFlights({ from: "LON", to: "BCN", departDate: "2026-11-20", returnDate: "2026-11-23" });

    expect(r.roundTrip).toBe(true);
    expect(r.priceIs).toBe("round-trip total for 1 adult(s), GBP");
    expect(r.googleFlightsUrl).toBe("https://www.google.com/travel/flights?hl=en&q=x");
    expect(r.flights.map((f) => f.price)).toEqual([142, 71, 120]);
    expect(r.flights[0]).toEqual({
      price: 142,
      best: true,
      airlines: ["British Airways"],
      stops: 0,
      totalDurationMinutes: 135,
      legs: [
        {
          airline: "British Airways",
          flightNumber: "BA 478",
          from: "LHR",
          departs: "2026-11-20 07:05",
          to: "BCN",
          arrives: "2026-11-20 10:20",
          durationMinutes: 135,
        },
      ],
      notes: ["Checked baggage for a fee"],
      returnFor: "tok-ba",
    });
    const vueling = r.flights[2];
    expect(vueling.stops).toBe(1);
    expect(vueling.airlines).toEqual(["Vueling"]);
    expect(vueling.layovers).toEqual([{ airport: "ORY", durationMinutes: 165 }]);
    expect(vueling.legs[0].oftenDelayed).toBe(true);
    expect(r.priceInsights).toEqual({ lowest: 71, level: "low", typicalRange: [90, 160] });
    expect(JSON.stringify(r)).not.toContain("airline_logo");
    expect(JSON.stringify(r)).not.toContain("legroom");
  });

  it("omits returnFor on one-way searches and on the return leg itself", async () => {
    respond(SAMPLE);
    const oneWay = await searchFlights({ from: "LHR", to: "BCN", departDate: "2026-11-20" });
    expect(oneWay.flights.some((f) => f.returnFor)).toBe(false);
    expect(oneWay.priceIs).toBe("one-way for 1 adult(s), GBP");

    respond(SAMPLE);
    const returns = await searchFlights({ from: "LHR", to: "BCN", departDate: "2026-11-20", returnDate: "2026-11-23", returnFor: "tok-ba" });
    expect(returns.flights.some((f) => f.returnFor)).toBe(false);
  });

  it("caps the number of options", async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ ...SAMPLE.other_flights[1], price: 100 + i }));
    respond({ ...SAMPLE, best_flights: [], other_flights: many });
    const r = await searchFlights({ from: "LHR", to: "BCN", departDate: "2026-11-20" });
    expect(r.flights).toHaveLength(6);
  });

  it("treats SerpApi's no-results error as an empty answer", async () => {
    respond({ error: "Google Flights hasn't returned any results for this query." });
    const r = await searchFlights({ from: "LHR", to: "BCN", departDate: "2026-11-20" });
    expect(r.flights).toEqual([]);
    expect(r.message).toBe("No flights found for that search.");
  });

  it("throws other SerpApi errors", async () => {
    respond({ error: "Invalid API key. Your API key should be here: https://serpapi.com/manage-api-key" }, 401);
    await expect(searchFlights({ from: "LHR", to: "BCN", departDate: "2026-11-20" })).rejects.toThrow("Invalid API key");
  });

  it("throws on an HTTP failure with no error body", async () => {
    respond(null, 503);
    await expect(searchFlights({ from: "LHR", to: "BCN", departDate: "2026-11-20" })).rejects.toThrow("HTTP 503");
  });

  it("passes a truncated raw payload through when the shape is unrecognised", async () => {
    respond({ something_new: "x".repeat(5000) });
    const r = await searchFlights({ from: "LHR", to: "BCN", departDate: "2026-11-20" });
    expect(r.flights).toEqual([]);
    expect(r.raw?.length).toBe(3000);
  });
});
