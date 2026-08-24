import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MatchKeys } from "./reconciliation.js";

vi.mock("../providers/whatsapp.js", () => ({
  sendWhatsAppMessage: vi.fn(),
  isWhatsAppConfigured: vi.fn().mockReturnValue(true),
}));

const mockHubListMessages = vi.fn();
vi.mock("./hub.js", () => ({
  hubListMessages: (...args: unknown[]) => mockHubListMessages(...args),
}));

const { sendWhatsAppMessage, isWhatsAppConfigured } = await import("../providers/whatsapp.js");
const { findOrCreateUserByEmail, saveDocument, addPhoneNumberForUser, hasAlerted, saveMatchKeys } =
  await import("../db/store.js");
const { matchTier, buildMatchNotification, checkDocumentAgainstRecentEmails, checkNewEmailsAgainstRecentDocuments } =
  await import("./reconciliation.js");

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

// All test files share one SQLite database for the whole `vitest run` (see test/setup.ts), and
// user_phone_numbers.phone is UNIQUE — so phone numbers need a prefix no other test file uses,
// not just uniqueness within this file. Existing files already claim "44700000" and "44700001"
// (see pendingRegistration.test.ts / whatsappRegistration.test.ts) — this file uses "44700002".
function freshPhone(): string {
  counter += 1;
  return `44700002${String(counter).padStart(4, "0")}`;
}

function fakeMessage(overrides: Partial<{ id: string; accountId: number; subject: string; snippet: string }>) {
  return {
    id: "msg-1",
    accountId: 1,
    accountEmail: "test@example.com",
    provider: "google" as const,
    subject: "",
    from: "airline@delta.com",
    snippet: "",
    receivedAt: new Date().toISOString(),
    unread: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(sendWhatsAppMessage).mockReset();
  vi.mocked(isWhatsAppConfigured).mockReset().mockReturnValue(true);
  mockHubListMessages.mockReset();
});

describe("checkDocumentAgainstRecentEmails", () => {
  it("notifies when a recent email's subject contains the document's reference code", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("doc-to-email"));
    const phoneNumber = freshPhone();
    addPhoneNumberForUser(user.id, phoneNumber);
    const doc = saveDocument(user.id, {
      phone: phoneNumber,
      filename: null,
      mimeType: "image/jpeg",
      storedPath: "/tmp/fake",
      caption: null,
      title: "Delta Boarding Pass",
      extractedText: "text",
      category: "travel",
    });
    mockHubListMessages.mockResolvedValue([
      fakeMessage({ id: "m1", subject: "Update on ref K4X9QP" }),
    ]);

    await checkDocumentAgainstRecentEmails(user.id, doc.id, doc.title!, { referenceCode: "K4X9QP" });

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    const [phone, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(phone).toBe(phoneNumber);
    expect(text).toContain("Delta Boarding Pass");
  });

  it("does not notify when no recent email matches", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("doc-to-email-nomatch"));
    const phoneNumber = freshPhone();
    addPhoneNumberForUser(user.id, phoneNumber);
    const doc = saveDocument(user.id, {
      phone: phoneNumber,
      filename: null,
      mimeType: "image/jpeg",
      storedPath: "/tmp/fake",
      caption: null,
      title: "Delta Boarding Pass",
      extractedText: "text",
      category: "travel",
    });
    mockHubListMessages.mockResolvedValue([fakeMessage({ id: "m2", subject: "Your Amazon order shipped" })]);

    await checkDocumentAgainstRecentEmails(user.id, doc.id, doc.title!, { referenceCode: "K4X9QP" });

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it("leaves a match unmarked (retriable) when delivery fails, so a later call can still find it", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("doc-to-email-delivery-fail"));
    const phoneNumber = freshPhone();
    addPhoneNumberForUser(user.id, phoneNumber);
    const doc = saveDocument(user.id, {
      phone: phoneNumber,
      filename: null,
      mimeType: "image/jpeg",
      storedPath: "/tmp/fake",
      caption: null,
      title: "Delta Boarding Pass",
      extractedText: "text",
      category: "travel",
    });
    mockHubListMessages.mockResolvedValue([fakeMessage({ id: "m-fail", subject: "Update on ref K4X9QP" })]);
    vi.mocked(sendWhatsAppMessage).mockRejectedValue(new Error("network down"));

    await checkDocumentAgainstRecentEmails(user.id, doc.id, doc.title!, { referenceCode: "K4X9QP" });

    const matchKey = `recon-match:${doc.id}:${1}:m-fail`;
    expect(hasAlerted(user.id, matchKey)).toBe(false);
  });

  it("leaves a match unmarked (retriable) when WhatsApp isn't configured", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("doc-to-email-not-configured"));
    const phoneNumber = freshPhone();
    addPhoneNumberForUser(user.id, phoneNumber);
    const doc = saveDocument(user.id, {
      phone: phoneNumber,
      filename: null,
      mimeType: "image/jpeg",
      storedPath: "/tmp/fake",
      caption: null,
      title: "Delta Boarding Pass",
      extractedText: "text",
      category: "travel",
    });
    mockHubListMessages.mockResolvedValue([fakeMessage({ id: "m-noconfig", subject: "Update on ref K4X9QP" })]);
    vi.mocked(isWhatsAppConfigured).mockReturnValue(false);

    await checkDocumentAgainstRecentEmails(user.id, doc.id, doc.title!, { referenceCode: "K4X9QP" });

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    const matchKey = `recon-match:${doc.id}:${1}:m-noconfig`;
    expect(hasAlerted(user.id, matchKey)).toBe(false);
  });

  it("does not notify twice for the same document/email pair", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("doc-to-email-dedup"));
    const phoneNumber = freshPhone();
    addPhoneNumberForUser(user.id, phoneNumber);
    const doc = saveDocument(user.id, {
      phone: phoneNumber,
      filename: null,
      mimeType: "image/jpeg",
      storedPath: "/tmp/fake",
      caption: null,
      title: "Delta Boarding Pass",
      extractedText: "text",
      category: "travel",
    });
    mockHubListMessages.mockResolvedValue([fakeMessage({ id: "m3", subject: "Update on ref K4X9QP" })]);

    await checkDocumentAgainstRecentEmails(user.id, doc.id, doc.title!, { referenceCode: "K4X9QP" });
    await checkDocumentAgainstRecentEmails(user.id, doc.id, doc.title!, { referenceCode: "K4X9QP" });

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
  });

  it("does nothing and never calls hubListMessages when there is no reference code or flight number", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("doc-to-email-nokeys"));
    const doc = saveDocument(user.id, {
      phone: freshPhone(),
      filename: null,
      mimeType: "image/jpeg",
      storedPath: "/tmp/fake",
      caption: null,
      title: "Vendor Only Doc",
      extractedText: "text",
      category: "travel",
    });

    await checkDocumentAgainstRecentEmails(user.id, doc.id, doc.title!, { vendor: "Delta" });

    expect(mockHubListMessages).not.toHaveBeenCalled();
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });
});

describe("checkNewEmailsAgainstRecentDocuments", () => {
  it("notifies when a new email's subject contains a recent document's reference code", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("email-to-doc"));
    const phoneNumber = freshPhone();
    addPhoneNumberForUser(user.id, phoneNumber);
    const doc = saveDocument(user.id, {
      phone: phoneNumber,
      filename: null,
      mimeType: "image/jpeg",
      storedPath: "/tmp/fake",
      caption: null,
      title: "Hilton Booking",
      extractedText: "text",
      category: "receipts_bookings",
    });
    saveMatchKeys(user.id, doc.id, { referenceCode: "H9ZZ21" });

    mockHubListMessages.mockResolvedValue([fakeMessage({ id: "m10", subject: "Change to booking H9ZZ21" })]);

    await checkNewEmailsAgainstRecentDocuments(user.id);

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    const [, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(text).toContain("Hilton Booking");
  });

  it("only scans each email once across repeated ticks, regardless of match outcome", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("email-to-doc-scan-once"));
    mockHubListMessages.mockResolvedValue([fakeMessage({ id: "m11", subject: "Nothing relevant here" })]);

    await checkNewEmailsAgainstRecentDocuments(user.id);
    await checkNewEmailsAgainstRecentDocuments(user.id);

    expect(hasAlerted(user.id, "recon-scan:1:m11")).toBe(true);
    // No crash, no duplicate work observable from the outside — the real assertion is that a
    // second identical tick doesn't re-notify, covered by the dedup test below with an actual match.
  });

  it("does not notify twice for the same email/document pair across ticks", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("email-to-doc-dedup"));
    const phoneNumber = freshPhone();
    addPhoneNumberForUser(user.id, phoneNumber);
    const doc = saveDocument(user.id, {
      phone: phoneNumber,
      filename: null,
      mimeType: "image/jpeg",
      storedPath: "/tmp/fake",
      caption: null,
      title: "Hilton Booking",
      extractedText: "text",
      category: "receipts_bookings",
    });
    saveMatchKeys(user.id, doc.id, { referenceCode: "H9ZZ22" });
    mockHubListMessages.mockResolvedValue([fakeMessage({ id: "m12", subject: "Change to booking H9ZZ22" })]);

    await checkNewEmailsAgainstRecentDocuments(user.id);
    mockHubListMessages.mockResolvedValue([fakeMessage({ id: "m12", subject: "Change to booking H9ZZ22" })]);
    await checkNewEmailsAgainstRecentDocuments(user.id);

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
  });

  it("leaves a match unmarked (retriable) when delivery fails, so a later tick can still find it", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("email-to-doc-delivery-fail"));
    const phoneNumber = freshPhone();
    addPhoneNumberForUser(user.id, phoneNumber);
    const doc = saveDocument(user.id, {
      phone: phoneNumber,
      filename: null,
      mimeType: "image/jpeg",
      storedPath: "/tmp/fake",
      caption: null,
      title: "Hilton Booking",
      extractedText: "text",
      category: "receipts_bookings",
    });
    saveMatchKeys(user.id, doc.id, { referenceCode: "H9ZZ23" });
    mockHubListMessages.mockResolvedValue([fakeMessage({ id: "m13", subject: "Change to booking H9ZZ23" })]);
    vi.mocked(sendWhatsAppMessage).mockRejectedValue(new Error("network down"));

    await checkNewEmailsAgainstRecentDocuments(user.id);

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    const matchKey = `recon-match:${doc.id}:1:m13`;
    expect(hasAlerted(user.id, matchKey)).toBe(false);
    // The scan itself is still marked regardless of delivery outcome — only the match dedup
    // needs to stay retriable.
    expect(hasAlerted(user.id, "recon-scan:1:m13")).toBe(true);
  });
});

describe("matchTier", () => {
  it("matches on an exact reference code, case-insensitively", () => {
    const keys: MatchKeys = { referenceCode: "K4X9QP" };
    expect(matchTier(keys, "Your trip is confirmed, ref k4x9qp, departing soon.")).toBe("strong");
  });

  it("matches on an exact flight number", () => {
    const keys: MatchKeys = { flightNumber: "DL1234" };
    expect(matchTier(keys, "Update on your flight DL1234 to Berlin")).toBe("strong");
  });

  it("returns null when neither identifier appears in the text", () => {
    const keys: MatchKeys = { referenceCode: "K4X9QP", flightNumber: "DL1234" };
    expect(matchTier(keys, "Your Amazon order has shipped")).toBeNull();
  });

  it("returns null when there is no reference code or flight number to check, even if vendor/date match", () => {
    const keys: MatchKeys = { vendor: "Delta", eventDate: "2026-09-12" };
    expect(matchTier(keys, "Delta flight update, 2026-09-12")).toBeNull();
  });

  it("ignores identifiers shorter than the minimum length to avoid false positives", () => {
    const keys: MatchKeys = { flightNumber: "AA1" };
    expect(matchTier(keys, "AA1 is mentioned right here")).toBeNull();
  });

  it("returns null for an empty MatchKeys object", () => {
    expect(matchTier({}, "any text at all")).toBeNull();
  });
});

describe("buildMatchNotification", () => {
  it("includes the document title, identifier, and date", () => {
    const msg = buildMatchNotification("Delta Boarding Pass", { flightNumber: "DL1234", eventDate: "2026-09-12" });
    expect(msg).toContain("Delta Boarding Pass");
    expect(msg).toContain("DL1234");
    expect(msg).toContain("2026-09-12");
  });

  it("prefers referenceCode over flightNumber when both are present", () => {
    const msg = buildMatchNotification("Hotel Booking", { referenceCode: "K4X9QP", flightNumber: "DL1234" });
    expect(msg).toContain("K4X9QP");
    expect(msg).not.toContain("DL1234");
  });

  it("omits a stray date segment when eventDate is absent", () => {
    const msg = buildMatchNotification("Hotel Booking", { referenceCode: "K4X9QP" });
    expect(msg).not.toContain("undefined");
  });
});
