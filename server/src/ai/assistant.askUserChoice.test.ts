import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  // Arrow functions can never be used as constructors — `new Anthropic()` in assistant.ts
  // requires a real function here, not `() => ({...})`.
  const MockAnthropic = vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  });
  return { __esModule: true, default: MockAnthropic };
});

import { runAssistantChat } from "./assistant.js";
import { findOrCreateUserByEmail } from "../db/store.js";

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

beforeEach(() => {
  mockCreate.mockReset();
  process.env.ANTHROPIC_API_KEY = "test-key";
});

function toolUseResponse(name: string, input: Record<string, unknown>) {
  return { content: [{ type: "tool_use", id: "tool_1", name, input }] };
}

describe("runAssistantChat — ask_user_choice", () => {
  it("ends the turn immediately on a confirm choice, with Yes/No buttons", async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse("ask_user_choice", {
        question: "Archive 3 emails from Nike?",
        mode: "confirm",
        confirm_tool: "archive_messages",
        confirm_input: { account_id: 1, query: "from:nike" },
      })
    );
    const user = findOrCreateUserByEmail(uniqueEmail("confirm-choice"));

    const reply = await runAssistantChat(user.id, [{ role: "user", content: "archive nike emails" }]);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(reply.choice?.mode).toBe("confirm");
    expect(reply.choice?.buttons).toEqual([
      { key: "yes", label: "Yes" },
      { key: "no", label: "No" },
    ]);
    expect(reply.text).toContain("Archive 3 emails from Nike?");
  });

  it("ends the turn immediately on a resume choice, with one button per option", async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse("ask_user_choice", {
        question: "Which Sarah did you mean?",
        mode: "resume",
        options: [{ label: "Sarah Chen <sarah.chen@acme.com>" }, { label: "Sarah Lee <sarah.lee@acme.com>" }],
      })
    );
    const user = findOrCreateUserByEmail(uniqueEmail("resume-choice"));

    const reply = await runAssistantChat(user.id, [{ role: "user", content: "email sarah about the invoice" }]);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(reply.choice?.mode).toBe("resume");
    expect(reply.choice?.buttons).toEqual([
      { key: "0", label: "Sarah Chen <sarah.chen@acme.com>" },
      { key: "1", label: "Sarah Lee <sarah.lee@acme.com>" },
    ]);
  });

  it("returns plain text with no choice when the model doesn't call ask_user_choice", async () => {
    mockCreate.mockResolvedValueOnce({ content: [{ type: "text", text: "Sure, done." }] });
    const user = findOrCreateUserByEmail(uniqueEmail("no-choice"));

    const reply = await runAssistantChat(user.id, [{ role: "user", content: "hi" }]);

    expect(reply).toEqual({ text: "Sure, done." });
  });
});
