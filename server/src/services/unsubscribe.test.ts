import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetInfo, mockSend, mockPost } = vi.hoisted(() => ({
  mockGetInfo: vi.fn(),
  mockSend: vi.fn(),
  mockPost: vi.fn(),
}));

vi.mock("./hub.js", () => ({
  hubGetUnsubscribeInfo: mockGetInfo,
  hubSendMessage: mockSend,
}));
vi.mock("./safeLinkFetcher.js", () => ({ safePostOneClick: mockPost }));

const { parseUnsubscribeHeaders, unsubscribeFromMessage } = await import("./unsubscribe.js");

const ONE_CLICK = "List-Unsubscribe=One-Click";

describe("parseUnsubscribeHeaders", () => {
  it("returns nothing for empty or junk headers", () => {
    expect(parseUnsubscribeHeaders("", "")).toEqual({ oneClick: false });
    expect(parseUnsubscribeHeaders("not a header", "")).toEqual({ oneClick: false });
  });

  it("picks out the https URL and the mailto target", () => {
    const t = parseUnsubscribeHeaders(
      "<mailto:unsub@news.example.com?subject=unsubscribe%20me>, <https://news.example.com/u/abc>",
      ""
    );
    expect(t.url).toBe("https://news.example.com/u/abc");
    expect(t.mailto).toEqual({ to: "unsub@news.example.com", subject: "unsubscribe me", body: "" });
    expect(t.oneClick).toBe(false);
  });

  it("flags one-click only when the Post header says so AND the URL is https", () => {
    expect(parseUnsubscribeHeaders("<https://x.example/u>", ONE_CLICK).oneClick).toBe(true);
    expect(parseUnsubscribeHeaders("<https://x.example/u>", "").oneClick).toBe(false);
    expect(parseUnsubscribeHeaders("<http://x.example/u>", ONE_CLICK).oneClick).toBe(false);
    expect(parseUnsubscribeHeaders("<mailto:a@b.co>", ONE_CLICK).oneClick).toBe(false);
  });

  it("keeps a plain http URL as a manual link", () => {
    expect(parseUnsubscribeHeaders("<http://x.example/u>", "").url).toBe("http://x.example/u");
  });

  it("defaults the mailto subject and drops CR/LF from it", () => {
    expect(parseUnsubscribeHeaders("<mailto:a@b.co>", "").mailto).toEqual({
      to: "a@b.co",
      subject: "unsubscribe",
      body: "",
    });
    const t = parseUnsubscribeHeaders("<mailto:a@b.co?subject=hi%0d%0aBcc:%20evil@x.co>", "");
    expect(t.mailto?.subject).not.toMatch(/[\r\n]/);
  });

  it("rejects mailto targets that aren't a single plain address", () => {
    expect(parseUnsubscribeHeaders("<mailto:a@b.co,c@d.co>", "").mailto).toBeUndefined();
    expect(parseUnsubscribeHeaders("<mailto:not-an-email>", "").mailto).toBeUndefined();
  });

  it("ignores non-http/mailto schemes", () => {
    const t = parseUnsubscribeHeaders("<javascript:alert(1)>, <ftp://x.example/u>", "");
    expect(t).toEqual({ oneClick: false });
  });
});

describe("unsubscribeFromMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function info(listUnsubscribe: string, listUnsubscribePost = "") {
    mockGetInfo.mockResolvedValue({ from: "Nike <news@nike.com>", listUnsubscribe, listUnsubscribePost });
  }

  it("reports unavailable when the message has no List-Unsubscribe header", async () => {
    info("");
    const r = await unsubscribeFromMessage(1, 2, "m1");
    expect(r.status).toBe("unavailable");
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("reports unavailable when the message can't be found", async () => {
    mockGetInfo.mockResolvedValue(null);
    const r = await unsubscribeFromMessage(1, 2, "m1");
    expect(r.status).toBe("unavailable");
  });

  it("uses one-click when offered", async () => {
    info("<mailto:u@nike.com>, <https://nike.com/u/1>", ONE_CLICK);
    mockPost.mockResolvedValue({ ok: true, status: 200 });
    const r = await unsubscribeFromMessage(1, 2, "m1");
    expect(mockPost).toHaveBeenCalledWith("https://nike.com/u/1");
    expect(mockSend).not.toHaveBeenCalled();
    expect(r).toEqual({ status: "unsubscribed", method: "one_click", sender: "Nike <news@nike.com>" });
  });

  it("falls back to mailto when one-click fails", async () => {
    info("<mailto:u@nike.com?subject=stop>, <https://nike.com/u/1>", ONE_CLICK);
    mockPost.mockResolvedValue({ ok: false, reason: "network_error" });
    mockSend.mockResolvedValue({ messageId: "s1" });
    const r = await unsubscribeFromMessage(1, 2, "m1");
    expect(mockSend).toHaveBeenCalledWith(1, 2, "u@nike.com", "stop", "");
    expect(r).toMatchObject({ status: "unsubscribed", method: "mailto" });
  });

  it("sends the mailto when there is no one-click", async () => {
    info("<mailto:u@nike.com>");
    mockSend.mockResolvedValue({ messageId: "s1" });
    const r = await unsubscribeFromMessage(1, 2, "m1");
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledWith(1, 2, "u@nike.com", "unsubscribe", "");
    expect(r).toMatchObject({ status: "unsubscribed", method: "mailto" });
  });

  it("hands back the link when the mailto can't be sent (e.g. Outlook) and a URL exists", async () => {
    info("<mailto:u@nike.com>, <https://nike.com/u/1>");
    mockSend.mockRejectedValue(new Error("Sending email isn't set up yet for Microsoft accounts"));
    const r = await unsubscribeFromMessage(1, 2, "m1");
    expect(r).toEqual({ status: "manual_link", url: "https://nike.com/u/1", sender: "Nike <news@nike.com>" });
  });

  it("reports unavailable with the reason when the mailto can't be sent and there's no URL", async () => {
    info("<mailto:u@nike.com>");
    mockSend.mockRejectedValue(new Error("Sending is turned off for a@b.co"));
    const r = await unsubscribeFromMessage(1, 2, "m1");
    expect(r).toMatchObject({ status: "unavailable" });
    expect((r as { reason: string }).reason).toContain("Sending is turned off");
  });

  it("never auto-fetches a plain link without one-click — returns it instead", async () => {
    info("<https://nike.com/u/1>");
    const r = await unsubscribeFromMessage(1, 2, "m1");
    expect(mockPost).not.toHaveBeenCalled();
    expect(r).toEqual({ status: "manual_link", url: "https://nike.com/u/1", sender: "Nike <news@nike.com>" });
  });

  it("returns the link when one-click fails and there's no mailto", async () => {
    info("<https://nike.com/u/1>", ONE_CLICK);
    mockPost.mockResolvedValue({ ok: false, reason: "blocked_host" });
    const r = await unsubscribeFromMessage(1, 2, "m1");
    expect(r).toMatchObject({ status: "manual_link", url: "https://nike.com/u/1" });
  });
});
