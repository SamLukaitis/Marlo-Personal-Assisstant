import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  const MockAnthropic = vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  });
  return { __esModule: true, default: MockAnthropic };
});

vi.mock("./memoryRetrieval.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./memoryRetrieval.js")>();
  return {
    ...actual,
    retrieveRelevantMemory: vi.fn(() => {
      throw new Error("SQLITE_CORRUPT");
    }),
  };
});

import { runAssistantChat } from "./assistant.js";
import { findOrCreateUserByEmail } from "../db/store.js";

beforeEach(() => {
  mockCreate.mockReset();
  process.env.ANTHROPIC_API_KEY = "test-key";
});

describe("runAssistantChat — memory retrieval failure", () => {
  it("still replies, with the user's message sent as-is, when retrieval throws", async () => {
    mockCreate.mockResolvedValueOnce({ content: [{ type: "text", text: "Hello!" }], usage: { input_tokens: 1, output_tokens: 1 } });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const user = findOrCreateUserByEmail(`retrieval-throws-${Date.now()}@example.com`);

    const reply = await runAssistantChat(user.id, [{ role: "user", content: "hi" }]);

    expect(reply.text).toBe("Hello!");
    const sent = mockCreate.mock.calls[0][0].messages as { content: { text: string }[] }[];
    expect(sent[0].content.map((b) => b.text)).toEqual(["hi"]);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });
});
