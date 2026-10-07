import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/store.js", () => ({
  getDocumentByWamid: vi.fn(),
  getWhatsAppMessageByWamid: vi.fn(),
  getSentDocumentByWamid: vi.fn(),
  getRecentWhatsAppMessagesForOwner: vi.fn().mockReturnValue([]),
}));

const { getDocumentByWamid, getSentDocumentByWamid, getWhatsAppMessageByWamid, getRecentWhatsAppMessagesForOwner } =
  await import("../db/store.js");
const { resolveQuotedMessageContext } = await import("./quotedMessage.js");

beforeEach(() => {
  vi.mocked(getDocumentByWamid).mockReset();
  vi.mocked(getWhatsAppMessageByWamid).mockReset();
  vi.mocked(getSentDocumentByWamid).mockReset();
  vi.mocked(getRecentWhatsAppMessagesForOwner).mockReset().mockReturnValue([]);
});

describe("resolveQuotedMessageContext", () => {
  it("returns null when there's no quote and the message wasn't forwarded", () => {
    expect(resolveQuotedMessageContext(1, undefined, undefined)).toBeNull();
    expect(getDocumentByWamid).not.toHaveBeenCalled();
    expect(getWhatsAppMessageByWamid).not.toHaveBeenCalled();
  });

  it("resolves a quoted photo/document to its real extracted content, checked before plain text", () => {
    vi.mocked(getDocumentByWamid).mockReturnValue({
      id: 5,
      title: "Boarding pass",
      filename: "bp.jpg",
      extractedText: "Flight BA123, seat 14C",
    } as never);

    const context = resolveQuotedMessageContext(1, "wamid.old", undefined);

    expect(context).toContain("Boarding pass");
    expect(context).toContain("Flight BA123, seat 14C");
    expect(getWhatsAppMessageByWamid).not.toHaveBeenCalled();
  });

  it("falls back to filename when a quoted document has no title", () => {
    vi.mocked(getDocumentByWamid).mockReturnValue({
      id: 5,
      title: null,
      filename: "receipt.pdf",
      extractedText: "Total: £12.50",
    } as never);

    const context = resolveQuotedMessageContext(1, "wamid.old", undefined);

    expect(context).toContain("receipt.pdf");
  });

  it("resolves a quoted plain-text message when no document matches", () => {
    vi.mocked(getDocumentByWamid).mockReturnValue(undefined);
    vi.mocked(getWhatsAppMessageByWamid).mockReturnValue({
      id: 9,
      phone: "44700",
      role: "user",
      content: "remind me to call the plumber",
      createdAt: Date.now(),
    } as never);

    const context = resolveQuotedMessageContext(1, "wamid.old", undefined);

    expect(context).toContain("remind me to call the plumber");
  });

  it("tells the model plainly it can't retrieve an untracked quote, rather than staying silent", () => {
    vi.mocked(getDocumentByWamid).mockReturnValue(undefined);
    vi.mocked(getWhatsAppMessageByWamid).mockReturnValue(undefined);

    vi.spyOn(console, "warn").mockImplementation(() => {});
    const context = resolveQuotedMessageContext(1, "wamid.unknown", undefined);

    expect(context).toMatch(/can't (see|retrieve)/i);
    expect(context).toMatch(/ask which message they mean/i);
  });

  // Reported: "what's this" on an anime list (one part of a longer message) got an answer about a
  // Google security alert. The swiped part is what the answer has to be about.
  it("points at the exact part swiped when the message went out in several parts", () => {
    vi.mocked(getDocumentByWamid).mockReturnValue(undefined);
    vi.mocked(getWhatsAppMessageByWamid).mockReturnValue({
      id: 9,
      phone: "44700",
      role: "assistant",
      content: "Google security alert: Claude for Google Drive was allowed access.\n\n- Log Horizon\n- Megalobox",
      partText: "- Log Horizon\n- Megalobox",
      createdAt: Date.now(),
    } as never);

    const context = resolveQuotedMessageContext(1, "wamid.part2", undefined, "44700")!;

    const swipedAt = context.indexOf("- Log Horizon");
    const fullAt = context.indexOf("Google security alert");
    expect(swipedAt).toBeGreaterThan(-1);
    expect(fullAt).toBeGreaterThan(swipedAt);
    expect(context).toMatch(/about that part/i);
  });

  it("resolves a swipe on a file Marlowe sent back to that document's content", () => {
    vi.mocked(getDocumentByWamid).mockReturnValue(undefined);
    vi.mocked(getSentDocumentByWamid).mockReturnValue({
      id: 7,
      title: "Boarding pass",
      filename: "bp.jpg",
      extractedText: "Flight BA123, seat 14C",
    } as never);

    const context = resolveQuotedMessageContext(1, "wamid.sent-file", undefined, "44700");

    expect(context).toContain("you sent them");
    expect(context).toContain("Flight BA123, seat 14C");
    expect(getWhatsAppMessageByWamid).not.toHaveBeenCalled();
  });

  it("says when the quoted message was the user's own", () => {
    vi.mocked(getDocumentByWamid).mockReturnValue(undefined);
    vi.mocked(getWhatsAppMessageByWamid).mockReturnValue({
      id: 9, phone: "44700", role: "user", content: "book the 6pm bus", createdAt: Date.now(),
    } as never);

    expect(resolveQuotedMessageContext(1, "wamid.mine", undefined, "44700")).toMatch(/of their own: "book the 6pm bus"/);
  });

  it("offers Marlowe's recent messages to match against when the quote can't be resolved, and forbids guessing", () => {
    vi.mocked(getDocumentByWamid).mockReturnValue(undefined);
    vi.mocked(getWhatsAppMessageByWamid).mockReturnValue(undefined);
    vi.mocked(getRecentWhatsAppMessagesForOwner).mockReturnValue([
      { id: 1, phone: "44700", role: "assistant", content: "Here are some anime picks: Log Horizon", createdAt: Date.UTC(2026, 9, 7, 0, 41) },
      { id: 2, phone: "44700", role: "user", content: "thanks", createdAt: Date.UTC(2026, 9, 7, 0, 42) },
      { id: 3, phone: "44700", role: "assistant", content: "Google security alert", createdAt: Date.UTC(2026, 9, 7, 0, 50) },
    ]);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const context = resolveQuotedMessageContext(1, "wamid.unknown", undefined, "44700")!;

    expect(getRecentWhatsAppMessagesForOwner).toHaveBeenCalledWith(1, "44700", expect.any(Number));
    expect(context).toContain("Log Horizon");
    expect(context).toContain("2026-10-07 00:41 UTC");
    expect(context).not.toContain("thanks");
    expect(context).toMatch(/never answer on a guess/i);
    expect(context).toMatch(/don't make up a reason/i);
    expect(console.warn).toHaveBeenCalled();
  });

  it("notes a forwarded message even with no quote to resolve", () => {
    const context = resolveQuotedMessageContext(1, undefined, true);

    expect(context).toMatch(/forwarded/i);
  });

  it("combines a resolved quote and a forwarded note when both apply", () => {
    vi.mocked(getDocumentByWamid).mockReturnValue(undefined);
    vi.mocked(getWhatsAppMessageByWamid).mockReturnValue({
      id: 9,
      phone: "44700",
      role: "assistant",
      content: "Your flight is at 6pm.",
      createdAt: Date.now(),
    } as never);

    const context = resolveQuotedMessageContext(1, "wamid.old", true);

    expect(context).toContain("Your flight is at 6pm.");
    expect(context).toMatch(/forwarded/i);
  });
});
