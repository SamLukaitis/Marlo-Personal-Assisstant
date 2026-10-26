import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../providers/whatsapp.js", () => ({
  sendWhatsAppMessage: vi.fn().mockResolvedValue(undefined),
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
  cancelUntilReplyRemindersForOwner: vi.fn(),
  getWhatsAppHistory: vi.fn().mockReturnValue([]),
  appendWhatsAppMessage: vi.fn(),
  getDocumentByWamid: vi.fn(),
  getWhatsAppMessageByWamid: vi.fn(),
  getSentDocumentByWamid: vi.fn(),
  getRecentWhatsAppMessagesForOwner: vi.fn().mockReturnValue([]),
  // Needed by services/userTimezone.js, which a location message runs for real (via
  // chatDispatch.js's handleLocation, not mocked here) to resolve/store a timezone deterministically.
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  getEnabledTools: vi.fn().mockReturnValue(new Set()),
  listCheckins: vi.fn().mockReturnValue([]),
  recordFeatureMessage: vi.fn(),
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
    // Resolves by default, same reasoning as sendWhatsAppTypingIndicator above — handleIncoming
    // calls .catch() on the returned promise, which throws on a bare vi.fn()'s undefined return.
    handlePendingRegistration: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock("../services/postConnectSetup.js", () => ({
  handleNameReply: vi.fn().mockResolvedValue(false),
  handleFirstTaskReply: vi.fn().mockResolvedValue(false),
  handleBusinessReply: vi.fn().mockResolvedValue(false),
  handleFirstReceiptReply: vi.fn().mockResolvedValue(false),
  firstReceiptFollowUp: vi.fn().mockReturnValue(undefined),
  handlePostConnectSetupReply: vi.fn().mockResolvedValue(false),
}));
vi.mock("../services/whatsappReply.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/whatsappReply.js")>()),
  sendAssistantReply: vi.fn(),
}));
vi.mock("../services/actionHandlers.js", () => ({
  handlePendingActionReply: vi.fn().mockResolvedValue(false),
}));
vi.mock("../services/conversationSummary.js", () => ({
  maybeUpdateConversationSummary: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/memoryExtraction.js", () => ({
  maybeExtractMemory: vi.fn().mockResolvedValue(undefined),
}));
// messageBatching.js is deliberately NOT mocked — chatDispatch.ts/whatsappRoutes.ts now queue
// through its real debounce logic (against the mocked db/store.js, ai/assistant.js, and
// whatsappReply.js above), so every test that expects an assistant call needs to advance fake
// timers past the delay before asserting. See flushBatch() below.

const { sendWhatsAppMessage } = await import("../providers/whatsapp.js");
const { resolveOwnerByPhone, appendWhatsAppMessage, getDocumentByWamid, getWhatsAppMessageByWamid, recordFeatureMessage } =
  await import("../db/store.js");
const { runAssistantChat } = await import("../ai/assistant.js");
const {
  handleNameReply,
  handleFirstTaskReply,
  handleBusinessReply,
  handleFirstReceiptReply,
  firstReceiptFollowUp,
  handlePostConnectSetupReply,
} = await import("../services/postConnectSetup.js");
const { ingestWhatsAppMedia } = await import("../services/documents.js");
const { sendAssistantReply } = await import("../services/whatsappReply.js");
const { handlePendingActionReply } = await import("../services/actionHandlers.js");
const { handlePendingRegistration } = await import("../services/whatsappRegistration.js");
const { maybeUpdateConversationSummary } = await import("../services/conversationSummary.js");
const { LONG_DEBOUNCE_MS } = await import("../services/messageBatching.js");
const { handleIncoming } = await import("./whatsappRoutes.js");

// Advances fake timers past the longest possible debounce delay, letting a message queued via
// the real messageBatching.js actually flush — safe to call even when nothing was queued.
async function flushBatch(): Promise<void> {
  await vi.advanceTimersByTimeAsync(LONG_DEBOUNCE_MS);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(sendWhatsAppMessage).mockClear();
  vi.mocked(runAssistantChat).mockClear();
  vi.mocked(resolveOwnerByPhone).mockReturnValue(42);
  vi.mocked(appendWhatsAppMessage).mockClear();
  vi.mocked(handleNameReply).mockReset().mockResolvedValue(false);
  vi.mocked(handleFirstTaskReply).mockReset().mockResolvedValue(false);
  vi.mocked(handleBusinessReply).mockReset().mockResolvedValue(false);
  vi.mocked(handleFirstReceiptReply).mockReset().mockResolvedValue(false);
  vi.mocked(firstReceiptFollowUp).mockReset().mockReturnValue(undefined);
  vi.mocked(handlePostConnectSetupReply).mockReset().mockResolvedValue(false);
  vi.mocked(sendAssistantReply).mockClear();
  vi.mocked(handlePendingActionReply).mockReset().mockResolvedValue(false);
  vi.mocked(maybeUpdateConversationSummary).mockClear().mockResolvedValue(undefined);
  vi.mocked(getDocumentByWamid).mockReset();
  vi.mocked(getWhatsAppMessageByWamid).mockReset();
  vi.mocked(handlePendingRegistration).mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("handleIncoming — help trigger for already-registered users", () => {
  it("replies with the overview and never calls the assistant", async () => {
    await handleIncoming({ kind: "text", from: "447900000000", text: "help", messageId: "m1" });

    expect(runAssistantChat).not.toHaveBeenCalled();
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendWhatsAppMessage).mock.calls[0][0]).toBe("447900000000");
  });

  // Regression: an already-registered user asking "help" used to get the brand-new-number
  // welcome message verbatim, ending in "What should I call you?" — the registration question,
  // asked again of someone long past registration. See whatsappRegistration.ts's
  // MARLOWE_HELP_TEXT (post-registration) vs. MARLOWE_FIRST_CONTACT_TEXT (pre-registration).
  it("asks what the user needs, not their name — that's only the pre-registration greeting", async () => {
    await handleIncoming({ kind: "text", from: "447900000013", text: "help", messageId: "m13" });

    const text = vi.mocked(sendWhatsAppMessage).mock.calls[0][1];
    expect(text).not.toContain("What should I call you?");
    expect(text).not.toContain("Welcome to the Marlo testing beta");
    expect(text).toContain("tell me what you need");
    // The capabilities live on the features page now, not in a hand-kept list.
    expect(text).toMatch(/https?:\/\/\S+\/features/);
  });

  it("still routes an ordinary message to the real assistant", async () => {
    vi.mocked(runAssistantChat).mockResolvedValue({ text: "a real reply" });

    await handleIncoming({ kind: "text", from: "447900000001", text: "what's on my calendar today?", messageId: "m2" });
    await flushBatch();

    expect(runAssistantChat).toHaveBeenCalledTimes(1);
  });
});

// The fork this whole file otherwise never exercises: every other test hard-mocks
// resolveOwnerByPhone to 42, so the null branch — an unresolved number falling into
// handlePendingRegistration instead of the assistant — had no coverage anywhere in the suite.
// That fork is exactly where the "tap No, then get deflected back to the email question" bug
// lived: it's the resolveOwnerByPhone result, not anything inside handlePendingRegistration
// itself, that whatsappRegistration.test.ts can't observe from outside this module.
describe("handleIncoming — routing on resolveOwnerByPhone's null vs. resolved fork", () => {
  it("sends an unresolved number into registration, never the assistant", async () => {
    vi.mocked(resolveOwnerByPhone).mockReturnValue(null);

    await handleIncoming({ kind: "text", from: "447900055555", text: "hi", messageId: "m1" });

    expect(handlePendingRegistration).toHaveBeenCalledTimes(1);
    expect(runAssistantChat).not.toHaveBeenCalled();
  });

  // The regression case: once an account exists (Task 4's fix to the No branch),
  // resolveOwnerByPhone resolves it and the very next message — e.g. "remind me to call mum at
  // 6" — must reach the assistant instead of being routed back into registration.
  it("sends a resolved number's message to the assistant, never back into registration", async () => {
    vi.mocked(resolveOwnerByPhone).mockReturnValue(42);
    vi.mocked(runAssistantChat).mockResolvedValue({ text: "a real reply" });

    await handleIncoming({
      kind: "text",
      from: "447900000001",
      text: "remind me to call mum at 6",
      messageId: "m2",
    });
    await flushBatch();

    expect(handlePendingRegistration).not.toHaveBeenCalled();
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
  it("short-circuits entirely when handleNameReply consumes the message", async () => {
    vi.mocked(handleNameReply).mockResolvedValue(true);

    await handleIncoming({ kind: "text", from: "447900000014", text: "Sam", messageId: "m14" });

    expect(handleNameReply).toHaveBeenCalledWith(42, expect.objectContaining({ text: "Sam" }));
    expect(runAssistantChat).not.toHaveBeenCalled();
  });

  it("short-circuits entirely when handleFirstTaskReply consumes the message", async () => {
    vi.mocked(handleFirstTaskReply).mockResolvedValue(true);

    await handleIncoming({ kind: "text", from: "447900000012", text: "skip", messageId: "m12" });

    expect(handleFirstTaskReply).toHaveBeenCalledWith(42, expect.objectContaining({ text: "skip" }));
    expect(runAssistantChat).not.toHaveBeenCalled();
  });

});

describe("handleIncoming — business onboarding steps", () => {
  it("a reply to the business question is consumed by handleBusinessReply", async () => {
    vi.mocked(handleBusinessReply).mockResolvedValue(true);
    await handleIncoming({ kind: "text", from: "447900000020", text: "Plumber in Leeds", messageId: "m20" });
    expect(handleBusinessReply).toHaveBeenCalledWith(42, expect.objectContaining({ text: "Plumber in Leeds" }));
    expect(runAssistantChat).not.toHaveBeenCalled();
  });

  it("a typed reply to the receipt invitation is consumed by handleFirstReceiptReply", async () => {
    vi.mocked(handleFirstReceiptReply).mockResolvedValue(true);
    await handleIncoming({ kind: "text", from: "447900000021", text: "skip", messageId: "m21" });
    expect(handleFirstReceiptReply).toHaveBeenCalledWith(42, expect.objectContaining({ text: "skip" }));
    expect(runAssistantChat).not.toHaveBeenCalled();
  });

  it("a receipt photo during setup is filed, confirmed by the assistant, then the chain moves on", async () => {
    const followUp = vi.fn().mockResolvedValue(undefined);
    vi.mocked(firstReceiptFollowUp).mockReturnValue(followUp);
    vi.mocked(ingestWhatsAppMedia).mockResolvedValue({ extractedText: "Screwfix £48.20" } as never);
    vi.mocked(runAssistantChat).mockResolvedValue({ text: "Added Screwfix £48.20 to your books." });

    await handleIncoming({ kind: "media", from: "447900000022", mediaId: "media-1", mimeType: "image/jpeg", messageId: "m22" });
    expect(followUp).not.toHaveBeenCalled(); // not before the assistant has replied
    await flushBatch();

    expect(runAssistantChat).toHaveBeenCalledTimes(1);
    expect(followUp).toHaveBeenCalledTimes(1);
  });

  it("a photo outside that step has no follow-up", async () => {
    vi.mocked(ingestWhatsAppMedia).mockResolvedValue({ extractedText: "x" } as never);
    vi.mocked(runAssistantChat).mockResolvedValue({ text: "Saved." });
    await handleIncoming({ kind: "media", from: "447900000023", mediaId: "media-2", mimeType: "image/jpeg", messageId: "m23" });
    await flushBatch();
    expect(firstReceiptFollowUp).toHaveBeenCalledWith(42, "447900000023");
    expect(runAssistantChat).toHaveBeenCalledTimes(1);
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
    // Counted for the Portal's Feature use tab, so we can see what people try to send.
    expect(recordFeatureMessage).toHaveBeenCalledWith(expect.anything(), "whatsapp", new Map([["unsupported:sticker", 1]]));
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
    await flushBatch();

    expect(vi.mocked(appendWhatsAppMessage).mock.calls[0]).toEqual([
      42,
      "447900000020",
      "user",
      expect.stringMatching(/^\[User shared their location at \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC: 51\.5074, -0\.1278 \(Big Ben, London SW1A 0AA\)\]$/),
      ["m20"],
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
      expect.stringMatching(/^\[User shared their location at \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC: 51\.5, -0\.1\]$/),
      ["m21"],
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
    await flushBatch();

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
    await flushBatch();

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

describe("handleIncoming — swipe-to-reply and forwarded messages", () => {
  it("resolves a quoted photo/document to its real extracted content, not the raw placeholder", async () => {
    vi.mocked(runAssistantChat).mockResolvedValue({ text: "That's your BA123 boarding pass." });
    vi.mocked(getDocumentByWamid).mockReturnValue({
      id: 1,
      title: "Boarding pass",
      filename: "bp.jpg",
      extractedText: "Flight BA123, seat 14C, gate 22",
    } as never);

    await handleIncoming({
      kind: "text",
      from: "447900000020",
      text: "what's this",
      messageId: "m20",
      quotedMessageId: "wamid.old-photo",
    });
    await flushBatch();

    expect(getDocumentByWamid).toHaveBeenCalledWith(42, "wamid.old-photo");
    const history = vi.mocked(runAssistantChat).mock.calls.at(-1)?.[1] as Array<{ content: string }>;
    expect(history.at(-1)?.content).toContain("Flight BA123, seat 14C, gate 22");
  });

  it("resolves a quoted plain-text message when it isn't a saved document", async () => {
    vi.mocked(runAssistantChat).mockResolvedValue({ text: "6pm, at the airport hotel." });
    vi.mocked(getDocumentByWamid).mockReturnValue(undefined);
    vi.mocked(getWhatsAppMessageByWamid).mockReturnValue({
      id: 2,
      phone: "447900000021",
      role: "assistant",
      content: "Your flight is at 6pm.",
      createdAt: Date.now(),
    } as never);

    await handleIncoming({
      kind: "text",
      from: "447900000021",
      text: "what time was that again",
      messageId: "m21",
      quotedMessageId: "wamid.old-text",
    });
    await flushBatch();

    const history = vi.mocked(runAssistantChat).mock.calls.at(-1)?.[1] as Array<{ content: string }>;
    expect(history.at(-1)?.content).toContain("Your flight is at 6pm.");
  });

  it("tells the model plainly it can't see an untracked quote, instead of staying silent about it", async () => {
    vi.mocked(runAssistantChat).mockResolvedValue({ text: "..." });
    vi.mocked(getDocumentByWamid).mockReturnValue(undefined);
    vi.mocked(getWhatsAppMessageByWamid).mockReturnValue(undefined);

    await handleIncoming({
      kind: "text",
      from: "447900000022",
      text: "what's this",
      messageId: "m22",
      quotedMessageId: "wamid.never-recorded",
    });
    await flushBatch();

    const history = vi.mocked(runAssistantChat).mock.calls.at(-1)?.[1] as Array<{ content: string }>;
    expect(history.at(-1)?.content).toMatch(/can't see|can't retrieve/i);
  });

  it("does not alter history when the message has no quote and wasn't forwarded", async () => {
    vi.mocked(runAssistantChat).mockResolvedValue({ text: "Sure." });

    await handleIncoming({ kind: "text", from: "447900000023", text: "ordinary message", messageId: "m23" });
    await flushBatch();

    expect(getDocumentByWamid).not.toHaveBeenCalled();
    expect(getWhatsAppMessageByWamid).not.toHaveBeenCalled();
    // getWhatsAppHistory is mocked to always return [] regardless of appendWhatsAppMessage calls —
    // with no quote to inject, nothing should have been pushed onto it either.
    const history = vi.mocked(runAssistantChat).mock.calls.at(-1)?.[1];
    expect(history).toEqual([]);
  });
});
