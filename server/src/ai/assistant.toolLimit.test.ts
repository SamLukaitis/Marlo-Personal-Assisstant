// A request that used up every tool round used to end with "I wasn't able to finish that within my
// tool-call limit — try a more specific request", throwing away everything already looked up.
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
import { setUserTimezone } from "../services/userTimezone.js";

const usage = { input_tokens: 1, output_tokens: 1 };
const toolRound = (n: number) => ({
  stop_reason: "tool_use",
  content: [{ type: "tool_use", id: `toolu_${n}`, name: "get_current_time", input: {} }],
  usage,
});

beforeEach(() => {
  mockCreate.mockReset();
  process.env.ANTHROPIC_API_KEY = "test-key";
});

describe("runAssistantChat — out of tool rounds", () => {
  it("asks for an answer from what was already found, with tools switched off", async () => {
    for (let n = 0; n < 8; n++) mockCreate.mockResolvedValueOnce(toolRound(n));
    mockCreate.mockResolvedValueOnce({ content: [{ type: "text", text: "Here's what I found so far." }], usage });
    const user = findOrCreateUserByEmail(`tool-limit-${Date.now()}@example.com`);
    setUserTimezone(user.id, "Europe/London");

    const reply = await runAssistantChat(user.id, [{ role: "user", content: "sort everything out" }]);

    expect(reply.text).toBe("Here's what I found so far.");
    expect(mockCreate).toHaveBeenCalledTimes(9);
    const last = mockCreate.mock.calls[8][0];
    expect(last.tool_choice).toEqual({ type: "none" });
    // Every tool result gathered along the way is still in the request.
    expect(JSON.stringify(last.messages)).toContain("toolu_7");
  });

  it("falls back to the plain message if that last call fails", async () => {
    for (let n = 0; n < 8; n++) mockCreate.mockResolvedValueOnce(toolRound(n));
    mockCreate.mockRejectedValueOnce(new Error("overloaded"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const user = findOrCreateUserByEmail(`tool-limit-fail-${Date.now()}@example.com`);
    setUserTimezone(user.id, "Europe/London");

    const reply = await runAssistantChat(user.id, [{ role: "user", content: "sort everything out" }]);

    expect(reply.text).toMatch(/tool-call limit/);
    errors.mockRestore();
  });
});
