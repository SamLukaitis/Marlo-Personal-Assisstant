// server/src/services/importantEmailAlerts.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../providers/whatsapp.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../providers/whatsapp.js")>();
  return {
    ...actual, // keeps the real WhatsAppSendError class — outbound.ts's `instanceof` check needs it
    sendWhatsAppMessage: vi.fn(),
    sendWhatsAppTemplate: vi.fn(),
    isWhatsAppConfigured: vi.fn().mockReturnValue(true),
  };
});

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

const mockIngestEmailAttachment = vi.fn();
const mockIngestEmailBodyReceipt = vi.fn();
vi.mock("./documents.js", () => ({
  ingestEmailAttachment: (...args: unknown[]) => mockIngestEmailAttachment(...args),
  ingestEmailBodyReceipt: (...args: unknown[]) => mockIngestEmailBodyReceipt(...args),
}));

const { sendWhatsAppMessage, sendWhatsAppTemplate, isWhatsAppConfigured } = await import("../providers/whatsapp.js");
const { findOrCreateUserByEmail, addPhoneNumberForUser, recordInboundMessage, hasAlerted } = await import(
  "../db/store.js"
);
const { checkForImportantEmails, formatImportantEmailAlert } = await import("./importantEmailAlerts.js");
const { setXeroForwardingEmail } = await import("./xero.js");

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

// Registers a number and marks it as having just messaged us — sendProactiveMessage
// (services/outbound.ts) treats a number with no recorded inbound message as outside the
// customer-service window and reaches for a template instead of a free-form send, so tests that
// want to exercise the free-form send path (what these tests were written to check) need this.
function registerActivePhone(ownerId: number): string {
  const phone = freshPhone();
  addPhoneNumberForUser(ownerId, phone);
  recordInboundMessage(phone);
  return phone;
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
  vi.mocked(sendWhatsAppTemplate).mockReset();
  vi.mocked(isWhatsAppConfigured).mockReset().mockReturnValue(true);
  mockHubListMessages.mockReset();
  mockHubGetMessage.mockReset();
  mockClassify.mockReset().mockResolvedValue(new Map());
  mockIngestEmailAttachment.mockReset().mockResolvedValue({ ok: true, alreadyExtracted: false, doc: { id: 1 } });
  mockIngestEmailBodyReceipt.mockReset().mockResolvedValue({ ok: true, doc: { id: 1 } });
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
    registerActivePhone(user.id);
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
    const phone = registerActivePhone(user.id);
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
    const phone = registerActivePhone(user.id);
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
    registerActivePhone(user.id);
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
    registerActivePhone(user.id);
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
    const phone = registerActivePhone(user.id);
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
    const phone = registerActivePhone(user.id);
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

describe("checkForImportantEmails — automatic invoice forwarding", () => {
  it("forwards an attachment automatically when Xero is connected, no confirmation needed", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("invoice-auto-attachment"));
    registerActivePhone(user.id);
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

    expect(mockIngestEmailAttachment).toHaveBeenCalledWith({
      ownerId: user.id,
      accountId: 1,
      messageId: "inv-1",
      attachmentIndex: 1,
    });
    expect(mockIngestEmailBodyReceipt).not.toHaveBeenCalled();
    const [, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(text).toContain("Forwarding to Xero");
  });

  it("forwards a plain-text receipt email automatically when there's no attachment but a real body", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("invoice-auto-body"));
    registerActivePhone(user.id);
    setXeroForwardingEmail(user.id, "abc123@bills.xero.com");
    await baseline(user.id);

    mockHubListMessages.mockResolvedValueOnce([fakeMessage({ id: "inv-text", subject: "Your receipt" })]);
    mockClassify.mockResolvedValueOnce(new Map([[0, "invoice_due"]]));
    mockHubGetMessage.mockResolvedValueOnce({ attachments: [], body: "Thanks for your payment of £22.80." });

    await checkForImportantEmails(user.id);

    expect(mockIngestEmailAttachment).not.toHaveBeenCalled();
    expect(mockIngestEmailBodyReceipt).toHaveBeenCalledWith({
      ownerId: user.id,
      accountId: 1,
      messageId: "inv-text",
      subject: "Your receipt",
      bodyText: "Thanks for your payment of £22.80.",
    });
    const [, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(text).toContain("Forwarding to Xero");
  });

  it("does not forward when Xero isn't connected", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("invoice-no-xero"));
    registerActivePhone(user.id);
    await baseline(user.id);

    mockHubListMessages.mockResolvedValueOnce([fakeMessage({ id: "inv-2" })]);
    mockClassify.mockResolvedValueOnce(new Map([[0, "invoice_due"]]));

    await checkForImportantEmails(user.id);

    expect(mockHubGetMessage).not.toHaveBeenCalled();
    expect(mockIngestEmailAttachment).not.toHaveBeenCalled();
    expect(mockIngestEmailBodyReceipt).not.toHaveBeenCalled();
    const [, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(text).not.toContain("Forwarding");
  });

  it("does not forward when the email has neither an attachment nor a body", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("invoice-no-attachment"));
    registerActivePhone(user.id);
    setXeroForwardingEmail(user.id, "abc123@bills.xero.com");
    await baseline(user.id);

    mockHubListMessages.mockResolvedValueOnce([fakeMessage({ id: "inv-3" })]);
    mockClassify.mockResolvedValueOnce(new Map([[0, "invoice_due"]]));
    mockHubGetMessage.mockResolvedValueOnce({ attachments: [] });

    await checkForImportantEmails(user.id);

    expect(mockIngestEmailAttachment).not.toHaveBeenCalled();
    expect(mockIngestEmailBodyReceipt).not.toHaveBeenCalled();
    const [, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(text).not.toContain("Forwarding");
  });

  it("forwards every invoice_due match independently in the same tick — no single-slot limit", async () => {
    // Unlike the old confirm-based design, there's no pending-state bottleneck anymore: each
    // match can trigger its own forward.
    const user = findOrCreateUserByEmail(uniqueEmail("invoice-multi"));
    registerActivePhone(user.id);
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

    expect(mockHubGetMessage).toHaveBeenCalledTimes(2);
    expect(mockIngestEmailAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "inv-a" })
    );
    expect(mockIngestEmailAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "inv-b" })
    );
    const secondText = vi.mocked(sendWhatsAppMessage).mock.calls[1][1];
    expect(secondText).toContain("Forwarding to Xero");
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
