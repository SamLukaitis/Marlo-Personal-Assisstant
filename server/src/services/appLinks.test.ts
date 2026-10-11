import { describe, it, expect } from "vitest";
import { makeAppLink } from "./appLinks.js";

const ctx = { today: "2026-10-12" };

function ok(result: ReturnType<typeof makeAppLink>): { url: string; label: string } {
  if ("error" in result) throw new Error(`expected a link, got error: ${result.error}`);
  return result;
}
function err(result: ReturnType<typeof makeAppLink>): string {
  if (!("error" in result)) throw new Error(`expected an error, got ${result.url}`);
  return result.error;
}

describe("makeAppLink — input", () => {
  it("rejects an unknown app", () => {
    expect(err(makeAppLink({ app: "doordash" }, ctx))).toMatch(/app/i);
  });

  it("rejects a half coordinate pair", () => {
    expect(err(makeAppLink({ app: "uber", destination: { latitude: 51.5 } }, ctx))).toMatch(/latitude and longitude/i);
  });

  it("rejects out-of-range coordinates", () => {
    expect(err(makeAppLink({ app: "uber", destination: { latitude: 200, longitude: 0 } }, ctx))).toMatch(/coordinates/i);
  });

  it("strips control characters and caps text at 200 chars", () => {
    const long = "a".repeat(300);
    const { url } = ok(makeAppLink({ app: "spotify", query: `chill\nvibes\u0000${long}` }, ctx));
    const q = decodeURIComponent(new URL(url).pathname.replace("/search/", ""));
    expect(q).not.toMatch(/[\u0000-\u001f]/);
    expect(q.length).toBe(200);
    expect(q.startsWith("chill vibes")).toBe(true);
  });

  it("refuses dot-only text that the URL parser would resolve out of the path", () => {
    expect(err(makeAppLink({ app: "spotify", query: ".." }, ctx))).toMatch(/query/);
  });
});

describe("makeAppLink — uber", () => {
  it("defaults pickup to current location and uses a text-only drop-off", () => {
    const { url, label } = ok(makeAppLink({ app: "uber", destination: { name: "Dishoom Shoreditch" } }, ctx));
    expect(label).toBe("Open in Uber");
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://m.uber.com/ul/");
    expect(u.searchParams.get("action")).toBe("setPickup");
    expect(u.searchParams.get("pickup")).toBe("my_location");
    expect(u.searchParams.get("dropoff[nickname]")).toBe("Dishoom Shoreditch");
    expect(u.searchParams.get("dropoff[formatted_address]")).toBe("Dishoom Shoreditch");
  });

  it("uses coordinates and address when given", () => {
    const { url } = ok(
      makeAppLink(
        {
          app: "uber",
          origin: { latitude: 51.52, longitude: -0.08 },
          destination: { name: "Heathrow T5", address: "Wallis Rd, Hounslow TW6 2GA", latitude: 51.47, longitude: -0.49 },
        },
        ctx
      )
    );
    const u = new URL(url);
    expect(u.searchParams.get("pickup[latitude]")).toBe("51.52");
    expect(u.searchParams.get("pickup[longitude]")).toBe("-0.08");
    expect(u.searchParams.get("pickup")).toBeNull();
    expect(u.searchParams.get("dropoff[latitude]")).toBe("51.47");
    expect(u.searchParams.get("dropoff[formatted_address]")).toBe("Wallis Rd, Hounslow TW6 2GA");
    expect(u.searchParams.get("dropoff[nickname]")).toBe("Heathrow T5");
  });

  it("requires a destination", () => {
    expect(err(makeAppLink({ app: "uber" }, ctx))).toMatch(/destination/i);
  });

  it("keeps the host fixed and the hostile text inside one encoded value", () => {
    const evil = "x&action=evil#frag javascript:alert(1)";
    const { url } = ok(makeAppLink({ app: "uber", destination: { name: evil } }, ctx));
    const u = new URL(url);
    expect(u.host).toBe("m.uber.com");
    expect(u.hash).toBe("");
    expect(u.searchParams.getAll("action")).toEqual(["setPickup"]);
    expect(u.searchParams.get("dropoff[nickname]")).toBe(evil);
  });
});

describe("makeAppLink — lyft", () => {
  it("builds a link from coordinates", () => {
    const { url, label } = ok(
      makeAppLink({ app: "lyft", origin: { latitude: 40.74, longitude: -73.99 }, destination: { latitude: 40.64, longitude: -73.78 } }, ctx)
    );
    expect(label).toBe("Open in Lyft");
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://lyft.com/ride");
    expect(u.searchParams.get("id")).toBe("lyft");
    expect(u.searchParams.get("pickup[latitude]")).toBe("40.74");
    expect(u.searchParams.get("destination[longitude]")).toBe("-73.78");
  });

  it("omits pickup (current location) when no origin", () => {
    const { url } = ok(makeAppLink({ app: "lyft", destination: { latitude: 40.64, longitude: -73.78 } }, ctx));
    expect(new URL(url).searchParams.get("pickup[latitude]")).toBeNull();
  });

  it("refuses a text-only destination and points to Uber or Maps", () => {
    expect(err(makeAppLink({ app: "lyft", destination: { name: "JFK" } }, ctx))).toMatch(/coordinates.*uber|google_maps/i);
  });
});

describe("makeAppLink — google_maps", () => {
  it("builds directions from current location by default", () => {
    const { url, label } = ok(makeAppLink({ app: "google_maps", destination: { name: "Borough Market" } }, ctx));
    expect(label).toBe("Open in Google Maps");
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://www.google.com/maps/dir/");
    expect(u.searchParams.get("api")).toBe("1");
    expect(u.searchParams.get("destination")).toBe("Borough Market");
    expect(u.searchParams.get("origin")).toBeNull();
  });

  it("prefers coordinates, and maps travel_mode", () => {
    const { url } = ok(
      makeAppLink(
        { app: "google_maps", origin: { name: "Home", latitude: 51.5, longitude: -0.1 }, destination: { address: "1 Main St" }, travel_mode: "transit" },
        ctx
      )
    );
    const u = new URL(url);
    expect(u.searchParams.get("origin")).toBe("51.5,-0.1");
    expect(u.searchParams.get("travelmode")).toBe("transit");
  });

  it("rejects an unknown travel_mode, including Object.prototype keys", () => {
    expect(err(makeAppLink({ app: "google_maps", destination: { name: "X" }, travel_mode: "teleport" }, ctx))).toMatch(/travel_mode/);
    expect(err(makeAppLink({ app: "google_maps", destination: { name: "X" }, travel_mode: "constructor" }, ctx))).toMatch(/travel_mode/);
  });
});
describe("makeAppLink — opentable", () => {
  it("builds a search with covers and date-time", () => {
    const { url, label } = ok(
      makeAppLink({ app: "opentable", query: "Dishoom Shoreditch", party_size: 4, date: "2026-10-16", time: "20:00" }, ctx)
    );
    expect(label).toBe("Open in OpenTable");
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://www.opentable.com/s");
    expect(u.searchParams.get("term")).toBe("Dishoom Shoreditch");
    expect(u.searchParams.get("covers")).toBe("4");
    expect(u.searchParams.get("dateTime")).toBe("2026-10-16T20:00");
  });

  it("accepts today (the user's local date) and a whole number sent as a string", () => {
    const { url } = ok(makeAppLink({ app: "opentable", query: "X", party_size: "2", date: "2026-10-12", time: "19:30" }, ctx));
    expect(new URL(url).searchParams.get("covers")).toBe("2");
  });

  it("rejects a past date, a bad time, and out-of-range or non-integer party sizes", () => {
    expect(err(makeAppLink({ app: "opentable", query: "X", date: "2026-10-11" }, ctx))).toMatch(/past/i);
    expect(err(makeAppLink({ app: "opentable", query: "X", date: "2026-10-16", time: "8pm" }, ctx))).toMatch(/time/i);
    expect(err(makeAppLink({ app: "opentable", query: "X", party_size: 0 }, ctx))).toMatch(/party_size/);
    expect(err(makeAppLink({ app: "opentable", query: "X", party_size: 21 }, ctx))).toMatch(/party_size/);
    expect(err(makeAppLink({ app: "opentable", query: "X", party_size: 4.5 }, ctx))).toMatch(/party_size/);
    expect(err(makeAppLink({ app: "opentable", query: "X", party_size: "four" }, ctx))).toMatch(/party_size/);
  });

  it("rejects a time without a date", () => {
    expect(err(makeAppLink({ app: "opentable", query: "X", time: "20:00" }, ctx))).toMatch(/date/i);
  });

  it("requires a query", () => {
    expect(err(makeAppLink({ app: "opentable" }, ctx))).toMatch(/query/);
  });
});

describe("makeAppLink — resy", () => {
  it("slugs the city and sets date, seats and query", () => {
    const { url, label } = ok(makeAppLink({ app: "resy", city: "New York, NY", query: "Carbone", party_size: 2, date: "2026-10-20" }, ctx));
    expect(label).toBe("Open in Resy");
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://resy.com/cities/new-york-ny");
    expect(u.searchParams.get("date")).toBe("2026-10-20");
    expect(u.searchParams.get("seats")).toBe("2");
    expect(u.searchParams.get("query")).toBe("Carbone");
  });

  it("requires a city", () => {
    expect(err(makeAppLink({ app: "resy", query: "Carbone" }, ctx))).toMatch(/city/);
  });

  it("rejects a city that slugs to nothing", () => {
    expect(err(makeAppLink({ app: "resy", city: "!!!" }, ctx))).toMatch(/city/);
  });
});

describe("makeAppLink — airbnb", () => {
  it("builds a homes search with dates and adults", () => {
    const { url, label } = ok(makeAppLink({ app: "airbnb", city: "Lisbon, Portugal", check_in: "2026-11-03", check_out: "2026-11-06", guests: 2 }, ctx));
    expect(label).toBe("Open in Airbnb");
    const u = new URL(url);
    expect(u.host).toBe("www.airbnb.com");
    expect(decodeURIComponent(u.pathname)).toBe("/s/Lisbon, Portugal/homes");
    expect(u.searchParams.get("checkin")).toBe("2026-11-03");
    expect(u.searchParams.get("checkout")).toBe("2026-11-06");
    expect(u.searchParams.get("adults")).toBe("2");
  });

  it("keeps a slash in the location inside one path segment", () => {
    const { url } = ok(makeAppLink({ app: "airbnb", city: "../../evil/path" }, ctx));
    const u = new URL(url);
    expect(u.host).toBe("www.airbnb.com");
    expect(u.pathname.startsWith("/s/")).toBe(true);
    expect(u.pathname.endsWith("/homes")).toBe(true);
    expect(u.pathname.split("/").length).toBe(4); // "", "s", <one encoded segment>, "homes"
  });

  it("rejects check-out on or before check-in", () => {
    expect(err(makeAppLink({ app: "airbnb", city: "Lisbon", check_in: "2026-11-06", check_out: "2026-11-06" }, ctx))).toMatch(/check_out/);
  });

  it("rejects only one of check_in/check_out", () => {
    expect(err(makeAppLink({ app: "airbnb", city: "Lisbon", check_in: "2026-11-06" }, ctx))).toMatch(/check_in and check_out/);
  });
});

describe("makeAppLink — booking_com", () => {
  it("builds a search with dates, adults and one room", () => {
    const { url, label } = ok(makeAppLink({ app: "booking_com", city: "Lisbon", check_in: "2026-11-03", check_out: "2026-11-06", guests: 3 }, ctx));
    expect(label).toBe("Open in Booking.com");
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://www.booking.com/searchresults.html");
    expect(u.searchParams.get("ss")).toBe("Lisbon");
    expect(u.searchParams.get("checkin")).toBe("2026-11-03");
    expect(u.searchParams.get("checkout")).toBe("2026-11-06");
    expect(u.searchParams.get("group_adults")).toBe("3");
    expect(u.searchParams.get("no_rooms")).toBe("1");
  });
});

describe("makeAppLink — review fixes", () => {
  it("treats blank coordinate strings as missing, not 0,0", () => {
    expect(err(makeAppLink({ app: "lyft", destination: { latitude: "", longitude: " " } }, ctx))).toMatch(/destination is required/);
    const { url } = ok(makeAppLink({ app: "uber", destination: { name: "X", latitude: "", longitude: "" } }, ctx));
    expect(new URL(url).searchParams.get("dropoff[latitude]")).toBeNull();
  });

  it("rejects non-decimal coordinate strings like hex or exponents", () => {
    expect(err(makeAppLink({ app: "uber", destination: { latitude: "0x1F", longitude: "1e1" } }, ctx))).toMatch(/coordinates/);
  });

  it("accepts plain decimal coordinate strings", () => {
    const { url } = ok(makeAppLink({ app: "lyft", destination: { latitude: "40.64", longitude: "-73.78" } }, ctx));
    expect(new URL(url).searchParams.get("destination[latitude]")).toBe("40.64");
  });

  it("never splits an emoji when capping at 200 characters", () => {
    const query = "a".repeat(199) + "😀😀";
    const { url } = ok(makeAppLink({ app: "spotify", query }, ctx));
    const q = decodeURIComponent(new URL(url).pathname.replace("/search/", ""));
    expect(Array.from(q).length).toBe(200);
    expect(q.endsWith("a😀")).toBe(true);
  });
});
