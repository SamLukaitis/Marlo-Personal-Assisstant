import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/store.js", () => ({
  appendWhatsAppMessage: vi.fn(),
  resolveOwnerByPhone: vi.fn().mockReturnValue(null),
}));
vi.mock("../providers/whatsapp.js", () => ({
  sendWhatsAppMessage: vi.fn().mockResolvedValue(undefined),
  sendChoiceMessage: vi.fn().mockResolvedValue([]),
  sendWhatsAppReaction: vi.fn().mockResolvedValue(undefined),
  sendWhatsAppLocationRequest: vi.fn().mockResolvedValue("wamid.loc"),
  sendWhatsAppReplyButtons: vi.fn().mockResolvedValue("wamid.buttons"),
  sendWhatsAppCtaUrl: vi.fn().mockResolvedValue("wamid.link"),
}));
vi.mock("./sleep.js", () => ({ sleep: vi.fn().mockResolvedValue(undefined) }));

const { appendWhatsAppMessage, resolveOwnerByPhone } = await import("../db/store.js");
const { sendWhatsAppMessage, sendChoiceMessage, sendWhatsAppReaction, sendWhatsAppLocationRequest, sendWhatsAppCtaUrl } = await import("../providers/whatsapp.js");
const { sleep } = await import("./sleep.js");
const { sendAssistantReply, sendTextAndRecord, sendScriptedText, sendScriptedButtons, sendScriptedLink } = await import(
  "./whatsappReply.js"
);

beforeEach(() => {
  vi.mocked(appendWhatsAppMessage).mockClear();
  vi.mocked(sendWhatsAppMessage).mockClear();
  vi.mocked(sendChoiceMessage).mockClear();
  vi.mocked(sendWhatsAppReaction).mockClear();
  vi.mocked(sleep).mockClear();
  vi.mocked(sendWhatsAppLocationRequest).mockClear();
});

describe("sendAssistantReply", () => {
  it("sends a reply carrying one phone-action link as a Run on iPhone button, keeping the full text in history", async () => {
    const { SERVER_URL } = await import("../config.js");
    const link = `${SERVER_URL}/a/kLflvrBG4C_8kJzkdVGZ3A`;
    vi.mocked(sendWhatsAppCtaUrl).mockClear();
    await sendAssistantReply(1, "44700", { text: `Tap to set a 7:00 alarm:\n${link}` }, "wamid.in");
    expect(sendWhatsAppCtaUrl).toHaveBeenCalledWith("44700", "Tap to set a 7:00 alarm:", "Run on iPhone", link);
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(appendWhatsAppMessage).toHaveBeenCalledWith(1, "44700", "assistant", `Tap to set a 7:00 alarm:\n${link}`, [
      { wamid: "wamid.link", text: "Tap to set a 7:00 alarm:" },
    ]);
  });

  it("falls back to plain text when the button send fails", async () => {
    const { SERVER_URL } = await import("../config.js");
    const link = `${SERVER_URL}/a/kLflvrBG4C_8kJzkdVGZ3A`;
    vi.mocked(sendWhatsAppCtaUrl).mockRejectedValueOnce(new Error("graph down"));
    await sendAssistantReply(1, "44700", { text: `Tap:\n${link}` }, "wamid.in");
    expect(sendWhatsAppMessage).toHaveBeenCalledWith("44700", `Tap:\n${link}`);
  });

  it("sends a flight search link as a View Google Flights button, keeping the full text in history", async () => {
    const link = "https://marlowe.up.railway.app/go/Ab3dE9xY";
    const text = `Vueling, direct, £84.\nBook: https://www.kiwi.com/x\nAll options:\n${link}`;
    vi.mocked(sendWhatsAppCtaUrl).mockClear();
    await sendAssistantReply(1, "44700", { text, linkButton: { label: "View Google Flights", url: link } }, "wamid.in");
    expect(sendWhatsAppCtaUrl).toHaveBeenCalledWith(
      "44700",
      "Vueling, direct, £84.\nBook: https://www.kiwi.com/x\nAll options:",
      "View Google Flights",
      link
    );
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(appendWhatsAppMessage).toHaveBeenCalledWith(1, "44700", "assistant", text, [
      { wamid: "wamid.link", text: "Vueling, direct, £84.\nBook: https://www.kiwi.com/x\nAll options:" },
    ]);
  });

  it("falls back to the plain reply when the search button send fails", async () => {
    const link = "https://marlowe.up.railway.app/go/Ab3dE9xY";
    vi.mocked(sendWhatsAppCtaUrl).mockRejectedValueOnce(new Error("graph down"));
    await sendAssistantReply(1, "44700", { text: `£84.\n${link}`, linkButton: { label: "View Google Flights", url: link } }, "wamid.in");
    expect(sendWhatsAppMessage).toHaveBeenCalledWith("44700", `£84.\n${link}`);
  });

  it("sends plain text and persists it when there's no choice", async () => {
    await sendAssistantReply(1, "44700", { text: "Sure, done." }, "wamid.in");

    expect(appendWhatsAppMessage).toHaveBeenCalledWith(1, "44700", "assistant", "Sure, done.");
    expect(sendWhatsAppMessage).toHaveBeenCalledWith("44700", "Sure, done.");
    expect(sendChoiceMessage).not.toHaveBeenCalled();
  });

  it("keeps the note of files sent in history, but never sends it", async () => {
    vi.mocked(sendWhatsAppMessage).mockResolvedValueOnce("wamid.out");
    await sendAssistantReply(1, "44700", { text: "Here it is.", historyNote: "[Files sent with this message: Passport]" }, "wamid.in");

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    expect(sendWhatsAppMessage).toHaveBeenCalledWith("44700", "Here it is.");
    expect(appendWhatsAppMessage).toHaveBeenCalledWith(
      1,
      "44700",
      "assistant",
      "Here it is.\n\n[Files sent with this message: Passport]",
      [{ wamid: "wamid.out", text: "Here it is." }]
    );
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

    expect(appendWhatsAppMessage).toHaveBeenCalledWith(1, "44700", "assistant", text, [
      { wamid: "wamid.chunk1", text: "First paragraph." },
      { wamid: "wamid.chunk2", text: "Second paragraph." },
    ]);
  });

  // Reported: a swipe on a choice message (or the plain text sent before its buttons) couldn't be
  // resolved — none of their wamids were kept.
  it("records every part of a choice message with its wamid and text, after sending it", async () => {
    vi.mocked(sendChoiceMessage).mockResolvedValueOnce([
      { wamid: "wamid.p1", text: "Long draft..." },
      { wamid: "wamid.p2", text: "Ready to send this?" },
    ]);

    await sendAssistantReply(1, "44700", {
      text: "Long draft...\n\nReady to send this?",
      choice: { actionId: "x", question: "Long draft...\n\nReady to send this?", mode: "confirm", buttons: [{ key: "yes", label: "Send" }] },
    }, "wamid.in");

    expect(appendWhatsAppMessage).toHaveBeenCalledWith(1, "44700", "assistant", "Long draft...\n\nReady to send this?", [
      { wamid: "wamid.p1", text: "Long draft..." },
      { wamid: "wamid.p2", text: "Ready to send this?" },
    ]);
    expect(vi.mocked(sendChoiceMessage).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(appendWhatsAppMessage).mock.invocationCallOrder[0]
    );
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

describe("sendTextAndRecord", () => {
  it("sends, then records the message with its wamid", async () => {
    vi.mocked(sendWhatsAppMessage).mockResolvedValueOnce("wamid.sent");

    await sendTextAndRecord(1, "44700", "Cancelled.");

    expect(sendWhatsAppMessage).toHaveBeenCalledWith("44700", "Cancelled.");
    expect(appendWhatsAppMessage).toHaveBeenCalledWith(1, "44700", "assistant", "Cancelled.", ["wamid.sent"]);
  });

  it("still records the message when the send fails, and rethrows", async () => {
    vi.mocked(sendWhatsAppMessage).mockRejectedValueOnce(new Error("meta down"));

    await expect(sendTextAndRecord(1, "44700", "Cancelled.")).rejects.toThrow("meta down");

    expect(appendWhatsAppMessage).toHaveBeenCalledWith(1, "44700", "assistant", "Cancelled.");
  });
});

describe("earlier parts (the holding line)", () => {
  it("records the holding line as the first part of the reply that follows it", async () => {
    vi.mocked(sendWhatsAppMessage).mockResolvedValueOnce("wamid.reply");

    await sendAssistantReply(1, "44700", { text: "Here you go." }, "wamid.in", [
      { wamid: "wamid.holding", text: "One sec, working on it…" },
    ]);

    expect(appendWhatsAppMessage).toHaveBeenCalledWith(1, "44700", "assistant", "Here you go.", [
      { wamid: "wamid.holding", text: "One sec, working on it…" },
      "wamid.reply",
    ]);
  });
});

describe("scripted messages (onboarding, connect links, errors)", () => {
  it("records a scripted text against the phone's owner, with its wamid", async () => {
    vi.mocked(resolveOwnerByPhone).mockReturnValueOnce(9);
    vi.mocked(sendWhatsAppMessage).mockResolvedValueOnce("wamid.s1");

    await sendScriptedText("44700", "What should I call you?");

    expect(appendWhatsAppMessage).toHaveBeenCalledWith(9, "44700", "assistant", "What should I call you?", ["wamid.s1"]);
  });

  it("just sends when the number has no account yet", async () => {
    vi.mocked(resolveOwnerByPhone).mockReturnValueOnce(null);

    await sendScriptedText("44700", "What's your email address?");

    expect(sendWhatsAppMessage).toHaveBeenCalledWith("44700", "What's your email address?");
    expect(appendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it("records buttons with their wamid", async () => {
    vi.mocked(resolveOwnerByPhone).mockReturnValueOnce(9);

    await sendScriptedButtons("44700", "Want a daily update?", [{ id: "y", title: "Yes" }]);

    expect(appendWhatsAppMessage).toHaveBeenCalledWith(9, "44700", "assistant", "Want a daily update?", ["wamid.buttons"]);
  });

  it("records a connect link's body text but never the link, which carries a sign-in token", async () => {
    vi.mocked(resolveOwnerByPhone).mockReturnValueOnce(9);

    await sendScriptedLink("44700", "Tap below to connect Gmail.", "Connect Gmail", "https://x/auth?token=SECRET");

    const call = vi.mocked(appendWhatsAppMessage).mock.calls[0];
    expect(call).toEqual([9, "44700", "assistant", "Tap below to connect Gmail.", ["wamid.link"]]);
    expect(JSON.stringify(call)).not.toContain("SECRET");
  });

  it("never fails the send when recording does", async () => {
    vi.mocked(resolveOwnerByPhone).mockImplementationOnce(() => {
      throw new Error("db locked");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(sendScriptedText("44700", "hi")).resolves.toBeUndefined();
  });
});
