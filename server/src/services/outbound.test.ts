import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../providers/whatsapp.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../providers/whatsapp.js")>();
  return {
    ...actual, // keeps the real WhatsAppSendError class — the code under test does `instanceof` on it
    sendWhatsAppMessage: vi.fn(),
    sendWhatsAppTemplate: vi.fn(),
    sendChoiceMessage: vi.fn(),
  };
});

vi.mock("../db/store.js", () => ({
  getLastInboundAt: vi.fn(),
  resolveOwnerByPhone: vi.fn(),
  appendWhatsAppMessage: vi.fn(),
}));

const { sendWhatsAppMessage, sendWhatsAppTemplate, sendChoiceMessage, WhatsAppSendError } = await import(
  "../providers/whatsapp.js"
);
const { getLastInboundAt, resolveOwnerByPhone, appendWhatsAppMessage } = await import("../db/store.js");
const { sendProactiveMessage, sendProactiveMessageWithButtons, truncateForTemplate } = await import("./outbound.js");

const PHONE = "447000000001";
const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.mocked(sendWhatsAppMessage).mockReset().mockResolvedValue(undefined);
  vi.mocked(sendWhatsAppTemplate).mockReset().mockResolvedValue(undefined);
  vi.mocked(sendChoiceMessage).mockReset().mockResolvedValue("wamid.BUTTONS");
  vi.mocked(getLastInboundAt).mockReset();
  vi.mocked(resolveOwnerByPhone).mockReset().mockReturnValue(null);
  vi.mocked(appendWhatsAppMessage).mockReset();
});

describe("sendProactiveMessageWithButtons", () => {
  const buttons = [
    { id: "a", title: "Yes" },
    { id: "b", title: "No" },
  ];

  it("sends tappable buttons within the 24h window, and records the message with its wamid in history", async () => {
    vi.mocked(getLastInboundAt).mockReturnValue(Date.now() - 60_000);
    vi.mocked(resolveOwnerByPhone).mockReturnValue(7);

    await sendProactiveMessageWithButtons(PHONE, "question?", buttons, "alert", "[note]", "question? reply yes or no");

    expect(sendChoiceMessage).toHaveBeenCalledWith(PHONE, "question?", buttons);
    expect(sendWhatsAppTemplate).not.toHaveBeenCalled();
    expect(appendWhatsAppMessage).toHaveBeenCalledWith(7, PHONE, "assistant", "question?\n\n[note]", ["wamid.BUTTONS"]);
  });

  // A template can't carry buttons, so the person is asked in words instead.
  it("outside the window sends the typed-reply fallback as a template", async () => {
    vi.mocked(getLastInboundAt).mockReturnValue(null);

    await sendProactiveMessageWithButtons(PHONE, "question?", buttons, "alert", undefined, "question? reply yes or no");

    expect(sendChoiceMessage).not.toHaveBeenCalled();
    expect(sendWhatsAppTemplate).toHaveBeenCalledWith(PHONE, "marlowe_alert", "question? reply yes or no");
  });

  it("falls back to the template when Meta says the window is closed after all", async () => {
    vi.mocked(getLastInboundAt).mockReturnValue(Date.now() - 60_000);
    vi.mocked(sendChoiceMessage).mockRejectedValueOnce(new WhatsAppSendError("closed", 131047));

    await sendProactiveMessageWithButtons(PHONE, "question?", buttons, "alert", undefined, "typed fallback");

    expect(sendWhatsAppTemplate).toHaveBeenCalledWith(PHONE, "marlowe_alert", "typed fallback");
  });

  it("rethrows any other failure so the caller retries", async () => {
    vi.mocked(getLastInboundAt).mockReturnValue(Date.now() - 60_000);
    vi.mocked(sendChoiceMessage).mockRejectedValueOnce(new WhatsAppSendError("rate limited", 130429));

    await expect(
      sendProactiveMessageWithButtons(PHONE, "question?", buttons, "alert", undefined, "typed fallback")
    ).rejects.toThrow("rate limited");
    expect(sendWhatsAppTemplate).not.toHaveBeenCalled();
  });
});

describe("sendProactiveMessage", () => {
  it("sends free-form when the number messaged us within the last 24h", async () => {
    vi.mocked(getLastInboundAt).mockReturnValue(Date.now() - 60_000);

    await sendProactiveMessage(PHONE, "hello", "alert");

    expect(sendWhatsAppMessage).toHaveBeenCalledWith(PHONE, "hello");
    expect(sendWhatsAppTemplate).not.toHaveBeenCalled();
  });

  it("sends the alert template when the number never messaged us", async () => {
    vi.mocked(getLastInboundAt).mockReturnValue(null);

    await sendProactiveMessage(PHONE, "hello", "alert");

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(sendWhatsAppTemplate).toHaveBeenCalledWith(PHONE, "marlowe_alert", "hello");
  });

  it("sends the digest template when the window closed more than 24h ago", async () => {
    vi.mocked(getLastInboundAt).mockReturnValue(Date.now() - (DAY_MS + 60_000));

    await sendProactiveMessage(PHONE, "today's briefing", "digest");

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(sendWhatsAppTemplate).toHaveBeenCalledWith(PHONE, "marlowe_digest", "today's briefing");
  });

  it("self-heals by retrying as a template when a within-window free-form send is rejected with 131047", async () => {
    vi.mocked(getLastInboundAt).mockReturnValue(Date.now() - 60_000);
    vi.mocked(sendWhatsAppMessage).mockRejectedValueOnce(new WhatsAppSendError("closed", 131047));

    await sendProactiveMessage(PHONE, "hello", "alert");

    expect(sendWhatsAppTemplate).toHaveBeenCalledWith(PHONE, "marlowe_alert", "hello");
  });

  it("rethrows a free-form failure that isn't the window-closed error, without falling back to a template", async () => {
    vi.mocked(getLastInboundAt).mockReturnValue(Date.now() - 60_000);
    vi.mocked(sendWhatsAppMessage).mockRejectedValueOnce(new WhatsAppSendError("rate limited", 130429));

    await expect(sendProactiveMessage(PHONE, "hello", "alert")).rejects.toThrow("rate limited");
    expect(sendWhatsAppTemplate).not.toHaveBeenCalled();
  });

  it("rethrows a non-WhatsApp error from the free-form send unchanged", async () => {
    vi.mocked(getLastInboundAt).mockReturnValue(Date.now() - 60_000);
    vi.mocked(sendWhatsAppMessage).mockRejectedValueOnce(new Error("network down"));

    await expect(sendProactiveMessage(PHONE, "hello", "alert")).rejects.toThrow("network down");
    expect(sendWhatsAppTemplate).not.toHaveBeenCalled();
  });

  it("truncates a too-long digest for the template path and appends the continuation note", async () => {
    vi.mocked(getLastInboundAt).mockReturnValue(null);
    const longText = "x".repeat(2000);

    await sendProactiveMessage(PHONE, longText, "digest");

    const [, , param] = vi.mocked(sendWhatsAppTemplate).mock.calls[0];
    expect(param.length).toBeLessThan(2000);
    expect(param.endsWith("…open the app for the rest.")).toBe(true);
  });

  it("truncates a too-long alert for the template path without a continuation note", async () => {
    vi.mocked(getLastInboundAt).mockReturnValue(null);
    const longText = "y".repeat(2000);

    await sendProactiveMessage(PHONE, longText, "alert");

    const [, , param] = vi.mocked(sendWhatsAppTemplate).mock.calls[0];
    expect(param.length).toBeLessThanOrEqual(1000);
    expect(param).toBe("y".repeat(1000));
  });
});

// Reported: swipe-replying to an alert ("Sam, X emailed you: Testing") got "I can't see which
// message you replied to", and a plain "reply yes" had no idea an alert had just been sent — the
// alert was never in chat history and its wamid was never recorded, unlike a normal chat reply.
describe("sendProactiveMessage — making the push quotable", () => {
  const OWNER = 42;

  it("records a free-form alert in chat history against the wamid Meta returned", async () => {
    vi.mocked(getLastInboundAt).mockReturnValue(Date.now() - 60_000);
    vi.mocked(resolveOwnerByPhone).mockReturnValue(OWNER);
    vi.mocked(sendWhatsAppMessage).mockResolvedValue("wamid.FREEFORM");

    await sendProactiveMessage(PHONE, "Sam, Jane emailed you", "alert");

    expect(appendWhatsAppMessage).toHaveBeenCalledWith(OWNER, PHONE, "assistant", "Sam, Jane emailed you", [
      "wamid.FREEFORM",
    ]);
  });

  it("records a template alert with its full original text and the template's wamid", async () => {
    vi.mocked(getLastInboundAt).mockReturnValue(null);
    vi.mocked(resolveOwnerByPhone).mockReturnValue(OWNER);
    vi.mocked(sendWhatsAppTemplate).mockResolvedValue("wamid.TEMPLATE");

    const text = "line one\n\nline two";

    await sendProactiveMessage(PHONE, text, "alert");

    expect(appendWhatsAppMessage).toHaveBeenCalledWith(OWNER, PHONE, "assistant", text, ["wamid.TEMPLATE"]);
  });

  it("records the template's wamid, not a rejected free-form send, after a 131047 self-heal", async () => {
    vi.mocked(getLastInboundAt).mockReturnValue(Date.now() - 60_000);
    vi.mocked(resolveOwnerByPhone).mockReturnValue(OWNER);
    vi.mocked(sendWhatsAppMessage).mockRejectedValueOnce(new WhatsAppSendError("closed", 131047));
    vi.mocked(sendWhatsAppTemplate).mockResolvedValue("wamid.HEALED");

    await sendProactiveMessage(PHONE, "hello", "alert");

    expect(appendWhatsAppMessage).toHaveBeenCalledTimes(1);
    expect(appendWhatsAppMessage).toHaveBeenCalledWith(OWNER, PHONE, "assistant", "hello", ["wamid.HEALED"]);
  });

  it("still records the message in history when Meta returned no wamid", async () => {
    vi.mocked(getLastInboundAt).mockReturnValue(null);
    vi.mocked(resolveOwnerByPhone).mockReturnValue(OWNER);
    vi.mocked(sendWhatsAppTemplate).mockResolvedValue(undefined);

    await sendProactiveMessage(PHONE, "hello", "alert");

    expect(appendWhatsAppMessage).toHaveBeenCalledWith(OWNER, PHONE, "assistant", "hello", undefined);
  });

  // What the model needs to reply to the email an alert is about lives only in history, never in
  // what the user sees.
  it("stores an optional history note with the message but never sends it", async () => {
    vi.mocked(getLastInboundAt).mockReturnValue(Date.now() - 60_000);
    vi.mocked(resolveOwnerByPhone).mockReturnValue(OWNER);
    vi.mocked(sendWhatsAppMessage).mockResolvedValue("wamid.NOTE");

    await sendProactiveMessage(PHONE, "Sam, Jane emailed you", "alert", "[Email ref: account_id=1]");

    expect(sendWhatsAppMessage).toHaveBeenCalledWith(PHONE, "Sam, Jane emailed you");
    expect(appendWhatsAppMessage).toHaveBeenCalledWith(
      OWNER,
      PHONE,
      "assistant",
      "Sam, Jane emailed you\n\n[Email ref: account_id=1]",
      ["wamid.NOTE"]
    );
  });

  it("records nothing for a number that belongs to no account", async () => {
    vi.mocked(getLastInboundAt).mockReturnValue(null);
    vi.mocked(resolveOwnerByPhone).mockReturnValue(null);
    vi.mocked(sendWhatsAppTemplate).mockResolvedValue("wamid.X");

    await sendProactiveMessage(PHONE, "hello", "alert");

    expect(appendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it("records nothing when the send itself fails", async () => {
    vi.mocked(getLastInboundAt).mockReturnValue(Date.now() - 60_000);
    vi.mocked(resolveOwnerByPhone).mockReturnValue(OWNER);
    vi.mocked(sendWhatsAppMessage).mockRejectedValueOnce(new Error("network down"));

    await expect(sendProactiveMessage(PHONE, "hello", "alert")).rejects.toThrow("network down");
    expect(appendWhatsAppMessage).not.toHaveBeenCalled();
  });

  // A history-write failure after a successful send must not surface as a send failure — callers
  // treat a throw as "not delivered" and retry, which would re-send the same alert.
  it("does not turn a delivered message into a failure when recording it fails", async () => {
    vi.mocked(getLastInboundAt).mockReturnValue(null);
    vi.mocked(resolveOwnerByPhone).mockReturnValue(OWNER);
    vi.mocked(sendWhatsAppTemplate).mockResolvedValue("wamid.OK");
    vi.mocked(appendWhatsAppMessage).mockImplementation(() => {
      throw new Error("db locked");
    });

    await expect(sendProactiveMessage(PHONE, "hello", "alert")).resolves.toBeUndefined();
  });
});

describe("truncateForTemplate", () => {
  it("returns short text unchanged, with no continuation appended", () => {
    expect(truncateForTemplate("short", " …more")).toBe("short");
  });

  it("truncates long text and appends the continuation within budget", () => {
    const result = truncateForTemplate("z".repeat(1500), " …more");
    expect(result.length).toBe(1000);
    expect(result.endsWith(" …more")).toBe(true);
  });

  it("truncates to the full budget when there's no continuation", () => {
    const result = truncateForTemplate("z".repeat(1500));
    expect(result).toBe("z".repeat(1000));
  });

  // WhatsApp rejects a template parameter outright if it contains a newline, a tab, or a run of
  // more than one space (Meta error #132000) — see attentionRules.ts's message builders, which deliberately
  // embeds "\n" and "\n\n" for the free-form chat bubble path.
  it("collapses newlines to a single space", () => {
    expect(truncateForTemplate("line one\nline two")).toBe("line one line two");
  });

  it("collapses a run of blank lines to a single space, not one space per line", () => {
    expect(truncateForTemplate("line one\n\nline two")).toBe("line one line two");
  });

  it("collapses tabs to a single space", () => {
    expect(truncateForTemplate("a\tb")).toBe("a b");
  });

  it("collapses runs of more than one space to a single space", () => {
    expect(truncateForTemplate("a    b")).toBe("a b");
  });

  it("trims leading/trailing whitespace left over from collapsing", () => {
    expect(truncateForTemplate("\n  a\n")).toBe("a");
  });

  it("sanitizes a continuation that reintroduces disallowed whitespace after truncation", () => {
    const result = truncateForTemplate("z".repeat(1500), "\n…more");
    expect(result).not.toMatch(/[\r\n\t]|  /);
    expect(result.endsWith(" …more")).toBe(true);
  });
});
