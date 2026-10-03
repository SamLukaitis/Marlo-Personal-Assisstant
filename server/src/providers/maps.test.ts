import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { McpClient } from "../services/mcpClient.js";
import { isMapsConfigured, searchPlaces, computeRoute, setMapsClientForTest } from "./maps.js";

const originalEnv = { ...process.env };

function stubClient(result: unknown, toolNames = ["search_places", "compute_routes"]): McpClient & { callTool: ReturnType<typeof vi.fn> } {
  return {
    callTool: vi.fn().mockResolvedValue(result),
    listToolNames: vi.fn().mockResolvedValue(toolNames),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  process.env.GOOGLE_MAPS_API_KEY = "test-maps-key";
});

afterEach(() => {
  setMapsClientForTest(null);
  process.env = { ...originalEnv };
});

describe("isMapsConfigured", () => {
  it("is false without a key or with a blank key, true with one", () => {
    delete process.env.GOOGLE_MAPS_API_KEY;
    expect(isMapsConfigured()).toBe(false);
    process.env.GOOGLE_MAPS_API_KEY = "   ";
    expect(isMapsConfigured()).toBe(false);
    process.env.GOOGLE_MAPS_API_KEY = "k";
    expect(isMapsConfigured()).toBe(true);
  });
});

describe("searchPlaces", () => {
  it("sends text_query and a circle location_bias when near is given", async () => {
    const client = stubClient({ places: [] });
    setMapsClientForTest(client);

    await searchPlaces({ query: "pharmacy open now", near: { latitude: 51.53, longitude: -0.12 }, radiusMeters: 1500 });

    expect(client.callTool).toHaveBeenCalledWith("search_places", {
      text_query: "pharmacy open now",
      location_bias: { circle: { center: { latitude: 51.53, longitude: -0.12 }, radius_meters: 1500 } },
    });
  });

  it("defaults the radius to 2000 m and omits location_bias without near", async () => {
    const client = stubClient({ places: [] });
    setMapsClientForTest(client);

    await searchPlaces({ query: "ramen", near: { latitude: 1, longitude: 2 } });
    expect(client.callTool.mock.calls[0][1].location_bias.circle.radius_meters).toBe(2000);

    await searchPlaces({ query: "ramen in Lisbon" });
    expect(client.callTool.mock.calls[1][1]).toEqual({ text_query: "ramen in Lisbon" });
  });

  it("trims each place to the fields the model needs and keeps attribution", async () => {
    setMapsClientForTest(
      stubClient({
        summary: "Two pharmacies nearby.",
        attribution: { text: "Google Maps" },
        places: [
          {
            id: "ChIJ1",
            displayName: { text: "Boots" },
            formattedAddress: "1 Euston Rd, London",
            rating: 4.1,
            userRatingCount: 212,
            currentOpeningHours: { openNow: true, weekdayDescriptions: ["Mon: 8–8"] },
            googleMapsUri: "https://maps.google.com/?cid=1",
            reviews: [{ text: "long review..." }],
            photos: [{ name: "p1" }],
          },
          { place_id: "ChIJ2", displayName: "Superdrug", address: "2 Euston Rd", maps_uri: "https://maps.google.com/?cid=2" },
        ],
      })
    );

    const result = await searchPlaces({ query: "pharmacy" });

    expect(result).toEqual({
      summary: "Two pharmacies nearby.",
      attribution: { text: "Google Maps" },
      places: [
        {
          name: "Boots",
          address: "1 Euston Rd, London",
          rating: 4.1,
          ratingCount: 212,
          openNow: true,
          mapsUrl: "https://maps.google.com/?cid=1",
          placeId: "ChIJ1",
        },
        { name: "Superdrug", address: "2 Euston Rd", mapsUrl: "https://maps.google.com/?cid=2", placeId: "ChIJ2" },
      ],
    });
  });

  it("recovers name and rating from Grounding Lite's real shape (attribution title + summary prose)", async () => {
    setMapsClientForTest(
      stubClient({
        summary:
          "**Peptides pharmacy** [0] (5.0★ (1)) is a 24-hour pharmacy offering delivery.\n\n" +
          "**Alrasheed Pharmacy (Alfarabi Pharmacy)** [1] (1.8★ (383)) is an inclusive pharmacy.",
        places: [
          {
            attribution: { title: "Peptides pharmacy - Google Maps", url: "https://www.google.com/maps/place/x" },
            googleMapsLinks: { placeUrl: "https://www.google.com/maps/place/peptides" },
            id: "ChIJ-1238QQbdkgRsHQJeRmsqiI",
            location: { latitude: 51.5314641, longitude: -0.1066709 },
          },
          {
            attribution: { title: "Alrasheed Pharmacy (Alfarabi Pharmacy) - Google Maps" },
            googleMapsLinks: { placeUrl: "https://www.google.com/maps/place/alrasheed" },
            id: "ChIJEaEJMTUFdkgRkuVZ1uqnobo",
            location: { latitude: 51.514754, longitude: -0.1628335 },
          },
        ],
      })
    );

    const result = await searchPlaces({ query: "pharmacy" });

    expect(result.places).toEqual([
      {
        name: "Peptides pharmacy",
        rating: 5,
        ratingCount: 1,
        mapsUrl: "https://www.google.com/maps/place/peptides",
        placeId: "ChIJ-1238QQbdkgRsHQJeRmsqiI",
        summary: "is a 24-hour pharmacy offering delivery.",
      },
      {
        name: "Alrasheed Pharmacy (Alfarabi Pharmacy)",
        rating: 1.8,
        ratingCount: 383,
        mapsUrl: "https://www.google.com/maps/place/alrasheed",
        placeId: "ChIJEaEJMTUFdkgRkuVZ1uqnobo",
        summary: "is an inclusive pharmacy.",
      },
    ]);
    expect(result.raw).toBeUndefined();
  });

  it("caps the list at 8 places", async () => {
    const places = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, displayName: { text: `Place ${i}` } }));
    setMapsClientForTest(stubClient({ places }));

    const result = await searchPlaces({ query: "cafe" });

    expect(result.places).toHaveLength(8);
    expect(result.places[7].name).toBe("Place 7");
  });

  it("returns an empty list for an empty result", async () => {
    setMapsClientForTest(stubClient({ places: [] }));
    await expect(searchPlaces({ query: "nothing here" })).resolves.toEqual({ places: [] });
  });

  it("falls back to a truncated raw payload when the shape is unrecognised", async () => {
    setMapsClientForTest(stubClient({ results: [{ title: "x".repeat(5000) }] }));

    const result = await searchPlaces({ query: "cafe" });

    expect(result.places).toEqual([]);
    expect(result.raw).toBeDefined();
    expect(result.raw!.length).toBeLessThanOrEqual(3000);
    expect(result.raw).toContain("results");
  });

  it("keeps a place that has a Maps link or id but no display name", async () => {
    setMapsClientForTest(stubClient({ summary: "Boots and Superdrug are nearby.", places: [{ id: "ChIJ1", googleMapsUri: "https://maps.google.com/?cid=1" }] }));

    const result = await searchPlaces({ query: "pharmacy" });

    expect(result.places).toEqual([{ mapsUrl: "https://maps.google.com/?cid=1", placeId: "ChIJ1" }]);
    expect(result.summary).toBe("Boots and Superdrug are nearby.");
  });

  it("also attaches raw when places came back but none has a recognisable Maps link", async () => {
    setMapsClientForTest(stubClient({ places: [{ displayName: "Boots", placeUrl: "https://maps.google.com/?cid=9" }] }));

    const result = await searchPlaces({ query: "pharmacy" });

    expect(result.places).toEqual([{ name: "Boots" }]);
    expect(result.raw).toContain("placeUrl");
  });

  it("keeps attribution when falling back to raw", async () => {
    setMapsClientForTest(stubClient({ results: [], attribution: { text: "Google Maps" } }));
    const places = await searchPlaces({ query: "cafe" });
    expect(places.attribution).toEqual({ text: "Google Maps" });

    setMapsClientForTest(stubClient({ legs: [], attribution: "Google Maps" }));
    const route = await computeRoute({ origin: "a", destination: "b", mode: "walk" });
    expect(route.attribution).toBe("Google Maps");
    expect(route.raw).toBeDefined();
  });

  it("wraps a plain-text answer as raw", async () => {
    setMapsClientForTest(stubClient("Here are some places: ..."));
    await expect(searchPlaces({ query: "cafe" })).resolves.toEqual({ places: [], raw: "Here are some places: ..." });
  });
});

describe("computeRoute", () => {
  it("maps free-text points to address and 'lat,lng' strings to lat_lng", async () => {
    const client = stubClient({ routes: [] });
    setMapsClientForTest(client);

    await computeRoute({ origin: "King's Cross, London", destination: "51.5194, -0.1270", mode: "walk" });

    expect(client.callTool).toHaveBeenCalledWith("compute_routes", {
      origin: { address: "King's Cross, London" },
      destination: { lat_lng: { latitude: 51.5194, longitude: -0.127 } },
      travel_mode: "WALK",
    });
  });

  it("maps a ChIJ-style id to place_id and drive to DRIVE", async () => {
    const client = stubClient({ routes: [] });
    setMapsClientForTest(client);

    await computeRoute({ origin: "ChIJdd4hrwug2EcRmSrV3Vo6llI", destination: "Heathrow Airport", mode: "drive" });

    expect(client.callTool.mock.calls[0][1]).toMatchObject({
      origin: { place_id: "ChIJdd4hrwug2EcRmSrV3Vo6llI" },
      travel_mode: "DRIVE",
    });
  });

  it("returns distance, duration in seconds and attribution from the first route", async () => {
    setMapsClientForTest(
      stubClient({ routes: [{ distanceMeters: 1830, duration: "1320s", polyline: { encodedPolyline: "abc" } }], attribution: "Google Maps" })
    );

    await expect(computeRoute({ origin: "a", destination: "b", mode: "walk" })).resolves.toEqual({
      mode: "walk",
      distanceMeters: 1830,
      durationSeconds: 1320,
      attribution: "Google Maps",
    });
  });

  it("falls back to raw when there is no recognisable route", async () => {
    setMapsClientForTest(stubClient({ something: "else" }));
    const result = await computeRoute({ origin: "a", destination: "b", mode: "drive" });
    expect(result.mode).toBe("drive");
    expect(result.raw).toContain("something");
  });
});

describe("startup tool check", () => {
  it("warns once when an expected upstream tool is missing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = stubClient({ places: [] }, ["search_places"]);
    setMapsClientForTest(client);

    await searchPlaces({ query: "a" });
    await searchPlaces({ query: "b" });
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));

    expect(warn.mock.calls[0].join(" ")).toContain("compute_routes");
    expect(client.listToolNames).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
