import { describe, it, expect } from "vitest";
import { buildToolsForOwner, buildSystemPrompt, runTool } from "./assistant.js";
import { findOrCreateUserByEmail, setToolEnabled } from "../db/store.js";

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
