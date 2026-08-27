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
  handlePostConnectSetupReply: vi.fn().mockResolvedValue(false),
}));
vi.mock("../services/whatsappReply.js", () => ({
  sendAssistantReply: vi.fn(),
}));
vi.mock("../services/actionHandlers.js", () => ({
  handlePendingActionReply: vi.fn().mockResolvedValue(false),
}));

const { sendWhatsAppMessage } = await import("../providers/whatsapp.js");
const { resolveOwnerByPhone } = await import("../db/store.js");
const { runAssistantChat } = await import("../ai/assistant.js");
const { handlePostConnectSetupReply } = await import("../services/postConnectSetup.js");
const { sendAssistantReply } = await import("../services/whatsappReply.js");
const { handlePendingActionReply } = await import("../services/actionHandlers.js");
const { handleIncoming } = await import("./whatsappRoutes.js");

beforeEach(() => {
  vi.mocked(sendWhatsAppMessage).mockClear();
  vi.mocked(runAssistantChat).mockClear();
  vi.mocked(resolveOwnerByPhone).mockReturnValue(42);
  vi.mocked(handlePostConnectSetupReply).mockReset().mockResolvedValue(false);
  vi.mocked(sendAssistantReply).mockClear();
  vi.mocked(handlePendingActionReply).mockReset().mockResolvedValue(false);
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

describe("handleIncoming — routes runAssistantChat's result through sendAssistantReply", () => {
  it("passes the full AssistantReply through, not just .text", async () => {
    vi.mocked(runAssistantChat).mockResolvedValue({ text: "a real reply" });

    await handleIncoming({ kind: "text", from: "447900000005", text: "what's on my calendar today?", messageId: "m6" });

    expect(sendAssistantReply).toHaveBeenCalledWith(42, "447900000005", { text: "a real reply" });
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
