// The model used to get the chat history with no times on it, so a message from three days ago
// read exactly like one from a minute ago: "tomorrow" in an old message was taken as tomorrow from
// now, and something settled last week came back as if still open.
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  const MockAnthropic = vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  });
  return { __esModule: true, default: MockAnthropic };
});

import { runAssistantChat, runTool, stampUserMessage } from "./assistant.js";
import { findOrCreateUserByEmail } from "../db/store.js";
import { setUserTimezone } from "../services/userTimezone.js";

beforeEach(() => {
  mockCreate.mockReset();
  process.env.ANTHROPIC_API_KEY = "test-key";
});

function textOf(content: unknown): string {
  return typeof content === "string" ? content : (content as { text: string }[]).map((b) => b.text).join("\n");
}

describe("stampUserMessage", () => {
  it("prefixes the time the message was sent, on the user's own clock", () => {
    const at = Date.UTC(2026, 10, 10, 15, 47);
    expect(stampUserMessage("car hire today until tomorrow", at, "America/Argentina/Mendoza")).toBe(
      "[Tue 10 Nov 2026, 12:47] car hire today until tomorrow"
    );
    expect(stampUserMessage("hi", at, null)).toBe("[Tue 10 Nov 2026, 15:47 UTC] hi");
  });
});

describe("runAssistantChat — message times", () => {
  it("stamps the user's messages, never the assistant's, and explains the stamps in the system prompt", async () => {
    mockCreate.mockResolvedValueOnce({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } });
    const user = findOrCreateUserByEmail(`stamps-${Date.now()}@example.com`);
    setUserTimezone(user.id, "Europe/London");

    await runAssistantChat(user.id, [
      { role: "user", content: "train to Exeter tomorrow?", at: Date.UTC(2026, 10, 5, 21, 23) },
      { role: "assistant", content: "Here are the options.", at: Date.UTC(2026, 10, 5, 21, 24) },
      { role: "user", content: "and what about today", at: Date.UTC(2026, 10, 13, 9, 0) },
    ]);

    const request = mockCreate.mock.calls[0][0];
    const sent = request.messages as { role: string; content: unknown }[];
    expect(textOf(sent[0].content)).toBe("[Thu 5 Nov 2026, 21:23] train to Exeter tomorrow?");
    expect(textOf(sent[1].content)).toBe("Here are the options.");
    expect(textOf(sent[2].content)).toContain("[Fri 13 Nov 2026, 09:00] and what about today");
    expect(request.system[0].text).toMatch(/relative to that message's own stamp, not to now/);
  });

  it("leaves messages with no known time alone (the web chat)", async () => {
    mockCreate.mockResolvedValueOnce({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } });
    const user = findOrCreateUserByEmail(`stamps-web-${Date.now()}@example.com`);

    await runAssistantChat(user.id, [{ role: "user", content: "hello" }]);

    const request = mockCreate.mock.calls[0][0];
    expect(textOf(request.messages[0].content)).toBe("hello");
    expect(request.system[0].text).not.toMatch(/own stamp/);
  });
});

// A correction saved without replaces_id used to leave the old fact active beside the new one.
describe("remember — what's already held", () => {
  it("returns the saved id and the related facts already held, so an outdated one can be retired", async () => {
    const user = findOrCreateUserByEmail(`remember-related-${Date.now()}@example.com`);
    const first = (await runTool(user.id, "remember", { note: "The user lives in Leeds", kind: "core" })) as { id: number };
    const second = (await runTool(user.id, "remember", { note: "The user lives in London now", kind: "core" })) as {
      id: number;
      already_remembered?: { id: number; content: string; noted: string }[];
      check?: string;
    };

    expect(second.id).not.toBe(first.id);
    expect(second.already_remembered?.map((f) => f.id)).toEqual([first.id]);
    expect(second.check).toMatch(/forget_memory/);
  });

  it("doesn't list the fact it was told to replace", async () => {
    const user = findOrCreateUserByEmail(`remember-replaced-${Date.now()}@example.com`);
    const first = (await runTool(user.id, "remember", { note: "The user lives in Leeds", kind: "core" })) as { id: number };
    const second = (await runTool(user.id, "remember", {
      note: "The user lives in London now",
      kind: "core",
      replaces_id: first.id,
    })) as { already_remembered?: unknown[] };

    expect(second.already_remembered).toBeUndefined();
  });
});
