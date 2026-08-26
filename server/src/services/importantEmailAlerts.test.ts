// server/src/services/importantEmailAlerts.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../providers/whatsapp.js", () => ({
  sendWhatsAppMessage: vi.fn(),
  isWhatsAppConfigured: vi.fn().mockReturnValue(true),
}));

const mockHubListMessages = vi.fn();
const mockHubGetMessage = vi.fn();
vi.mock("./hub.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./hub.js")>();
  return {
    ...actual,
    hubListMessages: (...args: unknown[]) => mockHubListMessages(...args),
    hubGetMessage: (...args: unknown[]) => mockHubGetMessage(...args),
  };
});

const mockClassify = vi.fn();
vi.mock("./importantEmailClassifier.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./importantEmailClassifier.js")>();
  return { ...actual, classifyImportantEmails: (...args: unknown[]) => mockClassify(...args) };
});

const { sendWhatsAppMessage, isWhatsAppConfigured } = await import("../providers/whatsapp.js");
const { findOrCreateUserByEmail, addPhoneNumberForUser, hasAlerted } = await import("../db/store.js");
const { checkForImportantEmails, formatImportantEmailAlert } = await import("./importantEmailAlerts.js");
const { setXeroForwardingEmail } = await import("./xero.js");
const { getPendingInvoiceForward } = await import("./xeroInvoiceConfirmation.js");

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

// All test files share one SQLite database for the whole `vitest run` (see test/setup.ts), and
// user_phone_numbers.phone is UNIQUE. Existing files already claim 44700000-44700004 (see
// pendingRegistration.test.ts, whatsappRegistration.test.ts, reconciliation.test.ts,
// xeroForwarding.test.ts, memoryReminders.test.ts) — this file uses 44700005.
function freshPhone(): string {
  counter += 1;
  return `44700005${String(counter).padStart(4, "0")}`;
}

function fakeMessage(
  overrides: Partial<{
    id: string;
    accountId: number;
    subject: string;
    snippet: string;
    from: string;
    unread: boolean;
  }>
) {
  return {
    id: "msg-1",
    accountId: 1,
    accountEmail: "test@example.com",
    provider: "google" as const,
    subject: "",
    from: "no-reply@delta.com",
    snippet: "",
    receivedAt: new Date().toISOString(),
    unread: true,
    ...overrides,
  };
}

async function baseline(ownerId: number) {
  mockHubListMessages.mockResolvedValueOnce([]);
  await checkForImportantEmails(ownerId);
}

beforeEach(() => {
  vi.mocked(sendWhatsAppMessage).mockReset();
  vi.mocked(isWhatsAppConfigured).mockReset().mockReturnValue(true);
  mockHubListMessages.mockReset();
  mockHubGetMessage.mockReset();
  mockClassify.mockReset().mockResolvedValue(new Map());
});

describe("checkForImportantEmails", () => {
  it("baselines the existing inbox on first run without classifying or notifying", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("baseline"));
    mockHubListMessages.mockResolvedValueOnce([fakeMessage({ id: "old-1" })]);

    await checkForImportantEmails(user.id);

    expect(mockClassify).not.toHaveBeenCalled();
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(hasAlerted(user.id, "important-email:1:old-1")).toBe(true);
  });

  it("filters to unread automated-sender mail only, ignoring read mail and mail from real people", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("filter"));
    addPhoneNumberForUser(user.id, freshPhone());
    await baseline(user.id);

    mockHubListMessages.mockResolvedValueOnce([
      fakeMessage({ id: "read", unread: false, from: "no-reply@delta.com" }),
      fakeMessage({ id: "real-person", unread: true, from: "jane@example.com" }),
      fakeMessage({ id: "candidate", unread: true, from: "no-reply@delta.com", subject: "Flight change" }),
    ]);

    await checkForImportantEmails(user.id);

    expect(mockClassify).toHaveBeenCalledTimes(1);
    const [candidates] = mockClassify.mock.calls[0];
    expect(candidates).toEqual([{ index: 0, subject: "Flight change", snippet: "" }]);
  });

  it("sends a WhatsApp alert for a classified match, formatted with the category", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("match"));
    const phone = freshPhone();
    addPhoneNumberForUser(user.id, phone);
    await baseline(user.id);

    mockHubListMessages.mockResolvedValueOnce([
      fakeMessage({ id: "flight-1", subject: "Your flight changed" }),
    ]);
    mockClassify.mockResolvedValueOnce(new Map([[0, "flight_change"]]));

    await checkForImportantEmails(user.id);

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    const [sentTo, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(sentTo).toBe(phone);
    expect(text).toContain("✈️");
    expect(text).toContain("Your flight changed");
    expect(hasAlerted(user.id, "important-email:1:flight-1")).toBe(true);
  });

  it("does not re-classify or re-alert the same message on a later tick", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("dedup"));
    const phone = freshPhone();
    addPhoneNumberForUser(user.id, phone);
    await baseline(user.id);

    mockHubListMessages.mockResolvedValue([fakeMessage({ id: "flight-2" })]);
    mockClassify.mockResolvedValue(new Map([[0, "flight_change"]]));

    await checkForImportantEmails(user.id);
    await checkForImportantEmails(user.id);

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    expect(mockClassify).toHaveBeenCalledTimes(1);
  });

  it("marks a non-matching candidate scanned so it isn't reclassified next tick", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("nonmatch"));
    addPhoneNumberForUser(user.id, freshPhone());
    await baseline(user.id);

    mockHubListMessages.mockResolvedValue([fakeMessage({ id: "boring-1" })]);
    mockClassify.mockResolvedValue(new Map());

    await checkForImportantEmails(user.id);
    await checkForImportantEmails(user.id);

    expect(hasAlerted(user.id, "important-email:1:boring-1")).toBe(true);
    expect(mockClassify).toHaveBeenCalledTimes(1);
  });

  it("leaves everything unscanned when classification itself fails", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("classify-fail"));
    addPhoneNumberForUser(user.id, freshPhone());
    await baseline(user.id);

    mockHubListMessages.mockResolvedValueOnce([fakeMessage({ id: "err-1" })]);
    mockClassify.mockRejectedValueOnce(new Error("API down"));

    await checkForImportantEmails(user.id);

    expect(mockClassify).toHaveBeenCalledTimes(1);
    expect(hasAlerted(user.id, "important-email:1:err-1")).toBe(false);
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it("leaves a matched message unmarked (retriable) when delivery fails", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("deliver-fail"));
    const phone = freshPhone();
    addPhoneNumberForUser(user.id, phone);
    await baseline(user.id);

    mockHubListMessages.mockResolvedValueOnce([fakeMessage({ id: "fail-1" })]);
    mockClassify.mockResolvedValueOnce(new Map([[0, "invoice_due"]]));
    vi.mocked(sendWhatsAppMessage).mockRejectedValueOnce(new Error("network down"));

    await checkForImportantEmails(user.id);

    expect(hasAlerted(user.id, "important-email:1:fail-1")).toBe(false);
  });

  it("leaves a matched message unmarked when WhatsApp isn't configured", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("not-configured"));
    await baseline(user.id);

    mockHubListMessages.mockResolvedValueOnce([fakeMessage({ id: "noconfig-1" })]);
    mockClassify.mockResolvedValueOnce(new Map([[0, "invoice_due"]]));
    vi.mocked(isWhatsAppConfigured).mockReturnValue(false);

    await checkForImportantEmails(user.id);

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(hasAlerted(user.id, "important-email:1:noconfig-1")).toBe(false);
  });

  it("leaves a matched message unmarked when the user has no registered phone numbers", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("no-numbers"));
    await baseline(user.id);

    mockHubListMessages.mockResolvedValueOnce([fakeMessage({ id: "nonum-1" })]);
    mockClassify.mockResolvedValueOnce(new Map([[0, "invoice_due"]]));

    await checkForImportantEmails(user.id);

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(hasAlerted(user.id, "important-email:1:nonum-1")).toBe(false);
  });

  it("caps alerts per tick and sends a summary for the overflow", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("cap"));
    const phone = freshPhone();
    addPhoneNumberForUser(user.id, phone);
    await baseline(user.id);

    // MAX_ALERTS_PER_CHECK is 5 — six matches means the sixth goes into the overflow summary.
    const messages = Array.from({ length: 6 }, (_, i) =>
      fakeMessage({ id: `cap-${i}`, subject: `Notice ${i}` })
    );
    mockHubListMessages.mockResolvedValueOnce(messages);
    const classified = new Map<number, "invoice_due">();
    for (let i = 0; i < 6; i++) classified.set(i, "invoice_due");
    mockClassify.mockResolvedValueOnce(classified);

    await checkForImportantEmails(user.id);

    // 5 individual alerts + 1 overflow summary = 6 sends.
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(6);
    const lastCall = vi.mocked(sendWhatsAppMessage).mock.calls[5];
    expect(lastCall[1]).toContain("1 more");
    for (let i = 0; i < 6; i++) {
      expect(hasAlerted(user.id, `important-email:1:cap-${i}`)).toBe(true);
    }
  });
});

describe("checkForImportantEmails — invoice forward offer", () => {
  it("offers to forward and sets pending state when Xero is connected and the email has an attachment", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("invoice-offer"));
    const phone = freshPhone();
    addPhoneNumberForUser(user.id, phone);
    setXeroForwardingEmail(user.id, "abc123@bills.xero.com");
    await baseline(user.id);

    mockHubListMessages.mockResolvedValueOnce([
      fakeMessage({ id: "inv-1", subject: "Invoice from Acme" }),
    ]);
    mockClassify.mockResolvedValueOnce(new Map([[0, "invoice_due"]]));
    mockHubGetMessage.mockResolvedValueOnce({
      attachments: [{ id: "att-1", filename: "invoice.pdf", mimeType: "application/pdf", size: 100 }],
    });

    await checkForImportantEmails(user.id);

    const [, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(text).toContain('Reply "yes"');
    expect(getPendingInvoiceForward(user.id)).toMatchObject({
      accountId: 1,
      messageId: "inv-1",
      subject: "Invoice from Acme",
    });
  });

  it("does not offer to forward when Xero isn't connected", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("invoice-no-xero"));
    addPhoneNumberForUser(user.id, freshPhone());
    await baseline(user.id);

    mockHubListMessages.mockResolvedValueOnce([fakeMessage({ id: "inv-2" })]);
    mockClassify.mockResolvedValueOnce(new Map([[0, "invoice_due"]]));

    await checkForImportantEmails(user.id);

    expect(mockHubGetMessage).not.toHaveBeenCalled();
    const [, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(text).not.toContain("Reply");
    expect(getPendingInvoiceForward(user.id)).toBeNull();
  });

  it("does not offer to forward when the email has no attachment", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("invoice-no-attachment"));
    addPhoneNumberForUser(user.id, freshPhone());
    setXeroForwardingEmail(user.id, "abc123@bills.xero.com");
    await baseline(user.id);

    mockHubListMessages.mockResolvedValueOnce([fakeMessage({ id: "inv-3" })]);
    mockClassify.mockResolvedValueOnce(new Map([[0, "invoice_due"]]));
    mockHubGetMessage.mockResolvedValueOnce({ attachments: [] });

    await checkForImportantEmails(user.id);

    const [, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(text).not.toContain("Reply");
    expect(getPendingInvoiceForward(user.id)).toBeNull();
  });

  it("only offers the CTA once per tick even with multiple invoice_due matches", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("invoice-single-slot"));
    addPhoneNumberForUser(user.id, freshPhone());
    setXeroForwardingEmail(user.id, "abc123@bills.xero.com");
    await baseline(user.id);

    mockHubListMessages.mockResolvedValueOnce([
      fakeMessage({ id: "inv-a", subject: "Invoice A" }),
      fakeMessage({ id: "inv-b", subject: "Invoice B" }),
    ]);
    mockClassify.mockResolvedValueOnce(new Map([[0, "invoice_due"], [1, "invoice_due"]]));
    mockHubGetMessage.mockResolvedValue({
      attachments: [{ id: "att-1", filename: "invoice.pdf", mimeType: "application/pdf", size: 100 }],
    });

    await checkForImportantEmails(user.id);

    expect(mockHubGetMessage).toHaveBeenCalledTimes(1);
    const secondText = vi.mocked(sendWhatsAppMessage).mock.calls[1][1];
    expect(secondText).not.toContain("Reply");
    expect(getPendingInvoiceForward(user.id)).toMatchObject({ messageId: "inv-a" });
  });

  it("does not set pending state when delivery of the offer fails", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("invoice-deliver-fail"));
    addPhoneNumberForUser(user.id, freshPhone());
    setXeroForwardingEmail(user.id, "abc123@bills.xero.com");
    await baseline(user.id);

    mockHubListMessages.mockResolvedValueOnce([fakeMessage({ id: "inv-4" })]);
    mockClassify.mockResolvedValueOnce(new Map([[0, "invoice_due"]]));
    mockHubGetMessage.mockResolvedValueOnce({
      attachments: [{ id: "att-1", filename: "invoice.pdf", mimeType: "application/pdf", size: 100 }],
    });
    vi.mocked(sendWhatsAppMessage).mockRejectedValueOnce(new Error("network down"));

    await checkForImportantEmails(user.id);

    expect(getPendingInvoiceForward(user.id)).toBeNull();
  });
});

describe("formatImportantEmailAlert", () => {
  it("includes the category emoji, label, subject, sender, and snippet", () => {
    const text = formatImportantEmailAlert(
      fakeMessage({
        subject: "Your invoice is due",
        from: "billing@vendor.com",
        snippet: "£120 due 1 Sep",
      }),
      "invoice_due"
    );
    expect(text).toContain("💳");
    expect(text).toContain("Invoice/payment due");
    expect(text).toContain("Your invoice is due");
    expect(text).toContain("billing@vendor.com");
    expect(text).toContain("£120 due 1 Sep");
  });
});
