import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../providers/whatsapp.js", () => ({
  sendWhatsAppMessage: vi.fn(),
  // Resolves by default (rather than plain vi.fn(), which returns undefined) — handleIncoming
  // calls .catch() on this fire-and-forget call, which throws on a non-promise return value.
  sendWhatsAppTypingIndicator: vi.fn().mockResolvedValue(undefined),
  isWhatsAppConfigured: vi.fn(),
  isWhatsAppSignatureConfigured: vi.fn(),
  verifyWebhookChallenge: vi.fn(),
  verifyWebhookSignature: vi.fn(),
  extractIncomingMessages: vi.fn(),
}));
vi.mock("../db/store.js", () => ({
  resolveOwnerByPhone: vi.fn(),
  recordInboundMessage: vi.fn(),
  getWhatsAppHistory: vi.fn().mockReturnValue([]),
  appendWhatsAppMessage: vi.fn(),
}));
vi.mock("../ai/assistant.js", () => ({
  runAssistantChat: vi.fn(),
  MAX_HISTORY_MESSAGES: 12,
}));
vi.mock("../services/documents.js", () => ({
  ingestWhatsAppMedia: vi.fn(),
  ingestWhatsAppLink: vi.fn(),
}));
vi.mock("../services/safeLinkFetcher.js", () => ({
  findSaveableUrl: vi.fn().mockReturnValue(null),
}));
vi.mock("../services/whatsappRegistration.js", async () => {
  const actual = await vi.importActual<typeof import("../services/whatsappRegistration.js")>(
    "../services/whatsappRegistration.js"
  );
  return {
    ...actual,
    handlePendingRegistration: vi.fn(),
  };
});
vi.mock("../services/postConnectSetup.js", () => ({
  handleFirstTaskReply: vi.fn().mockResolvedValue(false),
  handlePostConnectSetupReply: vi.fn().mockResolvedValue(false),
  handleBriefingContentReply: vi.fn().mockResolvedValue(false),
}));
vi.mock("../services/whatsappReply.js", () => ({
  sendAssistantReply: vi.fn(),
}));
vi.mock("../services/actionHandlers.js", () => ({
  handlePendingActionReply: vi.fn().mockResolvedValue(false),
}));
vi.mock("../services/conversationSummary.js", () => ({
  maybeUpdateConversationSummary: vi.fn().mockResolvedValue(undefined),
}));

const { sendWhatsAppMessage } = await import("../providers/whatsapp.js");
const { resolveOwnerByPhone, appendWhatsAppMessage } = await import("../db/store.js");
const { runAssistantChat } = await import("../ai/assistant.js");
const { handleFirstTaskReply, handlePostConnectSetupReply, handleBriefingContentReply } = await import(
  "../services/postConnectSetup.js"
);
const { sendAssistantReply } = await import("../services/whatsappReply.js");
const { handlePendingActionReply } = await import("../services/actionHandlers.js");
const { maybeUpdateConversationSummary } = await import("../services/conversationSummary.js");
const { handleIncoming } = await import("./whatsappRoutes.js");

beforeEach(() => {
  vi.mocked(sendWhatsAppMessage).mockClear();
  vi.mocked(runAssistantChat).mockClear();
  vi.mocked(resolveOwnerByPhone).mockReturnValue(42);
  vi.mocked(appendWhatsAppMessage).mockClear();
  vi.mocked(handleFirstTaskReply).mockReset().mockResolvedValue(false);
  vi.mocked(handlePostConnectSetupReply).mockReset().mockResolvedValue(false);
  vi.mocked(handleBriefingContentReply).mockReset().mockResolvedValue(false);
  vi.mocked(sendAssistantReply).mockClear();
  vi.mocked(handlePendingActionReply).mockReset().mockResolvedValue(false);
  vi.mocked(maybeUpdateConversationSummary).mockClear().mockResolvedValue(undefined);
});

describe("handleIncoming — help trigger for already-registered users", () => {
  it("replies with the overview and never calls the assistant", async () => {
    await handleIncoming({ kind: "text", from: "447900000000", text: "help", messageId: "m1" });

    expect(runAssistantChat).not.toHaveBeenCalled();
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendWhatsAppMessage).mock.calls[0][0]).toBe("447900000000");
  });

  it("still routes an ordinary message to the real assistant", async () => {
    vi.mocked(runAssistantChat).mockResolvedValue({ text: "a real reply" });

    await handleIncoming({ kind: "text", from: "447900000001", text: "what's on my calendar today?", messageId: "m2" });

    expect(runAssistantChat).toHaveBeenCalledTimes(1);
  });
});

describe("handleIncoming — version trigger", () => {
  it("replies with build info and never calls the assistant, even if the model layer would be broken", async () => {
    await handleIncoming({ kind: "text", from: "447900000002", text: "version", messageId: "m3" });

    expect(runAssistantChat).not.toHaveBeenCalled();
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendWhatsAppMessage).mock.calls[0][0]).toBe("447900000002");
  });
});

describe("handleIncoming — blocking free-text setup steps", () => {
  it("short-circuits entirely when handleFirstTaskReply consumes the message", async () => {
    vi.mocked(handleFirstTaskReply).mockResolvedValue(true);

    await handleIncoming({ kind: "text", from: "447900000012", text: "skip", messageId: "m12" });

    expect(handleFirstTaskReply).toHaveBeenCalledWith(42, expect.objectContaining({ text: "skip" }));
    expect(runAssistantChat).not.toHaveBeenCalled();
  });

  it("short-circuits entirely when handleBriefingContentReply consumes the message", async () => {
    vi.mocked(handleBriefingContentReply).mockResolvedValue(true);

    await handleIncoming({ kind: "text", from: "447900000013", text: "news please", messageId: "m13" });

    expect(handleBriefingContentReply).toHaveBeenCalledWith(42, expect.objectContaining({ text: "news please" }));
    expect(runAssistantChat).not.toHaveBeenCalled();
  });
});

describe("handleIncoming — post-connect setup button taps", () => {
  it("short-circuits entirely when handlePostConnectSetupReply consumes the message", async () => {
    vi.mocked(handlePostConnectSetupReply).mockResolvedValue(true);

    await handleIncoming({ kind: "interactive", from: "447900000003", buttonId: "briefing_yes", messageId: "m4" });

    expect(handlePostConnectSetupReply).toHaveBeenCalledWith(42, expect.objectContaining({ buttonId: "briefing_yes" }));
    expect(runAssistantChat).not.toHaveBeenCalled();
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it("logs and ignores a stray button tap with nothing pending, instead of routing it to media handling", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleIncoming({ kind: "interactive", from: "447900000004", buttonId: "old_button", messageId: "m5" });

    expect(runAssistantChat).not.toHaveBeenCalled();
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("handleIncoming — unsupported message types", () => {
  it("logs the raw type and replies with a friendly one-liner, without touching the assistant", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await handleIncoming({ kind: "unsupported", from: "447900000009", messageId: "m9", type: "sticker" });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("unsupported"), expect.objectContaining({ type: "sticker" }));
    expect(runAssistantChat).not.toHaveBeenCalled();
    expect(sendWhatsAppMessage).toHaveBeenCalledWith(
      "447900000009",
      "I can't read that message type yet — text me instead."
    );
    logSpy.mockRestore();
  });
});

describe("handleIncoming — location messages", () => {
  it("folds a dropped pin (with name/address) into history and runs it through the assistant", async () => {
    vi.mocked(runAssistantChat).mockResolvedValue({ text: "Here are a few hotels nearby." });

    await handleIncoming({
      kind: "location",
      from: "447900000020",
      messageId: "m20",
      latitude: 51.5074,
      longitude: -0.1278,
      name: "Big Ben",
      address: "London SW1A 0AA",
    });

    expect(vi.mocked(appendWhatsAppMessage).mock.calls[0]).toEqual([
      42,
      "447900000020",
      "user",
      "[User shared their location: 51.5074, -0.1278 (Big Ben, London SW1A 0AA)]",
    ]);
    expect(runAssistantChat).toHaveBeenCalled();
    expect(sendAssistantReply).toHaveBeenCalledWith(
      42,
      "447900000020",
      { text: "Here are a few hotels nearby." },
      "m20"
    );
  });

  it("still works for a raw pin with no name/address", async () => {
    vi.mocked(runAssistantChat).mockResolvedValue({ text: "Got it." });

    await handleIncoming({
      kind: "location",
      from: "447900000021",
      messageId: "m21",
      latitude: 51.5,
      longitude: -0.1,
    });

    expect(vi.mocked(appendWhatsAppMessage).mock.calls[0]).toEqual([
      42,
      "447900000021",
      "user",
      "[User shared their location: 51.5, -0.1]",
    ]);
  });
});

describe("handleIncoming — reactions", () => {
  it("logs a reaction to history but never calls the assistant or sends a reply", async () => {
    await handleIncoming({
      kind: "reaction",
      from: "447900000010",
      messageId: "m10",
      reactedToMessageId: "wamid.original",
      emoji: "👍",
    });

    expect(appendWhatsAppMessage).toHaveBeenCalledWith(42, "447900000010", "user", expect.stringContaining("👍"));
    expect(runAssistantChat).not.toHaveBeenCalled();
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(sendAssistantReply).not.toHaveBeenCalled();
  });

  it("logs a removed reaction (empty emoji) distinctly rather than as a blank", async () => {
    await handleIncoming({
      kind: "reaction",
      from: "447900000011",
      messageId: "m11",
      reactedToMessageId: "wamid.original",
      emoji: "",
    });

    expect(appendWhatsAppMessage).toHaveBeenCalledWith(
      42,
      "447900000011",
      "user",
      expect.stringContaining("removed")
    );
    expect(runAssistantChat).not.toHaveBeenCalled();
  });
});

describe("handleIncoming — routes runAssistantChat's result through sendAssistantReply", () => {
  it("passes the full AssistantReply through, not just .text", async () => {
    vi.mocked(runAssistantChat).mockResolvedValue({ text: "a real reply" });

    await handleIncoming({ kind: "text", from: "447900000005", text: "what's on my calendar today?", messageId: "m6" });

    expect(sendAssistantReply).toHaveBeenCalledWith(42, "447900000005", { text: "a real reply" }, "m6");
  });
});

describe("handleIncoming — rolling conversation summary", () => {
  it("kicks off a summary update for the sender's phone on every text message", async () => {
    vi.mocked(runAssistantChat).mockResolvedValue({ text: "reply" });

    await handleIncoming({ kind: "text", from: "447900000010", text: "what's on my calendar today?", messageId: "m10" });

    expect(maybeUpdateConversationSummary).toHaveBeenCalledWith("447900000010");
  });

  it("passes the sender's phone through to runAssistantChat so it can look up the summary", async () => {
    vi.mocked(runAssistantChat).mockResolvedValue({ text: "reply" });

    await handleIncoming({ kind: "text", from: "447900000011", text: "what's on my calendar today?", messageId: "m11" });

    expect(runAssistantChat).toHaveBeenCalledWith(42, expect.anything(), "447900000011");
  });
});

describe("handleIncoming — pending-action taps", () => {
  it("is handled by handlePendingActionReply and never reaches the assistant", async () => {
    vi.mocked(handlePendingActionReply).mockResolvedValue(true);

    await handleIncoming({ kind: "interactive", from: "447900000006", messageId: "m7", buttonId: "pa:abc:yes" });

    expect(handlePendingActionReply).toHaveBeenCalledWith(42, {
      kind: "interactive",
      from: "447900000006",
      messageId: "m7",
      buttonId: "pa:abc:yes",
    });
    expect(runAssistantChat).not.toHaveBeenCalled();
  });
});
