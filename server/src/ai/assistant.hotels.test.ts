import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  const MockAnthropic = vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  });
  return { __esModule: true, default: MockAnthropic };
});

const mockSearchHotels = vi.fn();
vi.mock("../providers/hotels.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../providers/hotels.js")>()),
  isHotelsConfigured: () => Boolean(process.env.SERPAPI_API_KEY?.trim()),
  searchHotels: (...args: unknown[]) => mockSearchHotels(...args),
}));

const mockSearchLastminute = vi.fn();
vi.mock("../providers/lastminuteHotels.js", () => ({
  isLastminuteHotelsEnabled: () => process.env.LASTMINUTE_HOTELS?.trim().toLowerCase() !== "off",
  searchLastminuteHotels: (...args: unknown[]) => mockSearchLastminute(...args),
}));

import { runAssistantChat, runTool, buildToolsForOwner, buildSystemPrompt } from "./assistant.js";
import { findOrCreateUserByEmail } from "../db/store.js";

const originalEnv = { ...process.env };
let counter = 0;
function newUser(prefix: string) {
  counter += 1;
  return findOrCreateUserByEmail(`${prefix}-${Date.now()}-${counter}@example.com`);
}

const RESULT = { location: "Lisbon", checkIn: "2026-11-12", checkOut: "2026-11-15", nights: 3, adults: 2, currency: "GBP", priceIs: "x", hotels: [] };
const LASTMINUTE_RESULT = { ...RESULT, source: "lastminute.com (backup)" };
const QUERY = { location: "Lisbon", check_in: "2026-11-12", check_out: "2026-11-15" };

beforeEach(() => {
  mockCreate.mockReset();
  mockSearchHotels.mockReset().mockResolvedValue(RESULT);
  mockSearchLastminute.mockReset().mockResolvedValue(LASTMINUTE_RESULT);
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.SERPAPI_API_KEY = "serp-key";
});

afterEach(() => {
  process.env = { ...originalEnv };
});

function toolUse(id: string, name: string, input: Record<string, unknown>) {
  return { type: "tool_use", id, name, input };
}

describe("Hotel tools — availability", () => {
  it("offers search_hotels only when a source is available", () => {
    const user = newUser("hotels-on");
    expect(buildToolsForOwner(user.id).map((t) => t.name)).toContain("search_hotels");
    expect(buildSystemPrompt(user.id)).toContain("Use search_hotels");

    delete process.env.SERPAPI_API_KEY;
    expect(buildToolsForOwner(user.id).map((t) => t.name)).not.toContain("search_hotels");
    expect(buildSystemPrompt(user.id)).not.toContain("search_hotels");
  });

  it("keeps a single cache breakpoint on the last tool", () => {
    const tools = buildToolsForOwner(newUser("hotels-cache").id);
    expect(tools.filter((t) => (t as { cache_control?: unknown }).cache_control)).toHaveLength(1);
    expect((tools[tools.length - 1] as { cache_control?: unknown }).cache_control).toBeDefined();
  });

  it("runTool refuses when no source is configured", async () => {
    delete process.env.SERPAPI_API_KEY;
    const result = await runTool(newUser("hotels-off").id, "search_hotels", QUERY);
    expect(result).toEqual({ error: "Hotel search isn't set up on this server." });
    expect(mockSearchHotels).not.toHaveBeenCalled();
  });
});

describe("runTool — search_hotels", () => {
  it("maps every input through", async () => {
    const result = await runTool(newUser("hotels-all").id, "search_hotels", {
      ...QUERY,
      adults: 1,
      sort: "lowest_price",
      max_price_per_night: 150,
      min_stars: 4,
      free_cancellation: true,
      currency: "EUR",
    });
    expect(mockSearchHotels).toHaveBeenCalledWith({
      location: "Lisbon",
      checkIn: "2026-11-12",
      checkOut: "2026-11-15",
      adults: 1,
      sort: "lowest_price",
      maxPricePerNight: 150,
      minStars: 4,
      freeCancellation: true,
      currency: "EUR",
    });
    expect(result).toEqual(RESULT);
  });

  it("drops blank or invalid optional inputs", async () => {
    await runTool(newUser("hotels-min").id, "search_hotels", {
      ...QUERY,
      sort: "cheapest",
      max_price_per_night: -1,
      min_stars: 1,
      free_cancellation: "yes",
      currency: " ",
    });
    expect(mockSearchHotels).toHaveBeenCalledWith({ location: "Lisbon", checkIn: "2026-11-12", checkOut: "2026-11-15" });
  });

  it("checks the location and dates before searching", async () => {
    const user = newUser("hotels-bad");
    expect(await runTool(user.id, "search_hotels", { ...QUERY, location: " " })).toEqual({ error: "Give a city or area to search." });
    expect(await runTool(user.id, "search_hotels", { ...QUERY, check_in: "12/11/2026" })).toEqual({
      error: "check_in and check_out must be dates as YYYY-MM-DD.",
    });
    expect(await runTool(user.id, "search_hotels", { ...QUERY, check_out: "2026-11-12" })).toEqual({ error: "check_out must be after check_in." });
    expect(await runTool(user.id, "search_hotels", { ...QUERY, check_out: "2027-01-12" })).toEqual({
      error: "Hotel search covers stays of up to 30 nights.",
    });
    expect(mockSearchHotels).not.toHaveBeenCalled();
  });

  it("returns a short error instead of throwing", async () => {
    mockSearchHotels.mockRejectedValueOnce(new Error("Invalid API key"));
    const result = await runTool(newUser("hotels-fail").id, "search_hotels", QUERY);
    expect(result).toEqual({ error: "Couldn't reach Google Hotels: Invalid API key" });
  });
});

describe("runTool — search_hotels lastminute.com backup", () => {
  beforeEach(() => {
    process.env.LASTMINUTE_HOTELS = "on";
  });

  it("is offered with no SerpApi key, and goes straight to lastminute.com", async () => {
    delete process.env.SERPAPI_API_KEY;
    const user = newUser("lastminute-only");
    expect(buildToolsForOwner(user.id).map((t) => t.name)).toContain("search_hotels");

    const result = await runTool(user.id, "search_hotels", QUERY);
    expect(mockSearchHotels).not.toHaveBeenCalled();
    expect(mockSearchLastminute).toHaveBeenCalledWith({ location: "Lisbon", checkIn: "2026-11-12", checkOut: "2026-11-15" });
    expect(result).toEqual(LASTMINUTE_RESULT);
  });

  it("uses Google Hotels first when it works", async () => {
    expect(await runTool(newUser("lastminute-unused").id, "search_hotels", QUERY)).toEqual(RESULT);
    expect(mockSearchLastminute).not.toHaveBeenCalled();
  });

  it("falls back to lastminute.com when a SerpApi search fails", async () => {
    mockSearchHotels.mockRejectedValueOnce(new Error("Your account has run out of searches."));
    const result = await runTool(newUser("lastminute-fallback").id, "search_hotels", QUERY);
    expect(mockSearchLastminute).toHaveBeenCalledTimes(1);
    expect(result).toEqual(LASTMINUTE_RESULT);
  });

  it("returns a short error when both fail", async () => {
    mockSearchHotels.mockRejectedValueOnce(new Error("Invalid API key"));
    mockSearchLastminute.mockRejectedValueOnce(new Error("fetch failed"));
    const result = await runTool(newUser("lastminute-both-fail").id, "search_hotels", QUERY);
    expect(result).toEqual({ error: "Couldn't reach a hotel search: fetch failed" });
  });
});

describe("runAssistantChat — hotel search cap", () => {
  it("caps hotel searches at 2 per message, counting parallel calls", async () => {
    const three = ["Lisbon", "Porto", "Faro"].map((city, i) => toolUse(`h${i}`, "search_hotels", { ...QUERY, location: city }));
    mockCreate.mockResolvedValueOnce({ content: three }).mockResolvedValueOnce({ content: [{ type: "text", text: "Porto is cheapest." }] });

    const reply = await runAssistantChat(newUser("hotels-cap").id, [{ role: "user", content: "compare cities" }], "447000000002");

    expect(reply.text).toBe("Porto is cheapest.");
    expect(mockSearchHotels).toHaveBeenCalledTimes(2);
    type Block = { type: string; is_error?: boolean; content?: string };
    const history = mockCreate.mock.calls[1][0].messages as Array<{ content: unknown }>;
    const results = history.find(
      (m) => Array.isArray(m.content) && (m.content as Block[]).filter((b) => b.type === "tool_result").length === 3
    )!.content as Block[];
    const errors = results.filter((r) => r.is_error);
    expect(errors).toHaveLength(1);
    expect(errors[0].content).toContain("hotel search limit");
  });
});
