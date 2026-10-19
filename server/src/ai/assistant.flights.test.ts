import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  const MockAnthropic = vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  });
  return { __esModule: true, default: MockAnthropic };
});

const mockSearchFlights = vi.fn();
vi.mock("../providers/flights.js", () => ({
  isFlightsConfigured: () => Boolean(process.env.SERPAPI_API_KEY?.trim()),
  searchFlights: (...args: unknown[]) => mockSearchFlights(...args),
}));

const mockSearchKiwi = vi.fn();
vi.mock("../providers/kiwiFlights.js", () => ({
  isKiwiFlightsEnabled: () => process.env.KIWI_FLIGHTS?.trim().toLowerCase() !== "off",
  searchKiwiFlights: (...args: unknown[]) => mockSearchKiwi(...args),
}));

import { runAssistantChat, runTool, buildToolsForOwner, buildSystemPrompt } from "./assistant.js";
import { findOrCreateUserByEmail } from "../db/store.js";

const originalEnv = { ...process.env };
let counter = 0;
function newUser(prefix: string) {
  counter += 1;
  return findOrCreateUserByEmail(`${prefix}-${Date.now()}-${counter}@example.com`);
}

const RESULT = { roundTrip: false, currency: "GBP", priceIs: "one-way for 1 adult(s), GBP", flights: [] };
const KIWI_RESULT = { ...RESULT, source: "Kiwi.com (backup)" };

beforeEach(() => {
  mockCreate.mockReset();
  mockSearchFlights.mockReset().mockResolvedValue(RESULT);
  mockSearchKiwi.mockReset().mockResolvedValue(KIWI_RESULT);
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.SERPAPI_API_KEY = "serp-key";
});

afterEach(() => {
  process.env = { ...originalEnv };
});

function toolUse(id: string, name: string, input: Record<string, unknown>) {
  return { type: "tool_use", id, name, input };
}

describe("Flight tools — availability", () => {
  it("offers search_flights only when a SerpApi key is set", () => {
    const user = newUser("flights-on");
    expect(buildToolsForOwner(user.id).map((t) => t.name)).toContain("search_flights");

    delete process.env.SERPAPI_API_KEY;
    expect(buildToolsForOwner(user.id).map((t) => t.name)).not.toContain("search_flights");
  });

  it("keeps a single cache breakpoint on the last tool", () => {
    const tools = buildToolsForOwner(newUser("flights-cache").id);
    expect((tools[tools.length - 1] as { cache_control?: unknown }).cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(tools.filter((t) => (t as { cache_control?: unknown }).cache_control)).toHaveLength(1);
  });

  it("runTool refuses when no key is configured", async () => {
    delete process.env.SERPAPI_API_KEY;
    const result = await runTool(newUser("flights-off").id, "search_flights", { from: "LHR", to: "BCN", depart_date: "2026-11-20" });
    expect(result).toEqual({ error: "Flight search isn't set up on this server." });
    expect(mockSearchFlights).not.toHaveBeenCalled();
  });
});

describe("runTool — search_flights", () => {
  it("maps every input through", async () => {
    const result = await runTool(newUser("flights-all").id, "search_flights", {
      from: "LHR,LGW",
      to: "BCN",
      depart_date: "2026-11-20",
      return_date: "2026-11-23",
      adults: 2,
      cabin: "business",
      max_stops: 0,
      currency: "EUR",
      return_for: "tok",
    });
    expect(mockSearchFlights).toHaveBeenCalledWith({
      from: "LHR,LGW",
      to: "BCN",
      departDate: "2026-11-20",
      returnDate: "2026-11-23",
      adults: 2,
      cabin: "business",
      maxStops: 0,
      currency: "EUR",
      returnFor: "tok",
    });
    expect(result).toEqual(RESULT);
  });

  it("drops blank or invalid optional inputs", async () => {
    await runTool(newUser("flights-min").id, "search_flights", {
      from: "LHR",
      to: "BCN",
      depart_date: "2026-11-20",
      return_date: " ",
      cabin: "luxury",
      max_stops: 5,
    });
    expect(mockSearchFlights).toHaveBeenCalledWith({ from: "LHR", to: "BCN", departDate: "2026-11-20" });
  });

  it("returns a short error instead of throwing", async () => {
    mockSearchFlights.mockRejectedValueOnce(new Error("Invalid API key"));
    const result = await runTool(newUser("flights-fail").id, "search_flights", { from: "LHR", to: "BCN", depart_date: "2026-11-20" });
    expect(result).toEqual({ error: "Couldn't reach Google Flights: Invalid API key" });
  });
});

describe("runTool — search_flights Kiwi.com backup", () => {
  const query = { from: "LHR", to: "BCN", depart_date: "2026-11-20" };

  beforeEach(() => {
    process.env.KIWI_FLIGHTS = "on";
  });

  it("is offered with no SerpApi key, and goes straight to Kiwi", async () => {
    delete process.env.SERPAPI_API_KEY;
    const user = newUser("kiwi-only");
    expect(buildToolsForOwner(user.id).map((t) => t.name)).toContain("search_flights");
    expect(buildSystemPrompt(user.id)).toContain("Use search_flights");

    const result = await runTool(user.id, "search_flights", query);
    expect(mockSearchFlights).not.toHaveBeenCalled();
    expect(mockSearchKiwi).toHaveBeenCalledWith({ from: "LHR", to: "BCN", departDate: "2026-11-20" });
    expect(result).toEqual(KIWI_RESULT);
  });

  it("uses Google Flights first when it works", async () => {
    const result = await runTool(newUser("kiwi-unused").id, "search_flights", query);
    expect(result).toEqual(RESULT);
    expect(mockSearchKiwi).not.toHaveBeenCalled();
  });

  it("falls back to Kiwi when a SerpApi search fails", async () => {
    mockSearchFlights.mockRejectedValueOnce(new Error("Your account has run out of searches."));
    const result = await runTool(newUser("kiwi-fallback").id, "search_flights", query);
    expect(mockSearchKiwi).toHaveBeenCalledTimes(1);
    expect(result).toEqual(KIWI_RESULT);
  });

  it("returns a short error when both fail", async () => {
    mockSearchFlights.mockRejectedValueOnce(new Error("Invalid API key"));
    mockSearchKiwi.mockRejectedValueOnce(new Error("fetch failed"));
    const result = await runTool(newUser("kiwi-both-fail").id, "search_flights", query);
    expect(result).toEqual({ error: "Couldn't reach a flight search: fetch failed" });
  });
});

describe("runAssistantChat — flight search cap", () => {
  it("caps flight searches at 4 per message, counting parallel calls", async () => {
    const five = Array.from({ length: 5 }, (_, i) =>
      toolUse(`t${i}`, "search_flights", { from: "LHR", to: "BCN", depart_date: `2026-11-2${i}` })
    );
    mockCreate.mockResolvedValueOnce({ content: five }).mockResolvedValueOnce({ content: [{ type: "text", text: "Cheapest is the 21st." }] });

    const reply = await runAssistantChat(newUser("flights-cap").id, [{ role: "user", content: "compare dates" }], "447000000001");

    expect(reply.text).toBe("Cheapest is the 21st.");
    expect(mockSearchFlights).toHaveBeenCalledTimes(4);
    type Block = { type: string; is_error?: boolean; content?: string };
    const history = mockCreate.mock.calls[1][0].messages as Array<{ content: unknown }>;
    const results = history.find(
      (m) => Array.isArray(m.content) && (m.content as Block[]).filter((b) => b.type === "tool_result").length === 5
    )!.content as Block[];
    const errors = results.filter((r) => r.is_error);
    expect(errors).toHaveLength(1);
    expect(errors[0].content).toContain("flight search limit");
  });
});

describe("system prompt — flights rule", () => {
  it("is present only when flight search is configured", () => {
    expect(buildSystemPrompt(newUser("flights-rule-on").id)).toContain("Use search_flights");
    delete process.env.SERPAPI_API_KEY;
    expect(buildSystemPrompt(newUser("flights-rule-off").id)).not.toContain("search_flights");
  });
});
