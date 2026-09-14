import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/store.js", () => ({
  getDocumentByWamid: vi.fn(),
  getWhatsAppMessageByWamid: vi.fn(),
}));

const { getDocumentByWamid, getWhatsAppMessageByWamid } = await import("../db/store.js");
const { resolveQuotedMessageContext } = await import("./quotedMessage.js");

beforeEach(() => {
  vi.mocked(getDocumentByWamid).mockReset();
  vi.mocked(getWhatsAppMessageByWamid).mockReset();
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

    const context = resolveQuotedMessageContext(1, "wamid.unknown", undefined);

    expect(context).toMatch(/can't (see|retrieve)/i);
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
