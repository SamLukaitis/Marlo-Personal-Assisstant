import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../providers/whatsapp.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../providers/whatsapp.js")>();
  return {
    ...actual, // keeps the real WhatsAppSendError class — the code under test does `instanceof` on it
    sendWhatsAppMessage: vi.fn(),
    sendWhatsAppTemplate: vi.fn(),
  };
});

vi.mock("../db/store.js", () => ({
  getLastInboundAt: vi.fn(),
}));

const { sendWhatsAppMessage, sendWhatsAppTemplate, WhatsAppSendError } = await import("../providers/whatsapp.js");
const { getLastInboundAt } = await import("../db/store.js");
const { sendProactiveMessage, truncateForTemplate } = await import("./outbound.js");

const PHONE = "447000000001";
const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.mocked(sendWhatsAppMessage).mockReset().mockResolvedValue(undefined);
  vi.mocked(sendWhatsAppTemplate).mockReset().mockResolvedValue(undefined);
  vi.mocked(getLastInboundAt).mockReset();
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

describe("truncateForTemplate", () => {
  it("returns short text unchanged, with no continuation appended", () => {
    expect(truncateForTemplate("short", "\n…more")).toBe("short");
  });

  it("truncates long text and appends the continuation within budget", () => {
    const result = truncateForTemplate("z".repeat(1500), "\n…more");
    expect(result.length).toBe(1000);
    expect(result.endsWith("\n…more")).toBe(true);
  });

  it("truncates to the full budget when there's no continuation", () => {
    const result = truncateForTemplate("z".repeat(1500));
    expect(result).toBe("z".repeat(1000));
  });
});
