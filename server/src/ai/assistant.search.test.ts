import { describe, it, expect, vi, beforeEach } from "vitest";

const mockHubListMessages = vi.fn();
vi.mock("../services/hub.js", () => ({
  hubListMessages: (...args: unknown[]) => mockHubListMessages(...args),
}));

const { runTool, SEARCH_MESSAGES_DEFAULT_LIMIT, LIST_RECENT_MESSAGES_DEFAULT_LIMIT } = await import("./assistant.js");
const { findOrCreateUserByEmail } = await import("../db/store.js");

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

beforeEach(() => {
  mockHubListMessages.mockReset();
  mockHubListMessages.mockResolvedValue([]);
});

describe("search_messages / list_recent_messages default limits", () => {
  it("defaults search_messages to a limit of 30", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("search-limit"));
    await runTool(user.id, "search_messages", { query: "south america" });
    expect(mockHubListMessages).toHaveBeenCalledWith(
      user.id,
      expect.objectContaining({ query: "south america", limit: SEARCH_MESSAGES_DEFAULT_LIMIT })
    );
    expect(SEARCH_MESSAGES_DEFAULT_LIMIT).toBe(30);
  });

  it("defaults list_recent_messages to a limit of 20 (raised from 10)", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("recent-limit"));
    await runTool(user.id, "list_recent_messages", {});
    expect(mockHubListMessages).toHaveBeenCalledWith(
      user.id,
      expect.objectContaining({ limit: LIST_RECENT_MESSAGES_DEFAULT_LIMIT })
    );
    expect(LIST_RECENT_MESSAGES_DEFAULT_LIMIT).toBe(20);
  });

  it("still lets a caller override either default limit", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("search-limit-override"));
    await runTool(user.id, "search_messages", { query: "brazil", limit: 5 });
    expect(mockHubListMessages).toHaveBeenCalledWith(user.id, expect.objectContaining({ limit: 5 }));

    await runTool(user.id, "list_recent_messages", { limit: 3 });
    expect(mockHubListMessages).toHaveBeenCalledWith(user.id, expect.objectContaining({ limit: 3 }));
  });
});
