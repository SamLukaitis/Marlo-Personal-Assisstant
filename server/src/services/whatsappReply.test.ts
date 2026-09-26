import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/store.js", () => ({
  appendWhatsAppMessage: vi.fn(),
}));
vi.mock("../providers/whatsapp.js", () => ({
  sendWhatsAppMessage: vi.fn().mockResolvedValue(undefined),
  sendChoiceMessage: vi.fn().mockResolvedValue(undefined),
  sendWhatsAppReaction: vi.fn().mockResolvedValue(undefined),
  sendWhatsAppLocationRequest: vi.fn().mockResolvedValue("wamid.loc"),
}));
vi.mock("./sleep.js", () => ({ sleep: vi.fn().mockResolvedValue(undefined) }));

const { appendWhatsAppMessage } = await import("../db/store.js");
const { sendWhatsAppMessage, sendChoiceMessage, sendWhatsAppReaction, sendWhatsAppLocationRequest } = await import("../providers/whatsapp.js");
const { sleep } = await import("./sleep.js");
const { sendAssistantReply } = await import("./whatsappReply.js");

beforeEach(() => {
  vi.mocked(appendWhatsAppMessage).mockClear();
  vi.mocked(sendWhatsAppMessage).mockClear();
  vi.mocked(sendChoiceMessage).mockClear();
  vi.mocked(sendWhatsAppReaction).mockClear();
  vi.mocked(sleep).mockClear();
  vi.mocked(sendWhatsAppLocationRequest).mockClear();
});

describe("sendAssistantReply", () => {
  it("sends plain text and persists it when there's no choice", async () => {
    await sendAssistantReply(1, "44700", { text: "Sure, done." }, "wamid.in");

    expect(appendWhatsAppMessage).toHaveBeenCalledWith(1, "44700", "assistant", "Sure, done.");
    expect(sendWhatsAppMessage).toHaveBeenCalledWith("44700", "Sure, done.");
    expect(sendChoiceMessage).not.toHaveBeenCalled();
  });

  it("renders a choice as pa:-prefixed ids instead of plain text", async () => {
    await sendAssistantReply(1, "44700", {
      text: "Archive 3 emails from Nike? Reply yes or no.",
      choice: {
        actionId: "abc-123",
        question: "Archive 3 emails from Nike?",
        mode: "confirm",
        buttons: [
          { key: "yes", label: "Yes" },
          { key: "no", label: "No" },
        ],
      },
    }, "wamid.in");

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(sendChoiceMessage).toHaveBeenCalledWith("44700", "Archive 3 emails from Nike?", [
      { id: "pa:abc-123:yes", title: "Yes" },
      { id: "pa:abc-123:no", title: "No" },
    ]);
    // The full fallback text (not just the bare question) is still what's persisted to history.
    expect(appendWhatsAppMessage).toHaveBeenCalledWith(
      1,
      "44700",
      "assistant",
      "Archive 3 emails from Nike? Reply yes or no."
    );
  });

  it("splits a multi-paragraph reply into separate sends, pausing between them, but persists it as one history row", async () => {
    const text = "First paragraph.\n\nSecond paragraph.";

    await sendAssistantReply(1, "44700", { text }, "wamid.in");

    expect(appendWhatsAppMessage).toHaveBeenCalledTimes(1);
    expect(appendWhatsAppMessage).toHaveBeenCalledWith(1, "44700", "assistant", text);
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(2);
    expect(sendWhatsAppMessage).toHaveBeenNthCalledWith(1, "44700", "First paragraph.");
    expect(sendWhatsAppMessage).toHaveBeenNthCalledWith(2, "44700", "Second paragraph.");
    // No pause before the first chunk, one pause before the second.
    expect(sleep).toHaveBeenCalledTimes(1);

    // The pause must actually happen between the two sends, not just get called at some point —
    // otherwise mocking it out would hide a bug where both sends fire before the delay resolves.
    const sleepOrder = vi.mocked(sleep).mock.invocationCallOrder[0];
    const secondSendOrder = vi.mocked(sendWhatsAppMessage).mock.invocationCallOrder[1];
    expect(sleepOrder).toBeLessThan(secondSendOrder);
  });

  it("does not pause or split a single-paragraph reply", async () => {
    await sendAssistantReply(1, "44700", { text: "Sure, done." }, "wamid.in");

    expect(sleep).not.toHaveBeenCalled();
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
  });

  it("persists the sent wamid so the reply can later be resolved as a quote target", async () => {
    vi.mocked(sendWhatsAppMessage).mockResolvedValueOnce("wamid.out1");

    await sendAssistantReply(1, "44700", { text: "Sure, done." }, "wamid.in");

    expect(appendWhatsAppMessage).toHaveBeenCalledWith(1, "44700", "assistant", "Sure, done.", ["wamid.out1"]);
  });

  it("persists one wamid per chunk, in order, for a multi-paragraph reply", async () => {
    vi.mocked(sendWhatsAppMessage).mockResolvedValueOnce("wamid.chunk1").mockResolvedValueOnce("wamid.chunk2");
    const text = "First paragraph.\n\nSecond paragraph.";

    await sendAssistantReply(1, "44700", { text }, "wamid.in");

    expect(appendWhatsAppMessage).toHaveBeenCalledWith(1, "44700", "assistant", text, ["wamid.chunk1", "wamid.chunk2"]);
  });

  it("sends a reaction targeting the inbound message instead of text, and persists a readable history line", async () => {
    await sendAssistantReply(1, "44700", { text: "", reaction: { emoji: "👍" } }, "wamid.in");

    expect(sendWhatsAppReaction).toHaveBeenCalledWith("44700", "wamid.in", "👍");
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(sendChoiceMessage).not.toHaveBeenCalled();
    expect(appendWhatsAppMessage).toHaveBeenCalledWith(1, "44700", "assistant", "[reacted 👍]");
  });

  it("sends a location request with the Send location button and persists the prompt with its wamid", async () => {
    await sendAssistantReply(1, "44700", { text: "Tap below to share where you are.", locationRequest: true }, "wamid.in");

    expect(sendWhatsAppLocationRequest).toHaveBeenCalledWith("44700", "Tap below to share where you are.");
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(appendWhatsAppMessage).toHaveBeenCalledWith(1, "44700", "assistant", "Tap below to share where you are.", ["wamid.loc"]);
  });
});
