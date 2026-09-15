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
vi.mock("./hub.js", () => ({
  hubListMessages: (...args: unknown[]) => mockHubListMessages(...args),
  hubListNewMessages: (...args: unknown[]) => mockHubListNewMessages(...args),
  holdNewMessageCheckpoint: (...args: unknown[]) => mockHoldCheckpoint(...args),
}));

const { sendWhatsAppMessage, sendWhatsAppTemplate, isWhatsAppConfigured } = await import("../providers/whatsapp.js");
const {
  findOrCreateUserByEmail,
  saveDocument,
  addPhoneNumberForUser,
  recordInboundMessage,
  hasAlerted,
  saveMatchKeys,
  setPendingSetup,
} = await import("../db/store.js");
const { matchTier, buildMatchNotification, checkNewEmailsAgainstRecentDocuments } = await import("./reconciliation.js");
const { takeSuppressedOnboardingAlertCount } = await import("./onboardingAlertSuppression.js");

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
  it("notifies when a new email's subject contains a recent document's reference code, naming the email", async () => {
    const { user, phoneNumber } = seedUserWithDocument("email-to-doc", "Hilton Booking", "H9ZZ21");
    mockHubListNewMessages.mockResolvedValue([fakeMessage({ id: "m10", subject: "Change to booking H9ZZ21" })]);

    await checkNewEmailsAgainstRecentDocuments(user.id);

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    const [phone, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(phone).toBe(phoneNumber);
    expect(text).toContain("Hilton Booking");
    expect(text).toContain("Change to booking H9ZZ21");
  });

  // Regression (alert spam, 2026-09-15): an airline sends several emails per booking, and each one
  // used to produce its own identical-looking alert.
  it("sends one message for several matching emails in the same check, listing each email", async () => {
    const { user } = seedUserWithDocument("email-to-doc-several", "JetSMART Boarding Pass", "V9MKMZ");
    mockHubListNewMessages.mockResolvedValue([
      fakeMessage({ id: "js-1", subject: "Your JetSMART booking V9MKMZ is confirmed" }),
      fakeMessage({ id: "js-2", subject: "Check-in is open for V9MKMZ" }),
      fakeMessage({ id: "js-3", subject: "Your boarding pass V9MKMZ" }),
    ]);

    await checkNewEmailsAgainstRecentDocuments(user.id);

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    const [, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(text).toContain("Your JetSMART booking V9MKMZ is confirmed");
    expect(text).toContain("Check-in is open for V9MKMZ");
    expect(text).toContain("Your boarding pass V9MKMZ");
    for (const id of ["js-1", "js-2", "js-3"]) {
      expect(hasAlerted(user.id, `recon-scan:1:${id}`)).toBe(true);
    }
  });

  it("alerts about an email once, even when more than one saved document matches it", async () => {
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

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    const [, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(text.match(/Gate change for V9TWO1/g)).toHaveLength(1);
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

  it("does not notify twice for the same email across ticks", async () => {
    const { user } = seedUserWithDocument("email-to-doc-dedup", "Hilton Booking", "H9ZZ22");
    mockHubListNewMessages.mockResolvedValue([fakeMessage({ id: "m12", subject: "Change to booking H9ZZ22" })]);

    await checkNewEmailsAgainstRecentDocuments(user.id);
    await checkNewEmailsAgainstRecentDocuments(user.id);

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
  });

  it("leaves matched emails unscanned and holds the mail checkpoint when delivery fails, then delivers once on retry", async () => {
    const { user } = seedUserWithDocument("email-to-doc-delivery-fail", "Hilton Booking", "H9ZZ23");
    mockHubListNewMessages.mockResolvedValue([fakeMessage({ id: "m13", subject: "Change to booking H9ZZ23" })]);
    vi.mocked(sendWhatsAppMessage).mockRejectedValue(new Error("network down"));

    await checkNewEmailsAgainstRecentDocuments(user.id);

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    // On Gmail the later tick only re-lists this email if the history checkpoint was held.
    expect(mockHoldCheckpoint).toHaveBeenCalledWith(user.id);
    expect(hasAlerted(user.id, "recon-scan:1:m13")).toBe(false);

    vi.mocked(sendWhatsAppMessage).mockReset().mockResolvedValue(undefined);
    await checkNewEmailsAgainstRecentDocuments(user.id);

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    expect(hasAlerted(user.id, "recon-scan:1:m13")).toBe(true);
  });

  it("lists at most five emails in one message and summarizes the rest", async () => {
    const { user } = seedUserWithDocument("email-to-doc-many", "Big Trip", "MANYCODE1");
    mockHubListNewMessages.mockResolvedValue(
      Array.from({ length: 7 }, (_, i) => fakeMessage({ id: `many-${i}`, subject: `Update ${i} on MANYCODE1` }))
    );

    await checkNewEmailsAgainstRecentDocuments(user.id);

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    const [, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(text).toContain("Update 4 on MANYCODE1");
    expect(text).not.toContain("Update 5 on MANYCODE1");
    expect(text).toContain("2 more");
    for (let i = 0; i < 7; i++) expect(hasAlerted(user.id, `recon-scan:1:many-${i}`)).toBe(true);
  });

  it("leaves everything unscanned (without holding the checkpoint) when WhatsApp isn't configured", async () => {
    const { user } = seedUserWithDocument("email-to-doc-not-configured", "Hilton Booking", "H9ZZ24");
    mockHubListNewMessages.mockResolvedValue([fakeMessage({ id: "m14", subject: "Change to booking H9ZZ24" })]);
    vi.mocked(isWhatsAppConfigured).mockReturnValue(false);

    await checkNewEmailsAgainstRecentDocuments(user.id);

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(hasAlerted(user.id, "recon-scan:1:m14")).toBe(false);
    expect(mockHoldCheckpoint).not.toHaveBeenCalled();
  });

  // Same onboarding-window suppression as alerts.ts (see onboardingAlertSuppression.ts).
  it("records but does not send while onboarding is still in progress", async () => {
    const { user } = seedUserWithDocument("email-to-doc-mid-onboarding", "Hilton Booking", "ONBOARDCODE1");
    setPendingSetup(user.id, "ask_briefing");
    mockHubListNewMessages.mockResolvedValue([fakeMessage({ id: "onb-1", subject: "Change to booking ONBOARDCODE1" })]);

    await checkNewEmailsAgainstRecentDocuments(user.id);

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(hasAlerted(user.id, "recon-scan:1:onb-1")).toBe(true);
    expect(takeSuppressedOnboardingAlertCount(user.id)).toBe(1);
    expect(mockHoldCheckpoint).not.toHaveBeenCalled();
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

describe("buildMatchNotification", () => {
  const match = (subject: string, docTitle: string, keys: MatchKeys) => ({ subject, docTitle, keys });

  it("for one email, names the email, the document, and the identifier (title and identifier bolded)", () => {
    const msg = buildMatchNotification(
      [match("Gate change for DL1234", "Delta Boarding Pass", { flightNumber: "DL1234", eventDate: "2026-09-12" })],
      null
    );
    expect(msg).toContain('"Gate change for DL1234"');
    expect(msg).toContain("*Delta Boarding Pass*");
    expect(msg).toContain("*DL1234*");
    expect(msg).toContain("2026-09-12");
  });

  it("prefers referenceCode over flightNumber when both are present", () => {
    const msg = buildMatchNotification(
      [match("Update", "Hotel Booking", { referenceCode: "K4X9QP", flightNumber: "DL1234" })],
      null
    );
    expect(msg).toContain("K4X9QP");
    expect(msg).not.toContain("DL1234");
  });

  it("omits a stray date segment when eventDate is absent", () => {
    const msg = buildMatchNotification([match("Update", "Hotel Booking", { referenceCode: "K4X9QP" })], null);
    expect(msg).not.toContain("undefined");
  });

  it("greets the user by name when one is known", () => {
    const msg = buildMatchNotification([match("Update", "Hotel Booking", { referenceCode: "K4X9QP" })], "Sam");
    expect(msg).toContain("Sam");
  });

  it("omits the greeting, and never shows a raw email address, when no name is known", () => {
    const msg = buildMatchNotification([match("Update", "Hotel Booking", { referenceCode: "K4X9QP" })], null);
    expect(msg).not.toContain("@");
    expect(msg.startsWith("[")).toBe(false);
  });

  it("for several emails, lists one line per email in a single message", () => {
    const msg = buildMatchNotification(
      [
        match("Booking confirmed", "JetSMART Boarding Pass", { referenceCode: "V9MKMZ" }),
        match("Check-in open", "JetSMART Boarding Pass", { referenceCode: "V9MKMZ" }),
      ],
      "Sam"
    );
    expect(msg).toContain("2 emails");
    expect(msg).toContain('"Booking confirmed"');
    expect(msg).toContain('"Check-in open"');
    expect(msg.split("\n").filter((line) => line.startsWith("•"))).toHaveLength(2);
  });
});
