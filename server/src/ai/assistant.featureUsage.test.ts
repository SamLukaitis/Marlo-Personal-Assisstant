import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  const MockAnthropic = vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  });
  return { __esModule: true, default: MockAnthropic };
});

import { runAssistantChat, assistantToolCatalog } from "./assistant.js";
import { findOrCreateUserByEmail, listFeatureMessages } from "../db/store.js";
import { DOCUMENT_SENT_MARKER, toolArea } from "../services/featureUsage.js";

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

beforeEach(() => {
  mockCreate.mockReset();
  process.env.ANTHROPIC_API_KEY = "test-key";
});

function toolsFor(ownerId: number): Record<string, number>[] {
  const byMessage = new Map<number, Record<string, number>>();
  for (const r of listFeatureMessages(0).filter((r) => r.ownerId === ownerId)) {
    const m = byMessage.get(r.messageId) ?? {};
    if (r.toolName) m[r.toolName] = r.uses ?? 0;
    byMessage.set(r.messageId, m);
  }
  return [...byMessage.values()];
}

describe("runAssistantChat — feature use", () => {
  it("records a message with no tools as one message and nothing else", async () => {
    mockCreate.mockResolvedValueOnce({ content: [{ type: "text", text: "Hello!" }], usage: { input_tokens: 1, output_tokens: 1 } });
    const user = findOrCreateUserByEmail(uniqueEmail("feature-none"));

    await runAssistantChat(user.id, [{ role: "user", content: "hi" }]);

    expect(toolsFor(user.id)).toEqual([{}]);
  });

  it("counts each tool the reply ran, and web searches from the usage report", async () => {
    mockCreate
      .mockResolvedValueOnce({
        content: [
          { type: "tool_use", id: "t1", name: "get_current_time", input: {} },
          { type: "tool_use", id: "t2", name: "remember", input: { note: "likes tea" } },
        ],
        usage: { input_tokens: 1, output_tokens: 1, server_tool_use: { web_search_requests: 2 } },
      })
      .mockResolvedValueOnce({
        content: [{ type: "tool_use", id: "t3", name: "get_current_time", input: {} }],
        usage: { input_tokens: 1, output_tokens: 1 },
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Noted." }], usage: { input_tokens: 1, output_tokens: 1 } });
    const user = findOrCreateUserByEmail(uniqueEmail("feature-tools"));

    await runAssistantChat(user.id, [{ role: "user", content: "remember I like tea" }]);

    expect(toolsFor(user.id)).toEqual([{ get_current_time: 2, remember: 1, web_search: 2 }]);
  });

  it("counts the tool a confirm button offers, which only runs after the tap", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: "tool_use",
          id: "t1",
          name: "ask_user_choice",
          input: { question: "Send it?", mode: "confirm", confirm_tool: "send_email", confirm_input: {} },
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const user = findOrCreateUserByEmail(uniqueEmail("feature-confirm"));

    await runAssistantChat(user.id, [{ role: "user", content: "send Jo the email" }]);

    expect(toolsFor(user.id)).toEqual([{ ask_user_choice: 1, send_email: 1 }]);
  });

  it("counts a photo or document sent in the messages being answered, but not an older one", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "Saved." }], usage: { input_tokens: 1, output_tokens: 1 } });
    const user = findOrCreateUserByEmail(uniqueEmail("feature-document"));
    const doc = `${DOCUMENT_SENT_MARKER} and has already been downloaded and saved. Extracted content: receipt`;

    await runAssistantChat(user.id, [{ role: "user", content: doc }]);
    await runAssistantChat(user.id, [
      { role: "user", content: doc },
      { role: "assistant", content: "Saved." },
      { role: "user", content: "thanks" },
    ]);

    expect(toolsFor(user.id)).toEqual([{ document_sent: 1 }, {}]);
  });
});

describe("assistantToolCatalog", () => {
  it("puts every tool Marlowe can offer in a Feature use area", () => {
    const missing = assistantToolCatalog()
      .map((t) => t.name)
      .filter((name) => toolArea(name) === null);
    expect(missing).toEqual([]);
  });
});
