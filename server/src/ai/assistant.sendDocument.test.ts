import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  const MockAnthropic = vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  });
  return { __esModule: true, default: MockAnthropic };
});

const mockSendSavedDocumentFile = vi.fn();
vi.mock("../services/documents.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/documents.js")>()),
  sendSavedDocumentFile: (...args: unknown[]) => mockSendSavedDocumentFile(...args),
}));

import { runAssistantChat, SENT_FILES_NOTE_PREFIX } from "./assistant.js";
import { findOrCreateUserByEmail } from "../db/store.js";

const originalEnv = { ...process.env };
let counter = 0;
function newUser(prefix: string) {
  counter += 1;
  return findOrCreateUserByEmail(`${prefix}-${Date.now()}-${counter}@example.com`);
}

function toolUse(id: string, name: string, input: Record<string, unknown>) {
  return { type: "tool_use", id, name, input };
}

beforeEach(() => {
  mockCreate.mockReset();
  mockSendSavedDocumentFile.mockReset();
  process.env.ANTHROPIC_API_KEY = "test-key";
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("runAssistantChat — files sent with send_document", () => {
  it("notes every file it sent, so the next turn can see they went", async () => {
    mockSendSavedDocumentFile
      .mockResolvedValueOnce({ ok: true, title: "Passport" })
      .mockResolvedValueOnce({ ok: true, title: "Driving licence" });
    mockCreate
      .mockResolvedValueOnce({
        content: [toolUse("t1", "send_document", { document_id: 1 }), toolUse("t2", "send_document", { document_id: 2 })],
        stop_reason: "tool_use",
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Here they are." }], stop_reason: "end_turn" });

    const reply = await runAssistantChat(newUser("send-doc-note").id, [{ role: "user", content: "send my passport and licence" }], "447000000001");

    expect(reply.text).toBe("Here they are.");
    expect(reply.historyNote).toBe(`${SENT_FILES_NOTE_PREFIX} Passport, Driving licence]`);
  });

  it("adds no note when a send failed or nothing was sent", async () => {
    mockSendSavedDocumentFile.mockResolvedValueOnce({ ok: false, reason: "send_failed" });
    mockCreate
      .mockResolvedValueOnce({ content: [toolUse("t1", "send_document", { document_id: 1 })], stop_reason: "tool_use" })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "That one wouldn't send." }], stop_reason: "end_turn" });

    const reply = await runAssistantChat(newUser("send-doc-fail").id, [{ role: "user", content: "send my passport" }], "447000000001");

    expect(reply.historyNote).toBeUndefined();
  });
});
