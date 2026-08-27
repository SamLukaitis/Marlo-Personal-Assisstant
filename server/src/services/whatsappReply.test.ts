import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/store.js", () => ({
  appendWhatsAppMessage: vi.fn(),
}));
vi.mock("../providers/whatsapp.js", () => ({
  sendWhatsAppMessage: vi.fn().mockResolvedValue(undefined),
  sendChoiceMessage: vi.fn().mockResolvedValue(undefined),
}));

const { appendWhatsAppMessage } = await import("../db/store.js");
const { sendWhatsAppMessage, sendChoiceMessage } = await import("../providers/whatsapp.js");
const { sendAssistantReply } = await import("./whatsappReply.js");

beforeEach(() => {
  vi.mocked(appendWhatsAppMessage).mockClear();
  vi.mocked(sendWhatsAppMessage).mockClear();
  vi.mocked(sendChoiceMessage).mockClear();
});

describe("sendAssistantReply", () => {
  it("sends plain text and persists it when there's no choice", async () => {
    await sendAssistantReply(1, "44700", { text: "Sure, done." });

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
    });

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
});
