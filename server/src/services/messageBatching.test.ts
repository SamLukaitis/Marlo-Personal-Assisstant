import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../db/store.js", () => ({
  getWhatsAppHistory: vi.fn().mockReturnValue([]),
  appendWhatsAppMessage: vi.fn(),
  resolveOwnerByPhone: vi.fn().mockReturnValue(null),
}));
vi.mock("../ai/assistant.js", () => ({
  runAssistantChat: vi.fn(),
  MAX_HISTORY_MESSAGES: 12,
}));
vi.mock("./whatsappReply.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./whatsappReply.js")>()),
  sendAssistantReply: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../providers/whatsapp.js", () => ({
  sendWhatsAppMessage: vi.fn().mockResolvedValue(undefined),
  sendWhatsAppTypingIndicator: vi.fn().mockResolvedValue(undefined),
}));

const { getWhatsAppHistory } = await import("../db/store.js");
const { runAssistantChat } = await import("../ai/assistant.js");
const { sendAssistantReply } = await import("./whatsappReply.js");
const { sendWhatsAppMessage, sendWhatsAppTypingIndicator } = await import("../providers/whatsapp.js");
const { queueForAssistant, looksComplete, SHORT_DEBOUNCE_MS, LONG_DEBOUNCE_MS, HOLDING_MESSAGE_MS, HOLDING_MESSAGES } = await import(
  "./messageBatching.js"
);

// Each test uses its own phone number so per-phone batching state never bleeds across tests —
// same isolation trick conversationSummary.test.ts uses for the real DB.
let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter++;
  return `44700000${phoneCounter}`;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(getWhatsAppHistory).mockReset().mockReturnValue([]);
  vi.mocked(runAssistantChat).mockReset().mockResolvedValue({ text: "reply" } as never);
  vi.mocked(sendAssistantReply).mockClear().mockResolvedValue(undefined);
  vi.mocked(sendWhatsAppMessage).mockClear().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("queueForAssistant", () => {
  it("flushes after the short delay for a fast-path (complete-looking) message", async () => {
    const from = nextPhone();
    queueForAssistant(1, from, "wamid1", undefined, null, true);

    await vi.advanceTimersByTimeAsync(SHORT_DEBOUNCE_MS - 1);
    expect(runAssistantChat).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(runAssistantChat).toHaveBeenCalledTimes(1);
    expect(sendAssistantReply).toHaveBeenCalledWith(1, from, { text: "reply" }, "wamid1");
  });

  it("flushes after the long delay for a non-fast-path message", async () => {
    const from = nextPhone();
    queueForAssistant(1, from, "wamid1", undefined, null, false);

    await vi.advanceTimersByTimeAsync(LONG_DEBOUNCE_MS - 1);
    expect(runAssistantChat).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(runAssistantChat).toHaveBeenCalledTimes(1);
  });

  it("slides the timer when a new message arrives before it fires", async () => {
    const from = nextPhone();
    queueForAssistant(1, from, "wamid1", undefined, null, false);

    await vi.advanceTimersByTimeAsync(LONG_DEBOUNCE_MS - 1000);
    queueForAssistant(1, from, "wamid2", undefined, null, false);

    // Original timer would have fired here had it not been reset.
    await vi.advanceTimersByTimeAsync(1000);
    expect(runAssistantChat).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(LONG_DEBOUNCE_MS - 1000);
    expect(runAssistantChat).toHaveBeenCalledTimes(1);
    expect(sendAssistantReply).toHaveBeenCalledWith(1, from, { text: "reply" }, "wamid2");
  });

  it("splices each buffered message's override into its own history position", async () => {
    const from = nextPhone();
    vi.mocked(getWhatsAppHistory).mockReturnValue([
      { id: 1, phone: from, role: "assistant", content: "hi", createdAt: 0 },
      { id: 2, phone: from, role: "user", content: "[Sent doc.pdf]", createdAt: 0 },
      { id: 3, phone: from, role: "user", content: "what does this say", createdAt: 0 },
    ] as never);

    queueForAssistant(1, from, "wamid-media", 2, "ENRICHED DOC TEXT", false);
    queueForAssistant(1, from, "wamid-text", 3, null, true);

    await vi.advanceTimersByTimeAsync(SHORT_DEBOUNCE_MS);

    expect(runAssistantChat).toHaveBeenCalledWith(1, [
      { role: "assistant", content: "hi" },
      { role: "user", content: "ENRICHED DOC TEXT" },
      { role: "user", content: "what does this say" },
    ], from);
  });

  // Regression: overrides used to be matched to "the last N rows" by position. A reply to an
  // earlier message is saved after a message that arrived while that reply was being generated,
  // so the request ended on Marlo's own reply (read as a prefill) instead of the user's message.
  it("puts a batched message after an assistant reply that was saved while it waited", async () => {
    const from = nextPhone();
    vi.mocked(getWhatsAppHistory).mockReturnValue([
      { id: 10, phone: from, role: "user", content: "A", createdAt: 0 },
      { id: 11, phone: from, role: "user", content: "B", createdAt: 0 },
      { id: 12, phone: from, role: "assistant", content: "reply to A", createdAt: 0 },
    ] as never);

    queueForAssistant(1, from, "wamid-b", 11, null, true);
    await vi.advanceTimersByTimeAsync(SHORT_DEBOUNCE_MS);

    expect(runAssistantChat).toHaveBeenCalledWith(1, [
      { role: "user", content: "A" },
      { role: "assistant", content: "reply to A" },
      { role: "user", content: "B" },
    ], from);
  });

  it("swaps an override into its own message's row, never over a later assistant reply", async () => {
    const from = nextPhone();
    vi.mocked(getWhatsAppHistory).mockReturnValue([
      { id: 20, phone: from, role: "user", content: "A", createdAt: 0 },
      { id: 21, phone: from, role: "user", content: "what's this", createdAt: 0 },
      { id: 22, phone: from, role: "assistant", content: "reply to A", createdAt: 0 },
    ] as never);

    queueForAssistant(1, from, "wamid-quote", 21, "[quoted context]\n\nwhat's this", true);
    await vi.advanceTimersByTimeAsync(SHORT_DEBOUNCE_MS);

    expect(runAssistantChat).toHaveBeenCalledWith(1, [
      { role: "user", content: "A" },
      { role: "assistant", content: "reply to A" },
      { role: "user", content: "[quoted context]\n\nwhat's this" },
    ], from);
  });

  // A photo's history row is saved before its (slow) extraction finishes, so a follow-up text can
  // be queued first even though it was sent second.
  it("keeps batched messages in the order they were sent, not the order they were queued", async () => {
    const from = nextPhone();
    vi.mocked(getWhatsAppHistory).mockReturnValue([
      { id: 30, phone: from, role: "user", content: "[Sent receipt.jpg]", createdAt: 0 },
      { id: 31, phone: from, role: "user", content: "add this to expenses", createdAt: 0 },
    ] as never);

    queueForAssistant(1, from, "wamid-text", 31, null, false);
    queueForAssistant(1, from, "wamid-media", 30, "RECEIPT TEXT", false);
    await vi.advanceTimersByTimeAsync(LONG_DEBOUNCE_MS);

    expect(runAssistantChat).toHaveBeenCalledWith(1, [
      { role: "user", content: "RECEIPT TEXT" },
      { role: "user", content: "add this to expenses" },
    ], from);
  });

  it("queues messages that arrive while a call is in flight instead of running concurrently", async () => {
    const from = nextPhone();
    let resolveFirst!: (v: { text: string }) => void;
    vi.mocked(runAssistantChat).mockReset().mockImplementationOnce(
      () => new Promise((resolve) => (resolveFirst = resolve))
    );

    queueForAssistant(1, from, "wamid1", undefined, null, true);
    await vi.advanceTimersByTimeAsync(SHORT_DEBOUNCE_MS);
    expect(runAssistantChat).toHaveBeenCalledTimes(1);

    // Second message arrives mid-call — must not start a second concurrent call.
    queueForAssistant(1, from, "wamid2", undefined, null, true);
    await vi.advanceTimersByTimeAsync(SHORT_DEBOUNCE_MS);
    expect(runAssistantChat).toHaveBeenCalledTimes(1);

    vi.mocked(runAssistantChat).mockResolvedValueOnce({ text: "reply2" } as never);
    resolveFirst({ text: "reply1" });
    await vi.advanceTimersByTimeAsync(0);

    // Now the queued message gets its own fresh debounce window.
    await vi.advanceTimersByTimeAsync(SHORT_DEBOUNCE_MS);
    expect(runAssistantChat).toHaveBeenCalledTimes(2);
    expect(sendAssistantReply).toHaveBeenLastCalledWith(1, from, { text: "reply2" }, "wamid2");
  });

  it("reports a failure to the user instead of throwing unhandled", async () => {
    const from = nextPhone();
    vi.mocked(runAssistantChat).mockReset().mockRejectedValueOnce(new Error("boom"));

    queueForAssistant(1, from, "wamid1", undefined, null, true);
    await vi.advanceTimersByTimeAsync(SHORT_DEBOUNCE_MS);

    expect(sendWhatsAppMessage).toHaveBeenCalledWith(
      from,
      expect.stringContaining("error")
    );
  });
});

describe("looksComplete", () => {
  it("treats a sentence ending in terminal punctuation as complete", () => {
    expect(looksComplete("What does this say?")).toBe(true);
  });

  it("treats a message with no terminal punctuation as incomplete", () => {
    expect(looksComplete("can you store it for me")).toBe(false);
  });

  it("treats a message trailing off with a conjunction as incomplete", () => {
    expect(looksComplete("also I wanted to ask about the invoice and")).toBe(false);
  });

  it("treats a message ending in a comma as incomplete", () => {
    expect(looksComplete("send it to John,")).toBe(false);
  });

  it("treats a common short reply as complete even without punctuation", () => {
    expect(looksComplete("thanks")).toBe(true);
  });

  it("treats an ellipsis-trailing message as incomplete", () => {
    expect(looksComplete("so about that meeting...")).toBe(false);
  });
});

describe("holding message on slow replies", () => {
  function slowReply(ms: number, fail = false) {
    vi.mocked(runAssistantChat).mockImplementation(
      () =>
        new Promise((resolve, reject) =>
          setTimeout(() => (fail ? reject(new Error("boom")) : resolve({ text: "reply" } as never)), ms)
        )
    );
  }

  it("sends one holding line, then the real reply, when the assistant is slow", async () => {
    const from = nextPhone();
    slowReply(HOLDING_MESSAGE_MS * 3);
    queueForAssistant(1, from, "wamid1", undefined, null, true);
    await vi.advanceTimersByTimeAsync(SHORT_DEBOUNCE_MS);

    await vi.advanceTimersByTimeAsync(HOLDING_MESSAGE_MS - 1);
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    expect(HOLDING_MESSAGES).toContain(vi.mocked(sendWhatsAppMessage).mock.calls[0][1]);
    // Re-shows the "..." dots, which WhatsApp drops after ~25s.
    expect(sendWhatsAppTypingIndicator).toHaveBeenCalledWith("wamid1");
    expect(sendAssistantReply).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(HOLDING_MESSAGE_MS * 3);
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    expect(sendAssistantReply).toHaveBeenCalledTimes(1);
  });

  // The holding line isn't its own history row (the model never sees it), so its wamid travels with
  // the reply — a swipe on "one sec…" then resolves to the answer it was waiting on.
  it("hands the holding line's wamid and text to the reply, to be recorded as its first part", async () => {
    const from = nextPhone();
    slowReply(HOLDING_MESSAGE_MS * 3);
    vi.mocked(sendWhatsAppMessage).mockResolvedValueOnce("wamid.holding");
    queueForAssistant(1, from, "wamid1", undefined, null, true);

    await vi.advanceTimersByTimeAsync(SHORT_DEBOUNCE_MS + HOLDING_MESSAGE_MS * 4);

    const line = vi.mocked(sendWhatsAppMessage).mock.calls[0][1];
    expect(sendAssistantReply).toHaveBeenCalledWith(1, from, { text: "reply" }, "wamid1", [
      { wamid: "wamid.holding", text: line },
    ]);
  });

  it("sends no holding line when the reply is quick", async () => {
    const from = nextPhone();
    slowReply(HOLDING_MESSAGE_MS - 100);
    queueForAssistant(1, from, "wamid1", undefined, null, true);
    await vi.advanceTimersByTimeAsync(SHORT_DEBOUNCE_MS + HOLDING_MESSAGE_MS * 3);

    expect(sendAssistantReply).toHaveBeenCalledTimes(1);
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it("cancels the holding line when the assistant call fails fast", async () => {
    const from = nextPhone();
    slowReply(100, true);
    queueForAssistant(1, from, "wamid1", undefined, null, true);
    await vi.advanceTimersByTimeAsync(SHORT_DEBOUNCE_MS + HOLDING_MESSAGE_MS * 3);

    // Only the error message — no holding line after it.
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendWhatsAppMessage).mock.calls[0][1]).toMatch(/error/);
  });
});
