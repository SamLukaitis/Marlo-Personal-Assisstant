import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  const MockAnthropic = vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  });
  return { __esModule: true, default: MockAnthropic };
});

import { runAssistantChat } from "./assistant.js";
import { findOrCreateUserByEmail, getApiUsageSummary, listUnmetRequests } from "../db/store.js";

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

beforeEach(() => {
  mockCreate.mockReset();
  process.env.ANTHROPIC_API_KEY = "test-key";
});

function totalCalls(): number {
  return getApiUsageSummary(0).reduce((sum, r) => sum + r.calls, 0);
}

describe("runAssistantChat — usage tracking", () => {
  it("records exactly one usage row per invocation when the model answers in one turn", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Sure, done." }],
      usage: { input_tokens: 100, output_tokens: 20 },
    });
    const before = totalCalls();
    const user = findOrCreateUserByEmail(uniqueEmail("usage-single-turn"));

    await runAssistantChat(user.id, [{ role: "user", content: "hi" }]);

    expect(totalCalls()).toBe(before + 1);
  });

  it("still records exactly one usage row after several internal tool-call turns", async () => {
    // Turn 1: the model calls remember (a real, always-on, side-effect-free tool). Turn 2: it
    // answers with plain text. Both anthropic.messages.create calls belong to the same single
    // runAssistantChat invocation, so usage should be summed and recorded once, not twice.
    mockCreate
      .mockResolvedValueOnce({
        content: [{ type: "tool_use", id: "tool_1", name: "remember", input: { note: "test" } }],
        usage: { input_tokens: 50, output_tokens: 10 },
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "Noted." }],
        usage: { input_tokens: 60, output_tokens: 15 },
      });
    const before = totalCalls();
    const user = findOrCreateUserByEmail(uniqueEmail("usage-multi-turn"));

    await runAssistantChat(user.id, [{ role: "user", content: "remember I like tea" }]);

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(totalCalls()).toBe(before + 1);
  });

  // Regression test for a real bug found 2026-08-28: flag_unmet_request's own instructions tell
  // the model to call it "alongside your normal reply, same turn" — meaning the model's actual
  // reply text is usually already present in the SAME response as the tool call. Before the fix,
  // the loop discarded that text and paid for a second full round-trip (whole system prompt +
  // tools + history resent) just to get the model to repeat itself as plain text, doubling the
  // cost of every single capability-gap decline.
  it("costs only one API call when the model combines flag_unmet_request with its reply text in the same turn", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        { type: "text", text: "I can't book flights yet, sorry!" },
        { type: "tool_use", id: "tool_1", name: "flag_unmet_request", input: { summary: "Wanted to book a flight" } },
      ],
      usage: { input_tokens: 80, output_tokens: 15 },
    });
    const before = totalCalls();
    const user = findOrCreateUserByEmail(uniqueEmail("flag-unmet-single-turn"));

    const reply = await runAssistantChat(user.id, [{ role: "user", content: "book me a flight" }]);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(reply).toEqual({ text: "I can't book flights yet, sorry!" });
    expect(totalCalls()).toBe(before + 1);
    expect(listUnmetRequests(true).some((r) => r.ownerId === user.id)).toBe(true);
  });
});
