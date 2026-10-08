import { describe, it, expect, vi, beforeEach } from "vitest";
import { type MatchKeys } from "./reconciliation.js";

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
const mockHubListNewMessages = vi.fn();
const mockHoldCheckpoint = vi.fn();
vi.mock("./hub.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./hub.js")>();
  return {
    ...actual,
    hubListMessages: (...args: unknown[]) => mockHubListMessages(...args),
    hubListNewMessages: (...args: unknown[]) => mockHubListNewMessages(...args),
    holdNewMessageCheckpoint: (...args: unknown[]) => mockHoldCheckpoint(...args),
  };
});

const { sendWhatsAppMessage, sendWhatsAppTemplate, isWhatsAppConfigured } = await import("../providers/whatsapp.js");
const {
  findOrCreateUserByEmail,
  saveDocument,
  addPhoneNumberForUser,
  recordInboundMessage,
  hasAlerted,
  saveMatchKeys,
  getAttentionItem,
  listAttentionItems,
} = await import("../db/store.js");
const { matchTier, checkNewEmailsAgainstRecentDocuments } = await import("./reconciliation.js");
const { submitAttentionItem } = await import("./attention.js");

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

// A user with a WhatsApp number that's inside the customer-service window (so alerts go out as
// plain messages) and one saved document indexed under `referenceCode`.
function seedUserWithDocument(prefix: string, title: string, referenceCode: string) {
  const user = findOrCreateUserByEmail(uniqueEmail(prefix));
  const phoneNumber = freshPhone();
  addPhoneNumberForUser(user.id, phoneNumber);
  recordInboundMessage(phoneNumber);
  const doc = saveDocument(user.id, {
    phone: phoneNumber,
    filename: null,
    mimeType: "image/jpeg",
    storedPath: "/tmp/fake",
    caption: null,
    title,
    extractedText: "text",
    category: "travel",
  });
  saveMatchKeys(user.id, doc.id, { referenceCode });
  return { user, phoneNumber, doc };
}

beforeEach(() => {
  vi.mocked(sendWhatsAppMessage).mockReset();
  vi.mocked(sendWhatsAppTemplate).mockReset();
  vi.mocked(isWhatsAppConfigured).mockReset().mockReturnValue(true);
  mockHubListMessages.mockReset();
  mockHubListNewMessages.mockReset();
  mockHoldCheckpoint.mockReset();
});

describe("checkNewEmailsAgainstRecentDocuments", () => {


  it("records a matching email against the document's event, without messaging", async () => {
    const { user } = seedUserWithDocument("email-to-doc", "Hilton Booking", "H9ZZ21");
    mockHubListNewMessages.mockResolvedValue([fakeMessage({ id: "m10", subject: "Change to booking H9ZZ21" })]);

    await checkNewEmailsAgainstRecentDocuments(user.id);

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    const row = getAttentionItem(user.id, "ref:H9ZZ21");
    expect(row?.category).toBe("document_match");
    expect(row?.details.summary).toBe('*Hilton Booking* — new email: "Change to booking H9ZZ21"');
    expect(hasAlerted(user.id, "recon-scan:1:m10")).toBe(true);
  });

  it("merges into an existing item for the same booking instead of adding one", async () => {
    const { user } = seedUserWithDocument("email-to-doc-merge", "Hotel Eva", "EVA12345");
    await submitAttentionItem(user.id, {
      source: "email",
      category: "reservation_confirmed",
      details: { summary: "Your *Hotel Eva* stay, ref *EVA12345*.", kind: "hotel", eventStart: "2099-01-01", reference: "EVA12345" },
      fallbackKey: "msg:1:orig",
    });
    mockHubListNewMessages.mockResolvedValue([fakeMessage({ id: "e2", subject: "EVA12345 — see you soon" })]);

    await checkNewEmailsAgainstRecentDocuments(user.id);

    expect(listAttentionItems(user.id)).toHaveLength(1);
    expect(getAttentionItem(user.id, "ref:EVA12345")?.details.summary).toBe("Your *Hotel Eva* stay, ref *EVA12345*.");
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it("records an email once, even when more than one saved document matches it", async () => {
    const { user, phoneNumber } = seedUserWithDocument("email-to-doc-two-docs", "Boarding Pass", "V9TWO1");
    const secondDoc = saveDocument(user.id, {
      phone: phoneNumber,
      filename: null,
      mimeType: "image/jpeg",
      storedPath: "/tmp/fake",
      caption: null,
      title: "Boarding Pass Screenshot",
      extractedText: "text",
      category: "travel",
    });
    saveMatchKeys(user.id, secondDoc.id, { referenceCode: "V9TWO1" });
    mockHubListNewMessages.mockResolvedValue([fakeMessage({ id: "two-1", subject: "Gate change for V9TWO1" })]);

    await checkNewEmailsAgainstRecentDocuments(user.id);
    await checkNewEmailsAgainstRecentDocuments(user.id);

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(listAttentionItems(user.id)).toHaveLength(1);
  });

  it("only scans each email once across repeated ticks, regardless of match outcome", async () => {
    const { user } = seedUserWithDocument("email-to-doc-scan-once", "Unrelated Doc", "ZZNOMATCH1");
    mockHubListNewMessages.mockResolvedValue([fakeMessage({ id: "m11", subject: "Nothing relevant here" })]);

    await checkNewEmailsAgainstRecentDocuments(user.id);
    await checkNewEmailsAgainstRecentDocuments(user.id);

    expect(hasAlerted(user.id, "recon-scan:1:m11")).toBe(true);
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it("returns without calling hubListNewMessages when the user has no recent match keys at all", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("email-to-doc-no-keys"));

    await checkNewEmailsAgainstRecentDocuments(user.id);

    expect(mockHubListNewMessages).not.toHaveBeenCalled();
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });






  // It runs on the scheduler tick and only acts on mail it hasn't scanned before, so it shares
  // hub.ts's incremental hubListNewMessages rather than re-listing a fixed window of old mail.
  it("uses the incremental hubListNewMessages, not a fixed-limit list", async () => {
    const { user } = seedUserWithDocument("scan-depth-email", "Some Booking", "EFGH5678");
    mockHubListNewMessages.mockResolvedValue([]);

    await checkNewEmailsAgainstRecentDocuments(user.id);

    expect(mockHubListNewMessages).toHaveBeenCalledWith(user.id);
    expect(mockHubListMessages).not.toHaveBeenCalled();
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

