import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  const MockAnthropic = vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  });
  return { __esModule: true, default: MockAnthropic };
});

import { runAssistantChat, buildToolsForOwner } from "./assistant.js";
import { MODEL_FAST, MODEL_STRONG, __resetRoutingStateForTests } from "./modelRouting.js";
import { findOrCreateUserByEmail, listRecentApiUsage } from "../db/store.js";

let counter = 0;
function newUser(prefix: string): number {
  counter += 1;
  return findOrCreateUserByEmail(`${prefix}-${Date.now()}-${counter}@example.com`).id;
}
type SentRequest = { model: string; tools: Array<{ name: string; type?: string }>; output_config?: unknown; thinking?: unknown };
function sent(i: number): SentRequest {
  return mockCreate.mock.calls[i][0];
}

const savedMode = process.env.ASSISTANT_FAST_FIRST;
beforeEach(() => {
  mockCreate.mockReset();
  __resetRoutingStateForTests();
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.ASSISTANT_FAST_FIRST = "all";
});
afterEach(() => {
  if (savedMode === undefined) delete process.env.ASSISTANT_FAST_FIRST;
  else process.env.ASSISTANT_FAST_FIRST = savedMode;
});

describe("runAssistantChat — fast-first routing", () => {
  it("answers on the fast model at low effort, with the escalate tool and basic web search", async () => {
    mockCreate.mockResolvedValueOnce({ content: [{ type: "text", text: "Yard Act at the O2." }], usage: { input_tokens: 10, output_tokens: 5 } });
    const id = newUser("route-fast");

    const reply = await runAssistantChat(id, [{ role: "user", content: "what live music is on in leeds saturday" }]);

    expect(reply.text).toBe("Yard Act at the O2.");
    const req = sent(0);
    expect(req.model).toBe(MODEL_FAST);
    expect(req.output_config).toEqual({ effort: "low" });
    expect(req.thinking).toBeUndefined();
    expect(req.tools.map((t) => t.name)).toContain("escalate_to_stronger_model");
    expect(req.tools.find((t) => t.name === "web_search")?.type).toBe("web_search_20250305");
  });

  it("reruns on the strong model when the fast model escalates, and records both", async () => {
    mockCreate
      .mockResolvedValueOnce({
        content: [{ type: "tool_use", id: "t1", name: "escalate_to_stronger_model", input: { reason: "needs judgement" } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5 },
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Here's a careful answer." }], usage: { input_tokens: 20, output_tokens: 30 } });
    const id = newUser("route-escalate");

    const reply = await runAssistantChat(id, [{ role: "user", content: "my flatmate keeps eating my food" }]);

    expect(reply.text).toBe("Here's a careful answer.");
    expect(sent(1).model).toBe(MODEL_STRONG);
    expect(sent(1).output_config).toEqual({ effort: "medium" });
    expect(sent(1).thinking).toEqual({ type: "adaptive" });
    // The fast model's escalate call is dropped, not replayed to the strong model.
    expect(JSON.stringify(mockCreate.mock.calls[1][0].messages)).not.toContain("escalate_to_stronger_model");
    expect(sent(1).tools.map((t) => t.name)).not.toContain("escalate_to_stronger_model");
    expect(sent(1).tools.find((t) => t.name === "web_search")?.type).toBe("web_search_20260209");

    const rows = listRecentApiUsage(50).filter((r) => r.ownerId === id);
    expect(rows.map((r) => [r.model, r.purpose]).sort()).toEqual(
      [[MODEL_FAST, "assistant_chat_escalated"], [MODEL_STRONG, "assistant_chat"]].sort()
    );

    // ...and the next message stays on the strong model.
    mockCreate.mockResolvedValueOnce({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } });
    await runAssistantChat(id, [{ role: "user", content: "thanks, what else?" }]);
    expect(sent(2).model).toBe(MODEL_STRONG);
  });

  it("reruns on the strong model when the fast model refuses", async () => {
    mockCreate
      .mockResolvedValueOnce({ content: [], stop_reason: "refusal", usage: { input_tokens: 10, output_tokens: 0 } })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Sure." }], usage: { input_tokens: 10, output_tokens: 2 } });

    const reply = await runAssistantChat(newUser("route-refusal"), [{ role: "user", content: "hello" }]);

    expect(reply.text).toBe("Sure.");
    expect(sent(1).model).toBe(MODEL_STRONG);
  });

  it("steps up when the user pushes back on a fast-model reply", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } });
    const id = newUser("route-pushback");

    await runAssistantChat(id, [{ role: "user", content: "what's on tonight" }]);
    await runAssistantChat(id, [
      { role: "user", content: "what's on tonight" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "that's not what I asked" },
    ]);

    expect(sent(0).model).toBe(MODEL_FAST);
    expect(sent(1).model).toBe(MODEL_STRONG);
  });
});

describe("buildToolsForOwner — per-model tools", () => {
  it("gives the strong model filtered web search and no escalate tool", () => {
    const tools = buildToolsForOwner(newUser("tools-strong"), MODEL_STRONG) as SentRequest["tools"];
    expect(tools.find((t) => t.name === "web_search")?.type).toBe("web_search_20260209");
    expect(tools.map((t) => t.name)).not.toContain("escalate_to_stronger_model");
  });

  it("keeps the cache breakpoint on the last tool when the escalate tool is added", () => {
    const tools = buildToolsForOwner(newUser("tools-fast"), MODEL_FAST) as Array<{ name: string; cache_control?: unknown }>;
    expect(tools[tools.length - 1].name).toBe("escalate_to_stronger_model");
    expect(tools[tools.length - 1].cache_control).toBeDefined();
    expect(tools.filter((t) => t.cache_control)).toHaveLength(1);
  });
});
