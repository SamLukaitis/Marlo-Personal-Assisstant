import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  const MockAnthropic = vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  });
  return { __esModule: true, default: MockAnthropic };
});

import { runAssistantChat } from "./assistant.js";
import { findOrCreateUserByEmail, addFact, findOrCreateEntity } from "../db/store.js";
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

type Block = { type: string; text?: string; cache_control?: unknown };
function blocksOf(m: Anthropic.MessageParam): Block[] {
  return typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as Block[]);
}
function stripCache(m: Anthropic.MessageParam) {
  return { role: m.role, content: blocksOf(m).map(({ cache_control: _c, ...rest }) => rest) };
}

describe("runAssistantChat — relevant-memory injection and stable-history breakpoint", () => {
  it("injects relevant memory as a leading block of the latest user message only", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } });
    const user = findOrCreateUserByEmail(uniqueEmail("inject-latest"));
    const sarah = findOrCreateEntity(user.id, "person", "Sarah");
    addFact(user.id, { content: "Sarah is the user's accountant", entityId: sarah.id });

    await runAssistantChat(user.id, [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi!" },
      { role: "user", content: "email Sarah" },
    ]);

    const messages = sentMessages(0);
    const latest = blocksOf(messages[2]);
    expect(latest).toHaveLength(2);
    expect(latest[0].text).toContain("Sarah is the user's accountant");
    expect(latest[1].text).toBe("email Sarah");
    expect(blocksOf(messages[0]).some((b) => b.text?.includes("accountant"))).toBe(false);
  });

  it("puts a breakpoint on the message before the latest user message, and at most two in messages", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } });
    const user = findOrCreateUserByEmail(uniqueEmail("stable-bp"));

    await runAssistantChat(user.id, [
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
      { role: "user", content: "three" },
    ]);

    const messages = sentMessages(0);
    const marked = messages.flatMap((m, i) => blocksOf(m).filter((b) => b.cache_control).map(() => i));
    expect(marked).toEqual([1, 2]);
  });

  it("keeps the history prefix byte-identical across turns while the injected block changes", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } });
    const user = findOrCreateUserByEmail(uniqueEmail("stable-prefix"));
    const sarah = findOrCreateEntity(user.id, "person", "Sarah");
    addFact(user.id, { content: "Sarah is the user's accountant", entityId: sarah.id });

    const turn1 = [
      { role: "user" as const, content: "hello" },
      { role: "assistant" as const, content: "hi!" },
      { role: "user" as const, content: "email Sarah" },
    ];
    await runAssistantChat(user.id, turn1);
    await runAssistantChat(user.id, [
      ...turn1,
      { role: "assistant" as const, content: "done" },
      { role: "user" as const, content: "thanks" },
    ]);

    const first = sentMessages(0);
    const second = sentMessages(1);
    // Prefix through the first call's stable breakpoint (index 1) is identical in the second call.
    expect(second.slice(0, 2).map(stripCache)).toEqual(first.slice(0, 2).map(stripCache));
    // The earlier user message no longer carries the injected block in the later call.
    expect(stripCache(second[2])).toEqual({ role: "user", content: [{ type: "text", text: "email Sarah" }] });
  });

  it("sends the system prompt without any per-message memory in it", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } });
    const user = findOrCreateUserByEmail(uniqueEmail("system-no-retrieval"));
    const sarah = findOrCreateEntity(user.id, "person", "Sarah");
    addFact(user.id, { content: "Sarah is the user's accountant", entityId: sarah.id });

    await runAssistantChat(user.id, [{ role: "user", content: "email Sarah" }]);

    const system = mockCreate.mock.calls[0][0].system as { text: string }[];
    expect(system[0].text).not.toContain("accountant");
  });
});
