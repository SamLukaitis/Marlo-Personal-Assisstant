import { describe, it, expect } from "vitest";
import {
  findOrCreateUserByEmail,
  findOrCreateUserByPhone,
  recordApiUsage,
  getApiUsageSummary,
  getApiUsageByPurpose,
  listRecentApiUsage,
  getApiUsageByOwner,
} from "./store.js";

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

function uniquePhone(): string {
  counter += 1;
  return `44791${String(Date.now()).slice(-6)}${String(counter).padStart(2, "0")}`;
}

describe("recordApiUsage / getApiUsageSummary / getApiUsageByPurpose", () => {
  it("accepts a null owner (calls with no signed-in user yet, e.g. the public help widget)", () => {
    const before = getApiUsageSummary(0).reduce((sum, r) => sum + r.calls, 0);
    recordApiUsage(null, "web", "claude-haiku-4-5", "help_widget", 50, 10, 0, 0);
    const after = getApiUsageSummary(0).reduce((sum, r) => sum + r.calls, 0);
    expect(after).toBe(before + 1);
  });

  it("groups getApiUsageSummary by day/channel/model/purpose, keeping distinct purposes separate", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("usage-summary"));
    recordApiUsage(user.id, "web", "claude-sonnet-5", "assistant_chat", 100, 20, 4000, 800);
    recordApiUsage(user.id, "background", "claude-sonnet-5", "document_extraction", 300, 50, 0, 0);

    const rows = getApiUsageSummary(Date.now() - 1000);
    const chat = rows.filter((r) => r.purpose === "assistant_chat" && r.channel === "web");
    const extraction = rows.filter((r) => r.purpose === "document_extraction" && r.channel === "background");
    expect(chat.some((r) => r.inputTokens >= 100)).toBe(true);
    expect(extraction.some((r) => r.inputTokens >= 300)).toBe(true);
    // Cache tokens are recorded and summed separately from inputTokens — with caching active,
    // usage.input_tokens EXCLUDES the cached prefix, so folding them together would either
    // double-count or (the original bug) drop them entirely.
    expect(chat.some((r) => r.cacheReadTokens >= 4000 && r.cacheCreationTokens >= 800)).toBe(true);
  });

  it("getApiUsageByPurpose sums calls/tokens per purpose across every owner and channel", () => {
    const userA = findOrCreateUserByEmail(uniqueEmail("usage-purpose-a"));
    const userB = findOrCreateUserByEmail(uniqueEmail("usage-purpose-b"));
    const sinceMs = Date.now();
    recordApiUsage(userA.id, "web", "claude-sonnet-5", "conversation_summary_test_marker", 1000, 100, 500, 50);
    recordApiUsage(userB.id, "whatsapp", "claude-haiku-4-5", "conversation_summary_test_marker", 2000, 200, 1500, 150);

    const rows = getApiUsageByPurpose(sinceMs - 1000);
    const marker = rows.find((r) => r.purpose === "conversation_summary_test_marker");
    expect(marker).toMatchObject({
      calls: 2,
      inputTokens: 3000,
      outputTokens: 300,
      cacheReadTokens: 2000,
      cacheCreationTokens: 200,
    });
  });

  it("keeps message text only when given, trimmed to 500 characters, and messagesOnly filters to it", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("usage-message-text"));
    recordApiUsage(user.id, "web", "claude-sonnet-5", "message_text_test_marker", 1, 1, 0, 0, {
      userMessage: "x".repeat(800),
      replyText: "short reply",
    });
    recordApiUsage(user.id, "web", "claude-sonnet-5", "message_text_test_marker_none", 1, 1, 0, 0);

    const withText = listRecentApiUsage(200).find((r) => r.purpose === "message_text_test_marker");
    expect(withText?.userMessage).toHaveLength(500);
    expect(withText?.replyText).toBe("short reply");
    expect(listRecentApiUsage(200).find((r) => r.purpose === "message_text_test_marker_none")?.userMessage).toBeNull();

    const onlyMessages = listRecentApiUsage(200, true);
    expect(onlyMessages.every((r) => r.userMessage !== null)).toBe(true);
    expect(onlyMessages.some((r) => r.purpose === "message_text_test_marker")).toBe(true);
  });

  it("listRecentApiUsage returns individual calls newest-first with an exact timestamp and owner email", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("usage-recent"));
    recordApiUsage(user.id, "web", "claude-sonnet-5", "recent_calls_test_marker", 111, 22, 999, 33);
    recordApiUsage(null, "web", "claude-haiku-4-5", "recent_calls_test_marker_anon", 5, 5, 0, 0);

    const recent = listRecentApiUsage(200);
    const ownedCall = recent.find((r) => r.purpose === "recent_calls_test_marker");
    const anonCall = recent.find((r) => r.purpose === "recent_calls_test_marker_anon");
    expect(ownedCall).toMatchObject({
      ownerEmail: user.email,
      inputTokens: 111,
      outputTokens: 22,
      cacheReadTokens: 999,
      cacheCreationTokens: 33,
    });
    expect(typeof ownedCall?.createdAt).toBe("number");
    expect(anonCall?.ownerEmail).toBeNull();

    // Newest-first: the second recorded call (anonCall) should not sort after the first.
    const ownedIndex = recent.findIndex((r) => r.purpose === "recent_calls_test_marker");
    const anonIndex = recent.findIndex((r) => r.purpose === "recent_calls_test_marker_anon");
    expect(anonIndex).toBeLessThan(ownedIndex);
  });
});

// Cost attribution has to key on owner id, not the owner's email address. Once phone-first
// accounts exist (they have no email), keying on the address collapsed every one of them into a
// single bucket that also swept up genuinely ownerless pre-login calls, so an admin could not see
// what any individual phone-first user costs. ownerId/ownerExists are what tell the three reasons
// for a null ownerEmail apart: no owner at all, a deleted account, and an account with no mailbox.
describe("getApiUsageByOwner attribution", () => {
  it("surfaces ownerId and keeps distinct owners in distinct rows", () => {
    const a = findOrCreateUserByEmail(uniqueEmail("usage-owner-a"));
    const b = findOrCreateUserByEmail(uniqueEmail("usage-owner-b"));
    const model = `test-model-${Date.now()}`;

    recordApiUsage(a.id, "whatsapp", model, "assistant_chat", 10, 5, 0, 0);
    recordApiUsage(b.id, "whatsapp", model, "assistant_chat", 20, 7, 0, 0);
    recordApiUsage(null, "web", model, "help_widget", 30, 9, 0, 0);

    const rows = getApiUsageByOwner(0).filter((r) => r.model === model);

    expect(rows).toHaveLength(3);
    const byOwner = new Map(rows.map((r) => [r.ownerId, r]));
    expect(byOwner.get(a.id)?.ownerEmail).toBe(a.email);
    expect(byOwner.get(b.id)?.ownerEmail).toBe(b.email);
    // A call with no owner at all: no id to attribute it to, and nothing to join to.
    expect(byOwner.get(null)?.ownerEmail).toBeNull();
    expect(byOwner.get(null)?.ownerExists).toBeFalsy();
  });

  it("reports ownerExists for a live account so a null email can be told from a missing row", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("usage-owner-live"));
    const model = `test-model-live-${Date.now()}`;
    recordApiUsage(user.id, "whatsapp", model, "assistant_chat", 11, 3, 0, 0);

    const row = getApiUsageByOwner(0).find((r) => r.model === model && r.ownerId === user.id);

    expect(row?.ownerExists).toBeTruthy();
  });

  it("carries ownerId onto individual calls too, not just the rollup", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("usage-call-owner"));
    const model = `test-model-call-${Date.now()}`;
    recordApiUsage(user.id, "whatsapp", model, "assistant_chat", 12, 4, 0, 0);

    const call = listRecentApiUsage(200).find((r) => r.model === model);

    expect(call?.ownerId).toBe(user.id);
    expect(call?.ownerExists).toBeTruthy();
  });

  it("attributes a phone-first account (null email) to its own id, not the no-owner bucket", () => {
    const user = findOrCreateUserByPhone(uniquePhone());
    const model = `test-model-phone-${Date.now()}`;
    recordApiUsage(user.id, "whatsapp", model, "assistant_chat", 13, 6, 0, 0);

    const rows = getApiUsageByOwner(0).filter((r) => r.model === model);
    const row = rows.find((r) => r.ownerId === user.id);

    expect(row?.ownerExists).toBeTruthy();
    expect(row?.ownerEmail).toBeNull();
    // Must land on its own owner row, not fold into the ownerId === null bucket that anonymous
    // (no-owner) calls use — a phone-first account has no email, but it does have an id.
    expect(rows.find((r) => r.ownerId === null)).toBeUndefined();
  });
});
