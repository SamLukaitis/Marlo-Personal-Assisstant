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

const { sendWhatsAppMessage, sendWhatsAppTemplate, isWhatsAppConfigured } = await import("../providers/whatsapp.js");
const { findOrCreateUserByEmail, addPhoneNumberForUser, recordInboundMessage, hasAlerted } = await import(
  "../db/store.js"
);
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
    mockClassify.mockResolvedValueOnce(
      new Map([[0, { category: "flight_change", summary: "Your gate moved to B12." }]])
    );

    await checkForImportantEmails(user.id);

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    const [sentTo, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(sentTo).toBe(phone);
    expect(text).toContain("✈️");
    expect(text).toContain("Your flight changed");
    expect(text).toContain("Your gate moved to B12.");
    expect(hasAlerted(user.id, "important-email:1:flight-1")).toBe(true);
  });

  it("does not re-classify or re-alert the same message on a later tick", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("dedup"));
    const phone = registerActivePhone(user.id);
    await baseline(user.id);

    mockHubListMessages.mockResolvedValue([fakeMessage({ id: "flight-2" })]);
    mockClassify.mockResolvedValue(new Map([[0, { category: "flight_change", summary: "" }]]));

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
    mockClassify.mockResolvedValueOnce(new Map([[0, { category: "invoice_due", summary: "" }]]));
    vi.mocked(sendWhatsAppMessage).mockRejectedValueOnce(new Error("network down"));

    await checkForImportantEmails(user.id);

    expect(hasAlerted(user.id, "important-email:1:fail-1")).toBe(false);
  });

  it("leaves a matched message unmarked when WhatsApp isn't configured", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("not-configured"));
    await baseline(user.id);

    mockHubListMessages.mockResolvedValueOnce([fakeMessage({ id: "noconfig-1" })]);
    mockClassify.mockResolvedValueOnce(new Map([[0, { category: "invoice_due", summary: "" }]]));
    vi.mocked(isWhatsAppConfigured).mockReturnValue(false);

    await checkForImportantEmails(user.id);

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(hasAlerted(user.id, "important-email:1:noconfig-1")).toBe(false);
  });

  it("leaves a matched message unmarked when the user has no registered phone numbers", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("no-numbers"));
    await baseline(user.id);

    mockHubListMessages.mockResolvedValueOnce([fakeMessage({ id: "nonum-1" })]);
    mockClassify.mockResolvedValueOnce(new Map([[0, { category: "invoice_due", summary: "" }]]));

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
    const classified = new Map<number, { category: "invoice_due"; summary: string }>();
    for (let i = 0; i < 6; i++) classified.set(i, { category: "invoice_due", summary: "" });
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
    const phone = registerActivePhone(user.id);
    setXeroForwardingEmail(user.id, "abc123@bills.xero.com");
    await baseline(user.id);

    mockHubListMessages.mockResolvedValueOnce([
      fakeMessage({ id: "inv-1", subject: "Invoice from Acme" }),
    ]);
    mockClassify.mockResolvedValueOnce(new Map([[0, { category: "invoice_due", summary: "" }]]));
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
    registerActivePhone(user.id);
    await baseline(user.id);

    mockHubListMessages.mockResolvedValueOnce([fakeMessage({ id: "inv-2" })]);
    mockClassify.mockResolvedValueOnce(new Map([[0, { category: "invoice_due", summary: "" }]]));

    await checkForImportantEmails(user.id);

    expect(mockHubGetMessage).not.toHaveBeenCalled();
    const [, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(text).not.toContain("Reply");
    expect(getPendingInvoiceForward(user.id)).toBeNull();
  });

  it("does not offer to forward when the email has neither an attachment nor a body", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("invoice-no-attachment"));
    registerActivePhone(user.id);
    setXeroForwardingEmail(user.id, "abc123@bills.xero.com");
    await baseline(user.id);

    mockHubListMessages.mockResolvedValueOnce([fakeMessage({ id: "inv-3" })]);
    mockClassify.mockResolvedValueOnce(new Map([[0, { category: "invoice_due", summary: "" }]]));
    mockHubGetMessage.mockResolvedValueOnce({ attachments: [] });

    await checkForImportantEmails(user.id);

    const [, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(text).not.toContain("Reply");
    expect(getPendingInvoiceForward(user.id)).toBeNull();
  });

  it("offers to forward a plain-text receipt email (no attachment, but a real body)", async () => {
    // e.g. a subscription renewal notice where the whole receipt is in the email text itself —
    // handled by ingestEmailBodyReceipt on confirm, not ingestEmailAttachment.
    const user = findOrCreateUserByEmail(uniqueEmail("invoice-body-only"));
    registerActivePhone(user.id);
    setXeroForwardingEmail(user.id, "abc123@bills.xero.com");
    await baseline(user.id);

    mockHubListMessages.mockResolvedValueOnce([fakeMessage({ id: "inv-text", subject: "Your receipt" })]);
    mockClassify.mockResolvedValueOnce(new Map([[0, { category: "invoice_due", summary: "" }]]));
    mockHubGetMessage.mockResolvedValueOnce({ attachments: [], body: "Thanks for your payment of £22.80." });

    await checkForImportantEmails(user.id);

    const [, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(text).toContain('Reply "yes"');
    expect(getPendingInvoiceForward(user.id)).toMatchObject({ messageId: "inv-text" });
  });

  it("only offers the CTA once per tick even with multiple invoice_due matches", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("invoice-single-slot"));
    registerActivePhone(user.id);
    setXeroForwardingEmail(user.id, "abc123@bills.xero.com");
    await baseline(user.id);

    mockHubListMessages.mockResolvedValueOnce([
      fakeMessage({ id: "inv-a", subject: "Invoice A" }),
      fakeMessage({ id: "inv-b", subject: "Invoice B" }),
    ]);
    mockClassify.mockResolvedValueOnce(
      new Map([
        [0, { category: "invoice_due", summary: "" }],
        [1, { category: "invoice_due", summary: "" }],
      ])
    );
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
    registerActivePhone(user.id);
    setXeroForwardingEmail(user.id, "abc123@bills.xero.com");
    await baseline(user.id);

    mockHubListMessages.mockResolvedValueOnce([fakeMessage({ id: "inv-4" })]);
    mockClassify.mockResolvedValueOnce(new Map([[0, { category: "invoice_due", summary: "" }]]));
    mockHubGetMessage.mockResolvedValueOnce({
      attachments: [{ id: "att-1", filename: "invoice.pdf", mimeType: "application/pdf", size: 100 }],
    });
    vi.mocked(sendWhatsAppMessage).mockRejectedValueOnce(new Error("network down"));

    await checkForImportantEmails(user.id);

    expect(getPendingInvoiceForward(user.id)).toBeNull();
  });
});

describe("formatImportantEmailAlert", () => {
  it("falls back to the raw snippet when no summary is given", () => {
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

  it("prefers the model-written summary over the raw snippet when given", () => {
    const text = formatImportantEmailAlert(
      fakeMessage({
        subject: "Your invoice is due",
        from: "billing@vendor.com",
        snippet: "You&#39;ve got an invoice&hellip; view it here...",
      }),
      "invoice_due",
      "£120 is due on 1 September."
    );
    expect(text).toContain("£120 is due on 1 September.");
    expect(text).not.toContain("&#39;");
  });
});
