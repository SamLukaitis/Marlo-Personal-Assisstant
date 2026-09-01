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

const mockHubDeleteEvent = vi.fn();
vi.mock("../services/hub.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/hub.js")>();
  return { ...actual, hubDeleteEvent: (...args: unknown[]) => mockHubDeleteEvent(...args) };
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
  mockHubDeleteEvent.mockReset();
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

describe("runAssistantChat — react_to_message", () => {
  it("ends the turn immediately with a reaction, no text, and no second API call", async () => {
    mockCreate.mockResolvedValueOnce(toolUseResponse("react_to_message", { emoji: "👍" }));
    const user = findOrCreateUserByEmail(uniqueEmail("react-to-message"));

    const reply = await runAssistantChat(user.id, [{ role: "user", content: "ok thanks" }]);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(reply).toEqual({ text: "", reaction: { emoji: "👍" } });
  });

  it("is ignored if the model also produced text in the same turn — text wins", async () => {
    // Mirrors ask_user_choice's own "call it alone" contract: if the model didn't follow that,
    // prefer the visible text over a silent, unreadable reaction.
    mockCreate.mockResolvedValueOnce({
      content: [
        { type: "text", text: "Got it!" },
        { type: "tool_use", id: "tool_1", name: "react_to_message", input: { emoji: "👍" } },
      ],
    });
    const user = findOrCreateUserByEmail(uniqueEmail("react-to-message-with-text"));

    const reply = await runAssistantChat(user.id, [{ role: "user", content: "ok thanks" }]);

    expect(reply).toEqual({ text: "Got it!" });
  });
});

describe("runAssistantChat — confirm-required tools can't be called directly", () => {
  it("rejects a direct delete_calendar_event call instead of executing it", async () => {
    mockCreate
      .mockResolvedValueOnce(
        toolUseResponse("delete_calendar_event", { account_id: 1, event_id: "evt_1" })
      )
      .mockResolvedValueOnce({ content: [{ type: "text", text: "I'll confirm first." }] });
    const user = findOrCreateUserByEmail(uniqueEmail("confirm-required-delete"));

    const reply = await runAssistantChat(user.id, [{ role: "user", content: "delete my 3pm event" }]);

    expect(mockHubDeleteEvent).not.toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(reply).toEqual({ text: "I'll confirm first." });

    // The second turn's request must carry back an error result telling the model why, and to
    // use ask_user_choice instead — not a silent/blank rejection it can't act on.
    const secondCallMessages = mockCreate.mock.calls[1][0].messages;
    const toolResultMessage = secondCallMessages[secondCallMessages.length - 1];
    const toolResult = toolResultMessage.content[0];
    expect(toolResult.is_error).toBe(true);
    expect(toolResult.content).toContain("ask_user_choice");
  });

  it("still executes delete_calendar_event once actually confirmed via ask_user_choice", async () => {
    // This is the legitimate path: ask_user_choice stages the pending action; a "Yes" tap calls
    // runTool directly from actionHandlers.ts, never through this loop. Confirming that path is
    // unaffected by the new gate — runTool itself isn't gated, only the live-turn loop is.
    const { runTool } = await import("./assistant.js");
    const user = findOrCreateUserByEmail(uniqueEmail("confirm-required-delete-confirmed"));

    await runTool(user.id, "delete_calendar_event", { account_id: 1, event_id: "evt_1" });

    expect(mockHubDeleteEvent).toHaveBeenCalledWith(user.id, 1, "evt_1");
  });
});
