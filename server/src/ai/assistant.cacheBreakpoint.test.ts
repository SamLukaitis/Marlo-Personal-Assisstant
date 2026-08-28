import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  const MockAnthropic = vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  });
  return { __esModule: true, default: MockAnthropic };
});

import { runAssistantChat } from "./assistant.js";
import { findOrCreateUserByEmail } from "../db/store.js";
import type Anthropic from "@anthropic-ai/sdk";

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

beforeEach(() => {
  mockCreate.mockReset();
  process.env.ANTHROPIC_API_KEY = "test-key";
});

// Pulls the `messages` array actually sent to the SDK on a given call index, typed loosely
// since the mock's call args aren't statically typed.
function sentMessages(callIndex: number): Anthropic.MessageParam[] {
  return mockCreate.mock.calls[callIndex][0].messages;
}

describe("runAssistantChat — messages cache breakpoint (feature-to-do/token-cost-reduction.md #2)", () => {
  it("puts an ephemeral cache_control breakpoint on the last content block of the last message", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Sure, done." }],
      usage: { input_tokens: 100, output_tokens: 20 },
    });
    const user = findOrCreateUserByEmail(uniqueEmail("cache-bp-single-turn"));

    await runAssistantChat(user.id, [{ role: "user", content: "hi" }]);

    const messages = sentMessages(0);
    const last = messages[messages.length - 1];
    expect(Array.isArray(last.content)).toBe(true);
    const lastBlock = (last.content as Array<{ cache_control?: unknown }>).slice(-1)[0];
    expect(lastBlock.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("moves the breakpoint onto the new last message each turn, without leaving a stale one on an earlier message", async () => {
    mockCreate
      .mockResolvedValueOnce({
        content: [{ type: "tool_use", id: "tool_1", name: "remember", input: { note: "test" } }],
        usage: { input_tokens: 50, output_tokens: 10 },
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "Noted." }],
        usage: { input_tokens: 60, output_tokens: 15 },
      });
    const user = findOrCreateUserByEmail(uniqueEmail("cache-bp-multi-turn"));

    await runAssistantChat(user.id, [{ role: "user", content: "remember I like tea" }]);

    expect(mockCreate).toHaveBeenCalledTimes(2);

    const turn2Messages = sentMessages(1);
    // Exactly one content block across the whole request carries cache_control, and it's the
    // last block of the last message — never more than one, and never on an earlier message.
    const withCache = turn2Messages.flatMap((m, i) =>
      Array.isArray(m.content)
        ? m.content
            .map((b, j) => ({ i, j, block: b as { cache_control?: unknown } }))
            .filter(({ block }) => block.cache_control !== undefined)
        : []
    );
    expect(withCache).toHaveLength(1);
    const { i, j } = withCache[0];
    expect(i).toBe(turn2Messages.length - 1);
    const lastContent = turn2Messages[turn2Messages.length - 1].content as unknown[];
    expect(j).toBe(lastContent.length - 1);
  });
});
