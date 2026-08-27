import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/store.js", () => ({
  consumePendingAction: vi.fn(),
  appendWhatsAppMessage: vi.fn(),
  getWhatsAppHistory: vi.fn().mockReturnValue([]),
}));
vi.mock("../ai/assistant.js", () => ({
  runTool: vi.fn(),
  runAssistantChat: vi.fn(),
  MAX_HISTORY_MESSAGES: 12,
}));
vi.mock("../providers/whatsapp.js", () => ({
  sendWhatsAppMessage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./whatsappReply.js", () => ({
  sendAssistantReply: vi.fn().mockResolvedValue(undefined),
}));

const { consumePendingAction, appendWhatsAppMessage, getWhatsAppHistory } = await import("../db/store.js");
const { runTool, runAssistantChat } = await import("../ai/assistant.js");
const { sendWhatsAppMessage } = await import("../providers/whatsapp.js");
const { sendAssistantReply } = await import("./whatsappReply.js");
const { handlePendingActionReply } = await import("./actionHandlers.js");

beforeEach(() => {
  vi.mocked(consumePendingAction).mockReset();
  vi.mocked(appendWhatsAppMessage).mockClear();
  vi.mocked(getWhatsAppHistory).mockReset().mockReturnValue([]);
  vi.mocked(runTool).mockReset();
  vi.mocked(runAssistantChat).mockReset();
  vi.mocked(sendWhatsAppMessage).mockClear();
  vi.mocked(sendAssistantReply).mockClear();
});

describe("handlePendingActionReply", () => {
  it("returns false for a non-interactive message", async () => {
    const result = await handlePendingActionReply(1, { kind: "text", from: "44700", text: "hi", messageId: "m1" });
    expect(result).toBe(false);
    expect(consumePendingAction).not.toHaveBeenCalled();
  });

  it("returns false when the buttonId isn't a pa: id (e.g. a post-connect-setup button)", async () => {
    const result = await handlePendingActionReply(1, {
      kind: "interactive",
      from: "44700",
      messageId: "m2",
      buttonId: "briefing_yes",
    });
    expect(result).toBe(false);
    expect(consumePendingAction).not.toHaveBeenCalled();
  });

  it("sends the expired message when consumePendingAction returns null", async () => {
    vi.mocked(consumePendingAction).mockReturnValue(null);

    const result = await handlePendingActionReply(1, {
      kind: "interactive",
      from: "44700",
      messageId: "m3",
      buttonId: "pa:abc-123:yes",
    });

    expect(result).toBe(true);
    expect(sendWhatsAppMessage).toHaveBeenCalledWith("44700", "That option has expired — just ask me again.");
  });

  it("confirm + yes: runs the stored tool and sends a description of the result", async () => {
    vi.mocked(consumePendingAction).mockReturnValue({
      id: "abc-123",
      ownerId: 1,
      mode: "confirm",
      question: "Archive 3 emails from Nike?",
      contextJson: JSON.stringify({ tool: "archive_messages", input: { account_id: 1, query: "from:nike" } }),
    });
    vi.mocked(runTool).mockResolvedValue({ archived: 3 });

    const result = await handlePendingActionReply(1, {
      kind: "interactive",
      from: "44700",
      messageId: "m4",
      buttonId: "pa:abc-123:yes",
    });

    expect(result).toBe(true);
    expect(runTool).toHaveBeenCalledWith(1, "archive_messages", { account_id: 1, query: "from:nike" });
    expect(sendWhatsAppMessage).toHaveBeenCalledWith("44700", "✓ Archived 3 messages.");
  });

  it("confirm + no: cancels without calling runTool", async () => {
    vi.mocked(consumePendingAction).mockReturnValue({
      id: "abc-123",
      ownerId: 1,
      mode: "confirm",
      question: "Archive 3 emails from Nike?",
      contextJson: JSON.stringify({ tool: "archive_messages", input: {} }),
    });

    const result = await handlePendingActionReply(1, {
      kind: "interactive",
      from: "44700",
      messageId: "m5",
      buttonId: "pa:abc-123:no",
    });

    expect(result).toBe(true);
    expect(runTool).not.toHaveBeenCalled();
    expect(sendWhatsAppMessage).toHaveBeenCalledWith("44700", "Cancelled.");
  });

  it("resume: injects a synthetic user message and forwards runAssistantChat's reply", async () => {
    vi.mocked(consumePendingAction).mockReturnValue({
      id: "abc-123",
      ownerId: 1,
      mode: "resume",
      question: "Which Sarah did you mean?",
      contextJson: JSON.stringify({ options: ["Sarah Chen <sarah.chen@acme.com>", "Sarah Lee <sarah.lee@acme.com>"] }),
    });
    vi.mocked(runAssistantChat).mockResolvedValue({ text: "Drafted an email to Sarah Chen." });

    const result = await handlePendingActionReply(1, {
      kind: "interactive",
      from: "44700",
      messageId: "m6",
      buttonId: "pa:abc-123:0",
    });

    expect(result).toBe(true);
    expect(appendWhatsAppMessage).toHaveBeenCalledWith(
      1,
      "44700",
      "user",
      "(User selected: Sarah Chen <sarah.chen@acme.com>)"
    );
    expect(runAssistantChat).toHaveBeenCalledWith(1, expect.anything(), "44700");
    expect(sendAssistantReply).toHaveBeenCalledWith(1, "44700", { text: "Drafted an email to Sarah Chen." });
  });
});
