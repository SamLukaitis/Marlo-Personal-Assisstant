import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/store.js", () => ({
  consumePendingAction: vi.fn(),
  createPendingAction: vi.fn().mockReturnValue("new-456"),
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
  sendChoiceMessage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./hub.js", () => ({
  hubHasSentTo: vi.fn(),
}));
vi.mock("./whatsappReply.js", () => ({
  sendAssistantReply: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./connectMailboxLink.js", () => ({
  sendConnectLink: vi.fn().mockResolvedValue("sent"),
}));

const { consumePendingAction, createPendingAction, appendWhatsAppMessage, getWhatsAppHistory } = await import(
  "../db/store.js"
);
const { hubHasSentTo } = await import("./hub.js");
const { runTool, runAssistantChat } = await import("../ai/assistant.js");
const { sendWhatsAppMessage, sendChoiceMessage } = await import("../providers/whatsapp.js");
const { sendAssistantReply } = await import("./whatsappReply.js");
const { sendConnectLink } = await import("./connectMailboxLink.js");
const { handlePendingActionReply } = await import("./actionHandlers.js");

beforeEach(() => {
  vi.mocked(consumePendingAction).mockReset();
  vi.mocked(appendWhatsAppMessage).mockClear();
  vi.mocked(getWhatsAppHistory).mockReset().mockReturnValue([]);
  vi.mocked(runTool).mockReset();
  vi.mocked(runAssistantChat).mockReset();
  vi.mocked(sendWhatsAppMessage).mockClear();
  vi.mocked(sendAssistantReply).mockClear();
  vi.mocked(sendChoiceMessage).mockClear();
  vi.mocked(createPendingAction).mockClear();
  vi.mocked(hubHasSentTo).mockReset().mockResolvedValue(true);
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
    expect(runTool).toHaveBeenCalledWith(1, "archive_messages", { account_id: 1, query: "from:nike" }, "44700");
    expect(sendWhatsAppMessage).toHaveBeenCalledWith("44700", "✓ Archived 3 messages.");
  });

  it.each([
    [
      { status: "unsubscribed", method: "one_click", sender: "Nike <news@nike.com>" },
      "✓ Unsubscribed from Nike <news@nike.com>. It can take a few days for the emails to stop.",
    ],
    [
      { status: "manual_link", url: "https://nike.com/u/1", sender: "Nike" },
      "I couldn't unsubscribe from Nike automatically — tap this link to finish: https://nike.com/u/1",
    ],
    [{ status: "unavailable", reason: "No unsubscribe option." }, "No unsubscribe option."],
  ])("confirm + yes: unsubscribe_from_sender reports %j", async (toolResult, expectedReply) => {
    vi.mocked(consumePendingAction).mockReturnValue({
      id: "abc-123",
      ownerId: 1,
      mode: "confirm",
      question: "Unsubscribe from Nike?",
      contextJson: JSON.stringify({ tool: "unsubscribe_from_sender", input: { account_id: 1, message_id: "m9" } }),
    });
    vi.mocked(runTool).mockResolvedValue(toolResult);

    await handlePendingActionReply(1, {
      kind: "interactive",
      from: "44700",
      messageId: "m4",
      buttonId: "pa:abc-123:yes",
    });

    expect(runTool).toHaveBeenCalledWith(1, "unsubscribe_from_sender", { account_id: 1, message_id: "m9" }, "44700");
    expect(sendWhatsAppMessage).toHaveBeenCalledWith("44700", expectedReply);
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

  it("confirm + no with a decline_tool: runs the decline tool instead of just cancelling", async () => {
    vi.mocked(consumePendingAction).mockReturnValue({
      id: "abc-123",
      ownerId: 1,
      mode: "confirm",
      question: "Ready to send this?",
      contextJson: JSON.stringify({
        tool: "send_email",
        input: { account_id: 1, to: "jane@x.com", subject: "Hi", body: "..." },
        declineTool: "create_email_draft",
        declineInput: { account_id: 1, to: "jane@x.com", subject: "Hi", body: "..." },
      }),
    });
    vi.mocked(runTool).mockResolvedValue({ draftId: "d1" });

    const result = await handlePendingActionReply(1, {
      kind: "interactive",
      from: "44700",
      messageId: "m7",
      buttonId: "pa:abc-123:no",
    });

    expect(result).toBe(true);
    expect(runTool).toHaveBeenCalledWith(
      1,
      "create_email_draft",
      { account_id: 1, to: "jane@x.com", subject: "Hi", body: "..." },
      "44700"
    );
    expect(sendWhatsAppMessage).toHaveBeenCalledWith("44700", "📝 Saved as a draft — nothing was sent.");
  });

  it("confirm + yes: runs send_email and reports it sent", async () => {
    vi.mocked(consumePendingAction).mockReturnValue({
      id: "abc-123",
      ownerId: 1,
      mode: "confirm",
      question: "Ready to send this?",
      contextJson: JSON.stringify({
        tool: "send_email",
        input: { account_id: 1, to: "jane@x.com", subject: "Hi", body: "..." },
        declineTool: "create_email_draft",
        declineInput: {},
      }),
    });
    vi.mocked(runTool).mockResolvedValue({ messageId: "m1" });

    const result = await handlePendingActionReply(1, {
      kind: "interactive",
      from: "44700",
      messageId: "m8",
      buttonId: "pa:abc-123:yes",
    });

    expect(result).toBe(true);
    expect(runTool).toHaveBeenCalledWith(
      1,
      "send_email",
      { account_id: 1, to: "jane@x.com", subject: "Hi", body: "..." },
      "44700"
    );
    expect(sendWhatsAppMessage).toHaveBeenCalledWith("44700", "✓ Sent.");
  });

  describe("send_email to someone never emailed before", () => {
    const input = { account_id: 1, to: "jane@x.com", subject: "Hi", body: "..." };
    function pendingSend(extra: Record<string, unknown> = {}) {
      vi.mocked(consumePendingAction).mockReturnValue({
        id: "abc-123",
        ownerId: 1,
        mode: "confirm",
        question: "Ready to send this?",
        contextJson: JSON.stringify({
          tool: "send_email",
          input,
          declineTool: "create_email_draft",
          declineInput: input,
          ...extra,
        }),
      });
    }
    const sendTap = { kind: "interactive" as const, from: "44700", messageId: "m10", buttonId: "pa:abc-123:yes" };

    it("warns with the address instead of sending, and stores a second confirm that skips the check", async () => {
      pendingSend();
      vi.mocked(hubHasSentTo).mockResolvedValue(false);

      const result = await handlePendingActionReply(1, sendTap);

      expect(result).toBe(true);
      expect(hubHasSentTo).toHaveBeenCalledWith(1, 1, "jane@x.com");
      expect(runTool).not.toHaveBeenCalled();
      const warning =
        "⚠️ Warning — you haven't emailed this person before. Are you sure jane@x.com is the correct email?";
      expect(sendChoiceMessage).toHaveBeenCalledWith("44700", warning, [
        { id: "pa:new-456:yes", title: "Yes, send" },
        { id: "pa:new-456:no", title: "No, keep as draft" },
      ]);
      expect(appendWhatsAppMessage).toHaveBeenCalledWith(1, "44700", "assistant", warning);
      const [, mode, , contextJson] = vi.mocked(createPendingAction).mock.calls[0];
      expect(mode).toBe("confirm");
      expect(JSON.parse(contextJson)).toMatchObject({
        tool: "send_email",
        input,
        declineTool: "create_email_draft",
        recipientChecked: true,
      });
    });

    it("sends on the Yes tap of the warning without checking again", async () => {
      pendingSend({ recipientChecked: true });
      vi.mocked(runTool).mockResolvedValue({ messageId: "m1" });

      await handlePendingActionReply(1, sendTap);

      expect(hubHasSentTo).not.toHaveBeenCalled();
      expect(runTool).toHaveBeenCalledWith(1, "send_email", input, "44700");
      expect(sendWhatsAppMessage).toHaveBeenCalledWith("44700", "✓ Sent.");
    });

    it("warns when the Sent folder can't be checked", async () => {
      pendingSend();
      vi.mocked(hubHasSentTo).mockRejectedValue(new Error("Gmail quota"));
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await handlePendingActionReply(1, sendTap);

      expect(runTool).not.toHaveBeenCalled();
      expect(sendChoiceMessage).toHaveBeenCalledTimes(1);
      errorSpy.mockRestore();
    });

    it("sends straight away when the address is in the Sent folder", async () => {
      pendingSend();
      vi.mocked(runTool).mockResolvedValue({ messageId: "m1" });

      await handlePendingActionReply(1, sendTap);

      expect(sendChoiceMessage).not.toHaveBeenCalled();
      expect(runTool).toHaveBeenCalledWith(1, "send_email", input, "44700");
    });
  });

  it("confirm + yes on an Outlook account without send permission: saves a draft and sends the reconnect link", async () => {
    const input = { account_id: 2, to: "jane@x.com", subject: "Hi", body: "..." };
    vi.mocked(consumePendingAction).mockReturnValue({
      id: "abc-123",
      ownerId: 1,
      mode: "confirm",
      question: "Ready to send this?",
      contextJson: JSON.stringify({ tool: "send_email", input, declineTool: "create_email_draft", declineInput: input }),
    });
    const permissionError = Object.assign(new Error("needs reconnecting"), {
      name: "OutlookSendPermissionError",
      accountEmail: "me@outlook.com",
    });
    vi.mocked(runTool).mockImplementation(async (_owner, name) => {
      if (name === "send_email") throw permissionError;
      return { draftId: "d1" };
    });

    const result = await handlePendingActionReply(1, {
      kind: "interactive",
      from: "44700",
      messageId: "m9",
      buttonId: "pa:abc-123:yes",
    });

    expect(result).toBe(true);
    expect(runTool).toHaveBeenCalledWith(1, "create_email_draft", input, "44700");
    const [, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(text).toContain("me@outlook.com");
    expect(text).toContain("reconnect");
    expect(text).toContain("Drafts");
    expect(text).not.toContain("server logs");
    expect(appendWhatsAppMessage).toHaveBeenCalledWith(1, "44700", "assistant", text);
    expect(sendConnectLink).toHaveBeenCalledWith("44700", "microsoft", "enable_send");
  });

  it("confirm + edit: routes back through the model instead of running either tool", async () => {
    vi.mocked(consumePendingAction).mockReturnValue({
      id: "abc-123",
      ownerId: 1,
      mode: "confirm",
      question: "Ready to send this?",
      contextJson: JSON.stringify({
        tool: "send_email",
        input: { account_id: 1, to: "jane@x.com", subject: "Hi", body: "..." },
        declineTool: "create_email_draft",
        declineInput: {},
      }),
    });
    vi.mocked(runAssistantChat).mockResolvedValue({ text: "What would you like to change?" });

    const result = await handlePendingActionReply(1, {
      kind: "interactive",
      from: "44700",
      messageId: "m9",
      buttonId: "pa:abc-123:edit",
    });

    expect(result).toBe(true);
    expect(runTool).not.toHaveBeenCalled();
    expect(appendWhatsAppMessage).toHaveBeenCalledWith(
      1,
      "44700",
      "user",
      "(User wants to edit this before continuing.)"
    );
    expect(runAssistantChat).toHaveBeenCalledWith(1, expect.anything(), "44700");
    expect(sendAssistantReply).toHaveBeenCalledWith(
      1,
      "44700",
      { text: "What would you like to change?" },
      "m9"
    );
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
    expect(sendAssistantReply).toHaveBeenCalledWith(1, "44700", { text: "Drafted an email to Sarah Chen." }, "m6");
  });
});
