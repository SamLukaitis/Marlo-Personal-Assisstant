import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  // Arrow functions can never be used as constructors — `new Anthropic()` in assistant.ts
  // requires a real function here, not `() => ({...})`.
  const MockAnthropic = vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  });
  return { __esModule: true, default: MockAnthropic };
});

const mockSearchPlaces = vi.fn();
const mockComputeRoute = vi.fn();
vi.mock("../providers/maps.js", () => ({
  isMapsConfigured: () => Boolean(process.env.GOOGLE_MAPS_API_KEY?.trim()),
  searchPlaces: (...args: unknown[]) => mockSearchPlaces(...args),
  computeRoute: (...args: unknown[]) => mockComputeRoute(...args),
}));

import { runAssistantChat, runTool, buildToolsForOwner, buildSystemPrompt } from "./assistant.js";
import { findOrCreateUserByEmail } from "../db/store.js";

const originalEnv = { ...process.env };
let counter = 0;
function newUser(prefix: string) {
  counter += 1;
  return findOrCreateUserByEmail(`${prefix}-${Date.now()}-${counter}@example.com`);
}

beforeEach(() => {
  mockCreate.mockReset();
  mockSearchPlaces.mockReset().mockResolvedValue({ places: [{ name: "Boots", mapsUrl: "https://maps.google.com/?cid=1" }] });
  mockComputeRoute.mockReset().mockResolvedValue({ mode: "walk", distanceMeters: 1800, durationSeconds: 1300 });
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.GOOGLE_MAPS_API_KEY = "maps-key";
});

afterEach(() => {
  process.env = { ...originalEnv };
});

function toolUse(id: string, name: string, input: Record<string, unknown>) {
  return { type: "tool_use", id, name, input };
}

describe("Maps tools — availability", () => {
  it("offers find_places, get_route and request_location only when a Maps key is set", () => {
    const user = newUser("maps-tools-on");
    const on = buildToolsForOwner(user.id).map((t) => t.name);
    expect(on).toEqual(expect.arrayContaining(["find_places", "get_route", "request_location"]));

    delete process.env.GOOGLE_MAPS_API_KEY;
    const off = buildToolsForOwner(user.id).map((t) => t.name);
    expect(off).not.toContain("find_places");
    expect(off).not.toContain("get_route");
    expect(off).not.toContain("request_location");
  });

  it("keeps the cache breakpoint on the last tool when Maps tools are appended", () => {
    const tools = buildToolsForOwner(newUser("maps-cache").id);
    const last = tools[tools.length - 1] as { cache_control?: unknown };
    expect(last.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(tools.filter((t) => (t as { cache_control?: unknown }).cache_control)).toHaveLength(1);
  });

  it("runTool refuses Maps tools when no key is configured", async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;
    const result = await runTool(newUser("maps-off-run").id, "find_places", { query: "cafe" });
    expect(result).toEqual({ error: "Maps lookups aren't set up on this server." });
    expect(mockSearchPlaces).not.toHaveBeenCalled();
  });
});

describe("runTool — Maps", () => {
  it("find_places passes query, pin and radius through to searchPlaces", async () => {
    const result = await runTool(newUser("find-places").id, "find_places", {
      query: "pharmacy open now",
      latitude: 51.53,
      longitude: -0.12,
      radius_meters: 1000,
    });

    expect(mockSearchPlaces).toHaveBeenCalledWith({
      query: "pharmacy open now",
      near: { latitude: 51.53, longitude: -0.12 },
      radiusMeters: 1000,
    });
    expect(result).toEqual({ places: [{ name: "Boots", mapsUrl: "https://maps.google.com/?cid=1" }] });
  });

  it("find_places ignores a half-specified pin", async () => {
    await runTool(newUser("find-places-half").id, "find_places", { query: "cafe", latitude: 51.5 });
    expect(mockSearchPlaces).toHaveBeenCalledWith({ query: "cafe" });
  });

  it("get_route defaults to drive and passes walk through", async () => {
    const ownerId = newUser("get-route").id;
    await runTool(ownerId, "get_route", { origin: "A", destination: "B" });
    await runTool(ownerId, "get_route", { origin: "A", destination: "B", mode: "walk" });

    expect(mockComputeRoute).toHaveBeenNthCalledWith(1, { origin: "A", destination: "B", mode: "drive" });
    expect(mockComputeRoute).toHaveBeenNthCalledWith(2, { origin: "A", destination: "B", mode: "walk" });
  });

  it("returns a short error instead of throwing when Maps fails", async () => {
    mockSearchPlaces.mockRejectedValueOnce(new Error("fetch failed"));
    const result = await runTool(newUser("maps-fail").id, "find_places", { query: "cafe" });
    expect(result).toEqual({ error: "Couldn't reach Google Maps: fetch failed" });
  });
});

describe("runAssistantChat — request_location", () => {
  it("on WhatsApp, ends the turn with a location request and makes no second API call", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [toolUse("t1", "request_location", { message: "Tap below to share where you are and I'll find the nearest pharmacy." })],
    });

    const reply = await runAssistantChat(newUser("req-loc-wa").id, [{ role: "user", content: "pharmacy near me?" }], "447000000001");

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(reply).toEqual({
      text: "Tap below to share where you are and I'll find the nearest pharmacy.",
      locationRequest: true,
    });
  });

  it("request_location wins over other tool calls in the same turn", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        { type: "text", text: "Let me check." },
        toolUse("t1", "find_places", { query: "pharmacy" }),
        toolUse("t2", "request_location", { message: "Share your location?" }),
      ],
    });

    const reply = await runAssistantChat(newUser("req-loc-mixed").id, [{ role: "user", content: "pharmacy near me" }], "447000000001");

    expect(reply).toEqual({ text: "Share your location?", locationRequest: true });
    expect(mockSearchPlaces).not.toHaveBeenCalled();
  });

  it("falls back to a default prompt when the message is empty", async () => {
    mockCreate.mockResolvedValueOnce({ content: [toolUse("t1", "request_location", { message: "  " })] });
    const reply = await runAssistantChat(newUser("req-loc-empty").id, [{ role: "user", content: "near me" }], "447000000001");
    expect(reply).toEqual({ text: "Tap below to share your location and I'll look it up.", locationRequest: true });
  });

  it("on the web, request_location asks the user to type their location", async () => {
    mockCreate.mockResolvedValueOnce({ content: [toolUse("t1", "request_location", { message: "Tap below to share where you are." })] });

    const reply = await runAssistantChat(newUser("req-loc-web").id, [{ role: "user", content: "pharmacy near me?" }]);

    expect(reply.locationRequest).toBeUndefined();
    expect(reply.text).toBe("Where are you? Tell me the area or an address and I'll look it up.");
  });
});

describe("runAssistantChat — Maps call cap", () => {
  it("caps Maps calls at 5 per message, counting parallel calls", async () => {
    const six = Array.from({ length: 6 }, (_, i) => toolUse(`t${i}`, "find_places", { query: `q${i}` }));
    mockCreate
      .mockResolvedValueOnce({ content: six })
      .mockResolvedValueOnce({ content: [toolUse("t9", "get_route", { origin: "A", destination: "B" })] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Here you go." }] });

    const reply = await runAssistantChat(newUser("maps-cap").id, [{ role: "user", content: "find lots" }], "447000000001");

    expect(reply.text).toBe("Here you go.");
    expect(mockSearchPlaces).toHaveBeenCalledTimes(5);
    expect(mockComputeRoute).not.toHaveBeenCalled();

    // The loop keeps appending to the same messages array, so read the tool results from the
    // final call's history rather than trusting .at(-1) of an earlier call.
    type Block = { type: string; is_error?: boolean; content?: string };
    const history = mockCreate.mock.calls[2][0].messages as Array<{ content: unknown }>;
    const firstResults = history.find(
      (m) => Array.isArray(m.content) && (m.content as Block[]).filter((b) => b.type === "tool_result").length === 6
    )!.content as Block[];
    const errors = firstResults.filter((r) => r.is_error);
    expect(errors).toHaveLength(1);
    expect(errors[0].content).toContain("Maps lookup limit");
  });

  it("does not carry the count over to the next message", async () => {
    const ownerId = newUser("maps-cap-reset").id;
    for (let i = 0; i < 2; i++) {
      mockCreate
        .mockResolvedValueOnce({ content: Array.from({ length: 5 }, (_, j) => toolUse(`t${j}`, "find_places", { query: `q${j}` })) })
        .mockResolvedValueOnce({ content: [{ type: "text", text: "ok" }] });
      await runAssistantChat(ownerId, [{ role: "user", content: `find ${i}` }], "447000000001");
    }
    expect(mockSearchPlaces).toHaveBeenCalledTimes(10);
  });
});

describe("system prompt — Maps rules", () => {
  it("with Maps configured, steers places to find_places and requires Maps sources", () => {
    const prompt = buildSystemPrompt(newUser("rules-on").id);
    expect(prompt).toContain("find_places");
    expect(prompt).toContain("Source: Google Maps");
    // Each place's link goes under that place, not in an unlabelled block at the end.
    expect(prompt).toContain("directly under that place");
    expect(prompt).not.toContain("https://www.google.com/maps/search/?api=1&query=");
  });

  it("without Maps, keeps the web_search hand-built Maps link rule", () => {
    delete process.env.GOOGLE_MAPS_API_KEY;
    const prompt = buildSystemPrompt(newUser("rules-off").id);
    expect(prompt).not.toContain("find_places");
    expect(prompt).toContain("https://www.google.com/maps/search/?api=1&query=");
  });
});
