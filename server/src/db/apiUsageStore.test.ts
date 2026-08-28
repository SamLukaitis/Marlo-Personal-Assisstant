import { describe, it, expect } from "vitest";
import { findOrCreateUserByEmail, recordApiUsage, getApiUsageSummary, getApiUsageByPurpose } from "./store.js";

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

describe("recordApiUsage / getApiUsageSummary / getApiUsageByPurpose", () => {
  it("accepts a null owner (calls with no signed-in user yet, e.g. the public help widget)", () => {
    const before = getApiUsageSummary(0).reduce((sum, r) => sum + r.calls, 0);
    recordApiUsage(null, "web", "claude-haiku-4-5", "help_widget", 50, 10);
    const after = getApiUsageSummary(0).reduce((sum, r) => sum + r.calls, 0);
    expect(after).toBe(before + 1);
  });

  it("groups getApiUsageSummary by day/channel/model/purpose, keeping distinct purposes separate", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("usage-summary"));
    recordApiUsage(user.id, "web", "claude-sonnet-5", "assistant_chat", 100, 20);
    recordApiUsage(user.id, "background", "claude-sonnet-5", "document_extraction", 300, 50);

    const rows = getApiUsageSummary(Date.now() - 1000);
    const chat = rows.filter((r) => r.purpose === "assistant_chat" && r.channel === "web");
    const extraction = rows.filter((r) => r.purpose === "document_extraction" && r.channel === "background");
    expect(chat.some((r) => r.inputTokens >= 100)).toBe(true);
    expect(extraction.some((r) => r.inputTokens >= 300)).toBe(true);
  });

  it("getApiUsageByPurpose sums calls/tokens per purpose across every owner and channel", () => {
    const userA = findOrCreateUserByEmail(uniqueEmail("usage-purpose-a"));
    const userB = findOrCreateUserByEmail(uniqueEmail("usage-purpose-b"));
    const sinceMs = Date.now();
    recordApiUsage(userA.id, "web", "claude-sonnet-5", "conversation_summary_test_marker", 1000, 100);
    recordApiUsage(userB.id, "whatsapp", "claude-haiku-4-5", "conversation_summary_test_marker", 2000, 200);

    const rows = getApiUsageByPurpose(sinceMs - 1000);
    const marker = rows.find((r) => r.purpose === "conversation_summary_test_marker");
    expect(marker).toMatchObject({ calls: 2, inputTokens: 3000, outputTokens: 300 });
  });
});
