import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../providers/whatsapp.js", () => ({
  sendWhatsAppMessage: vi.fn(),
  isWhatsAppConfigured: vi.fn().mockReturnValue(true),
}));

const mockHubSendMessage = vi.fn();
vi.mock("./hub.js", () => ({
  hubSendMessage: (...args: unknown[]) => mockHubSendMessage(...args),
}));

const { sendWhatsAppMessage, isWhatsAppConfigured } = await import("../providers/whatsapp.js");
const { findOrCreateUserByEmail, addPhoneNumberForUser, upsertAccount, saveDocument, getDocument } =
  await import("../db/store.js");
const { setXeroForwardingEmail } = await import("./xero.js");
const { forwardReceiptToXero } = await import("./xeroForwarding.js");

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

// Shared SQLite DB across the whole `vitest run` (see test/setup.ts) — phone numbers need a
// prefix no other test file uses. reconciliation.test.ts already claims 44700000-44700002.
function freshPhone(): string {
  counter += 1;
  return `44700003${String(counter).padStart(4, "0")}`;
}

function makeReceiptDoc(ownerId: number) {
  return saveDocument(ownerId, {
    phone: freshPhone(),
    filename: "receipt.pdf",
    mimeType: "application/pdf",
    storedPath: "/tmp/fake",
    caption: null,
    title: "Ryanair Receipt",
    extractedText: "Ryanair - EUR 18.50",
    category: "receipts",
  });
}

beforeEach(() => {
  vi.mocked(sendWhatsAppMessage).mockReset().mockResolvedValue(undefined as never);
  vi.mocked(isWhatsAppConfigured).mockReset().mockReturnValue(true);
  mockHubSendMessage.mockReset().mockResolvedValue({ messageId: "m1", provider: "google", accountEmail: "x" });
});

describe("forwardReceiptToXero", () => {
  it("does nothing when the owner has no Xero address saved", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("xero-fwd-unset"));
    const doc = makeReceiptDoc(user.id);
    await forwardReceiptToXero(user.id, doc, Buffer.from("pdf bytes"));
    expect(mockHubSendMessage).not.toHaveBeenCalled();
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it("sends the file to the saved Xero address via the connected Gmail account, and marks the document forwarded", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("xero-fwd-send"));
    addPhoneNumberForUser(user.id, freshPhone());
    setXeroForwardingEmail(user.id, "abc123@bills.xero.com");
    const account = upsertAccount(user.id, {
      provider: "google",
      email: "user@gmail.com",
      accessToken: "tok",
      refreshToken: "reftok",
      expiryDate: null,
    });
    const doc = makeReceiptDoc(user.id);

    const fileBuffer = Buffer.from("pdf bytes");
    await forwardReceiptToXero(user.id, doc, fileBuffer);

    expect(mockHubSendMessage).toHaveBeenCalledWith(
      user.id,
      account.id,
      "abc123@bills.xero.com",
      "Ryanair Receipt",
      expect.any(String),
      { filename: "receipt.pdf", mimeType: "application/pdf", data: fileBuffer }
    );
    const [phone, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(phone).toBeTruthy();
    expect(text).toContain("Forwarded");
    expect(text).toContain("abc123@bills.xero.com");

    expect(getDocument(user.id, doc.id)?.xeroForwardedAt).toBeTruthy();
  });

  it("skips a document that's already been forwarded, without sending again", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("xero-fwd-already-sent"));
    addPhoneNumberForUser(user.id, freshPhone());
    setXeroForwardingEmail(user.id, "abc123@bills.xero.com");
    upsertAccount(user.id, {
      provider: "google",
      email: "user@gmail.com",
      accessToken: "tok",
      refreshToken: "reftok",
      expiryDate: null,
    });
    const doc = { ...makeReceiptDoc(user.id), xeroForwardedAt: Date.now() };

    await forwardReceiptToXero(user.id, doc, Buffer.from("pdf bytes"));

    expect(mockHubSendMessage).not.toHaveBeenCalled();
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it("notifies the owner instead of throwing when no Gmail account is connected", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("xero-fwd-no-account"));
    addPhoneNumberForUser(user.id, freshPhone());
    setXeroForwardingEmail(user.id, "abc123@bills.xero.com");
    const doc = makeReceiptDoc(user.id);

    await forwardReceiptToXero(user.id, doc, Buffer.from("pdf bytes"));

    expect(mockHubSendMessage).not.toHaveBeenCalled();
    const [, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(text).toContain("couldn't forward");
  });

  it("notifies the owner instead of throwing when the send itself fails, and does not mark it forwarded", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("xero-fwd-send-fails"));
    addPhoneNumberForUser(user.id, freshPhone());
    setXeroForwardingEmail(user.id, "abc123@bills.xero.com");
    upsertAccount(user.id, {
      provider: "google",
      email: "user@gmail.com",
      accessToken: "tok",
      refreshToken: "reftok",
      expiryDate: null,
    });
    mockHubSendMessage.mockRejectedValue(new Error("gmail api down"));
    const doc = makeReceiptDoc(user.id);

    await forwardReceiptToXero(user.id, doc, Buffer.from("pdf bytes"));

    const [, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(text).toContain("failed");
    expect(getDocument(user.id, doc.id)?.xeroForwardedAt).toBeFalsy();
  });
});
