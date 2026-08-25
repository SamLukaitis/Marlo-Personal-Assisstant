import { describe, it, expect } from "vitest";
import { buildToolsForOwner, buildSystemPrompt, runTool } from "./assistant.js";
import { findOrCreateUserByEmail, setToolEnabled, getEnabledTools } from "../db/store.js";
import { getBriefingSettings, saveBriefingSettings, type BriefingSettings } from "../services/briefing.js";
import { getXeroForwardingEmail } from "../services/xero.js";

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

describe("buildToolsForOwner", () => {
  it("excludes teams and travel tools when neither is enabled", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("no-tools"));
    const names = buildToolsForOwner(user.id).map((t) => t.name);
    expect(names).not.toContain("list_recent_chats");
    expect(names).not.toContain("search_chats");
    expect(names).not.toContain("list_travel_checkins");
    expect(names).not.toContain("count_travel_days");
  });

  it("includes teams tools when teams is enabled", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("teams-on"));
    setToolEnabled(user.id, "teams", true);
    const names = buildToolsForOwner(user.id).map((t) => t.name);
    expect(names).toContain("list_recent_chats");
    expect(names).toContain("search_chats");
    expect(names).not.toContain("list_travel_checkins");
  });

  it("includes travel tools when travel is enabled", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("travel-on"));
    setToolEnabled(user.id, "travel", true);
    const names = buildToolsForOwner(user.id).map((t) => t.name);
    expect(names).toContain("list_travel_checkins");
    expect(names).toContain("count_travel_days");
  });

  it("puts the cache_control breakpoint on the last tool in the array, whichever one that is", () => {
    const userNoTools = findOrCreateUserByEmail(uniqueEmail("cache-none"));
    const noToolsResult = buildToolsForOwner(userNoTools.id);
    expect(noToolsResult[noToolsResult.length - 1].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });

    const userWithTravel = findOrCreateUserByEmail(uniqueEmail("cache-travel"));
    setToolEnabled(userWithTravel.id, "travel", true);
    const withTravelResult = buildToolsForOwner(userWithTravel.id);
    expect(withTravelResult[withTravelResult.length - 1].name).toBe("count_travel_days");
    expect(withTravelResult[withTravelResult.length - 1].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
  });

  it("includes all 4 conditional tools with no duplicates when both teams and travel are enabled", () => {
    const userNeitherEnabled = findOrCreateUserByEmail(uniqueEmail("both-baseline"));
    const alwaysOnCount = buildToolsForOwner(userNeitherEnabled.id).length;

    const user = findOrCreateUserByEmail(uniqueEmail("both-on"));
    setToolEnabled(user.id, "teams", true);
    setToolEnabled(user.id, "travel", true);
    const result = buildToolsForOwner(user.id);
    const names = result.map((t) => t.name);

    expect(names).toContain("list_recent_chats");
    expect(names).toContain("search_chats");
    expect(names).toContain("list_travel_checkins");
    expect(names).toContain("count_travel_days");

    // No duplicates anywhere in the assembled array.
    expect(new Set(names).size).toBe(names.length);
    // Exactly the always-on tools plus the 4 conditional ones — nothing dropped, nothing doubled.
    expect(result.length).toBe(alwaysOnCount + 4);

    // Cache breakpoint lands on whichever tool is actually last — read it from the array rather
    // than assuming which tool that is.
    expect(result[result.length - 1].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
    // And it must be the ONLY tool carrying cache_control.
    const withCache = result.filter((t) => t.cache_control !== undefined);
    expect(withCache.length).toBe(1);
    expect(withCache[0].name).toBe(result[result.length - 1].name);
  });
});

describe("buildSystemPrompt anti-hallucination rule", () => {
  it("forbids asserting absence of data without a fresh tool call this turn", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("prompt-no-hallucinate"));
    const prompt = buildSystemPrompt(user.id);
    expect(prompt).toContain("does NOT exist");
    expect(prompt).toContain("not verification");
  });
});

describe("buildSystemPrompt", () => {
  it("omits travel-specific rules when travel is disabled", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("prompt-no-travel"));
    const prompt = buildSystemPrompt(user.id);
    expect(prompt).not.toContain("count_travel_days");
  });

  it("includes travel-specific rules when travel is enabled", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("prompt-travel"));
    setToolEnabled(user.id, "travel", true);
    const prompt = buildSystemPrompt(user.id);
    expect(prompt).toContain("count_travel_days");
  });
});

describe("runTool defense-in-depth", () => {
  it("rejects a teams tool call when teams is not enabled for that owner", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("defense-teams"));
    const result = await runTool(user.id, "list_recent_chats", {});
    expect(result).toEqual({ error: "tool not enabled: list_recent_chats" });
  });

  it("rejects a travel tool call when travel is not enabled for that owner", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("defense-travel"));
    const result = await runTool(user.id, "count_travel_days", { area: "schengen" });
    expect(result).toEqual({ error: "tool not enabled: count_travel_days" });
  });

  it("does not block always-on tools regardless of enabled-tools state", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("defense-remember"));
    const result = await runTool(user.id, "remember", { note: "test note" });
    expect(result).toEqual({ ok: true });
  });
});

describe("set_briefing_preferences tool", () => {
  it("merges a patch onto a user's existing briefing settings", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("briefing-merge"));
    const existing: BriefingSettings = {
      enabled: true,
      includeNews: false,
      topics: [],
      includeMarkets: false,
      tickers: [],
      includeWeather: false,
      weatherLocation: "",
      proactive: false,
      sendTime: "07:30",
    };
    saveBriefingSettings(user.id, existing);

    const result = await runTool(user.id, "set_briefing_preferences", {
      include_weather: true,
      weather_location: "Lisbon",
      include_news: true,
      topics: ["technology", "business"],
      send_time: "08:00",
    });

    expect(result).toEqual({ ok: true });
    const saved = getBriefingSettings(user.id);
    expect(saved.includeWeather).toBe(true);
    expect(saved.weatherLocation).toBe("Lisbon");
    expect(saved.includeNews).toBe(true);
    expect(saved.topics).toEqual(["technology", "business"]);
    expect(saved.sendTime).toBe("08:00");
    // Untouched fields keep their prior value — this is a patch, not a replace.
    expect(saved.includeMarkets).toBe(false);
  });

  it("silently drops unrecognized news topics instead of erroring", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("briefing-bad-topic"));
    const result = await runTool(user.id, "set_briefing_preferences", {
      include_news: true,
      topics: ["technology", "not_a_real_topic"],
    });
    expect(result).toEqual({ ok: true });
    expect(getBriefingSettings(user.id).topics).toEqual(["technology"]);
  });
});

describe("set_tool_enabled tool", () => {
  it("enables a tool for the calling owner", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("enable-via-tool"));
    const result = await runTool(user.id, "set_tool_enabled", { tool: "teams", enabled: true });
    expect(result).toEqual({ ok: true });
    expect(getEnabledTools(user.id)).toEqual(new Set(["teams"]));
  });

  it("disables a tool for the calling owner", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("disable-via-tool"));
    setToolEnabled(user.id, "travel", true);
    const result = await runTool(user.id, "set_tool_enabled", { tool: "travel", enabled: false });
    expect(result).toEqual({ ok: true });
    expect(getEnabledTools(user.id)).toEqual(new Set());
  });

  it("returns an error object (not a throw) for an unknown tool key", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("unknown-tool-key"));
    const result = await runTool(user.id, "set_tool_enabled", { tool: "finance", enabled: true });
    expect(result).toEqual({ error: "unknown tool: finance" });
  });
});

describe("connect_xero tool", () => {
  it("saves a valid forwarding address for the calling owner", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("connect-xero"));
    const result = await runTool(user.id, "connect_xero", { forwarding_email: "abc123@bills.xero.com" });
    expect(result).toEqual({ ok: true });
    expect(getXeroForwardingEmail(user.id)).toBe("abc123@bills.xero.com");
  });

  it("returns an error object (not a throw) for a malformed address, and saves nothing", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("connect-xero-bad"));
    const result = await runTool(user.id, "connect_xero", { forwarding_email: "not-an-email" });
    expect(result).toEqual({ error: '"not-an-email" doesn\'t look like a valid email address.' });
    expect(getXeroForwardingEmail(user.id)).toBeNull();
  });
});

describe("buildSystemPrompt Xero status", () => {
  it("reports not connected when no address is saved", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("prompt-xero-off"));
    expect(buildSystemPrompt(user.id)).toContain("Xero: not connected");
  });

  it("reports the saved address once connected", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("prompt-xero-on"));
    await runTool(user.id, "connect_xero", { forwarding_email: "xyz789@bills.xero.com" });
    expect(buildSystemPrompt(user.id)).toContain("xyz789@bills.xero.com");
  });
});

describe("buildSystemPrompt onboarding paragraph", () => {
  it("is present when the user has never saved briefing settings", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("prompt-onboarding-on"));
    const prompt = buildSystemPrompt(user.id);
    expect(prompt).toContain("set_briefing_preferences");
  });

  it("is absent once briefing settings have been saved", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("prompt-onboarding-off"));
    saveBriefingSettings(user.id, {
      enabled: true,
      includeNews: false,
      topics: [],
      includeMarkets: false,
      tickers: [],
      includeWeather: false,
      weatherLocation: "",
      proactive: false,
      sendTime: "07:30",
    });
    const prompt = buildSystemPrompt(user.id);
    expect(prompt).not.toContain("set_briefing_preferences");
  });
});
