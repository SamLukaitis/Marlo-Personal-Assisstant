import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { shortLinkRoutes } from "./shortLinkRoutes.js";
import { shortenUrl, shortenResultLinks, SHORT_LINK_TTL_MS } from "../services/shortLinks.js";
import { findOrCreateUserByEmail } from "../db/store.js";

const app = express();
app.use(shortLinkRoutes);

const LONG_FLIGHTS_URL =
  "https://www.google.com/travel/flights?hl=en&gl=uk&curr=GBP&tfs=CBwQAhoeEgoyMDI2LTExLTEyagcIARIDTEhScgcIARIDQkNOQAFIAXABggELCP___________wGYAQI";

let n = 0;
function newUser() {
  return findOrCreateUserByEmail(`short-links-${Date.now()}-${++n}@example.com`);
}

function codeOf(shortUrl: string): string {
  return shortUrl.split("/go/")[1];
}

describe("shortenUrl", () => {
  it("swaps a long URL for a /go/ link", () => {
    const short = shortenUrl(newUser().id, LONG_FLIGHTS_URL);
    expect(short).toMatch(/\/go\/[A-Za-z0-9_-]{8}$/);
    expect(short.length).toBeLessThan(LONG_FLIGHTS_URL.length);
  });

  it("leaves short URLs and non-web URLs alone", () => {
    const owner = newUser().id;
    expect(shortenUrl(owner, "https://hotelbelem.pt")).toBe("https://hotelbelem.pt");
    const shortcut = `shortcuts://run-shortcut?name=Marlowe&input=text&text=${"x".repeat(80)}`;
    expect(shortenUrl(owner, shortcut)).toBe(shortcut);
  });
});

describe("shortenResultLinks", () => {
  it("shortens the booking and search links in a result, and nothing else", () => {
    const owner = newUser().id;
    const result = {
      currency: "GBP",
      googleFlightsUrl: LONG_FLIGHTS_URL,
      flights: [{ airlines: ["Vueling"], bookingUrl: `${LONG_FLIGHTS_URL}&kiwi=1`, notes: [LONG_FLIGHTS_URL] }],
    };
    const out = shortenResultLinks(owner, result);
    expect(out.googleFlightsUrl).toMatch(/\/go\//);
    expect(out.flights[0].bookingUrl).toMatch(/\/go\//);
    expect(out.flights[0].airlines).toEqual(["Vueling"]);
    expect(out.flights[0].notes).toEqual([LONG_FLIGHTS_URL]);
    expect(result.googleFlightsUrl).toBe(LONG_FLIGHTS_URL);
  });
});

describe("GET /go/:code", () => {
  it("redirects to the stored URL, with no session", async () => {
    const res = await request(app).get(`/go/${codeOf(shortenUrl(newUser().id, LONG_FLIGHTS_URL))}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(LONG_FLIGHTS_URL);
    expect(res.headers["cache-control"]).toContain("no-store");
  });

  it("says the link has expired once it's past its lifetime", async () => {
    const created = Date.now() - SHORT_LINK_TTL_MS - 1000;
    const res = await request(app).get(`/go/${codeOf(shortenUrl(newUser().id, LONG_FLIGHTS_URL, created))}`);
    expect(res.status).toBe(404);
    expect(res.text).toContain("This link has expired");
  });

  it("says the link has expired for an unknown code", async () => {
    const res = await request(app).get("/go/nope1234");
    expect(res.status).toBe(404);
    expect(res.headers.location).toBeUndefined();
  });
});
