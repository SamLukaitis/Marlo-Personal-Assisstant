import { describe, it, expect, vi, beforeEach } from "vitest";
import { type MatchKeys, RECONCILIATION_SCAN_LIMIT } from "./reconciliation.js";

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
vi.mock("./hub.js", () => ({
  hubListMessages: (...args: unknown[]) => mockHubListMessages(...args),
  hubListNewMessages: (...args: unknown[]) => mockHubListNewMessages(...args),
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
const { matchTier, buildMatchNotification, checkDocumentAgainstRecentEmails, checkNewEmailsAgainstRecentDocuments } =
  await import("./reconciliation.js");
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

beforeEach(() => {
  vi.mocked(sendWhatsAppMessage).mockReset();
  vi.mocked(sendWhatsAppTemplate).mockReset();
  vi.mocked(isWhatsAppConfigured).mockReset().mockReturnValue(true);
  mockHubListMessages.mockReset();
  mockHubListNewMessages.mockReset();
});

describe("checkDocumentAgainstRecentEmails", () => {
  it("notifies when a recent email's subject contains the document's reference code", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("doc-to-email"));
    const phoneNumber = freshPhone();
    addPhoneNumberForUser(user.id, phoneNumber);
    recordInboundMessage(phoneNumber);
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
    recordInboundMessage(phoneNumber);
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
    recordInboundMessage(phoneNumber);
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
    recordInboundMessage(phoneNumber);
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
    recordInboundMessage(phoneNumber);
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
    recordInboundMessage(phoneNumber);
    const doc = saveDocument(user.id, {
      phone: phoneNumber,
      filename: null,
      mimeType: "image/jpeg",
      storedPath: "/tmp/fake",
      caption: null,
      title: "Hilton Booking",
      extractedText: "text",
      category: "receipts",
    });
    saveMatchKeys(user.id, doc.id, { referenceCode: "H9ZZ21" });

    mockHubListNewMessages.mockResolvedValue([fakeMessage({ id: "m10", subject: "Change to booking H9ZZ21" })]);

    await checkNewEmailsAgainstRecentDocuments(user.id);

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    const [, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(text).toContain("Hilton Booking");
  });

  it("only scans each email once across repeated ticks, regardless of match outcome", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("email-to-doc-scan-once"));
    const phoneNumber = freshPhone();
    addPhoneNumberForUser(user.id, phoneNumber);
    recordInboundMessage(phoneNumber);
    const doc = saveDocument(user.id, {
      phone: phoneNumber,
      filename: null,
      mimeType: "image/jpeg",
      storedPath: "/tmp/fake",
      caption: null,
      title: "Unrelated Doc",
      extractedText: "text",
      category: "receipts",
    });
    // A saved match key is required for the early-return-when-nothing-indexed check not to skip
    // this user entirely — but this reference code deliberately doesn't appear in the message
    // below, so the point of this test (a no-match email still gets its scan key marked) holds.
    saveMatchKeys(user.id, doc.id, { referenceCode: "ZZNOMATCH1" });
    mockHubListNewMessages.mockResolvedValue([fakeMessage({ id: "m11", subject: "Nothing relevant here" })]);

    await checkNewEmailsAgainstRecentDocuments(user.id);
    await checkNewEmailsAgainstRecentDocuments(user.id);

    expect(hasAlerted(user.id, "recon-scan:1:m11")).toBe(true);
    // No crash, no duplicate work observable from the outside — the real assertion is that a
    // second identical tick doesn't re-notify, covered by the dedup test below with an actual match.
  });

  it("returns without calling hubListNewMessages when the user has no recent match keys at all", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("email-to-doc-no-keys"));

    await checkNewEmailsAgainstRecentDocuments(user.id);

    expect(mockHubListNewMessages).not.toHaveBeenCalled();
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it("does not notify twice for the same email/document pair across ticks", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("email-to-doc-dedup"));
    const phoneNumber = freshPhone();
    addPhoneNumberForUser(user.id, phoneNumber);
    recordInboundMessage(phoneNumber);
    const doc = saveDocument(user.id, {
      phone: phoneNumber,
      filename: null,
      mimeType: "image/jpeg",
      storedPath: "/tmp/fake",
      caption: null,
      title: "Hilton Booking",
      extractedText: "text",
      category: "receipts",
    });
    saveMatchKeys(user.id, doc.id, { referenceCode: "H9ZZ22" });
    mockHubListNewMessages.mockResolvedValue([fakeMessage({ id: "m12", subject: "Change to booking H9ZZ22" })]);

    await checkNewEmailsAgainstRecentDocuments(user.id);
    mockHubListNewMessages.mockResolvedValue([fakeMessage({ id: "m12", subject: "Change to booking H9ZZ22" })]);
    await checkNewEmailsAgainstRecentDocuments(user.id);

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
  });

  it("leaves both the match and the scan key unmarked when delivery fails, so a later tick re-examines and retries", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("email-to-doc-delivery-fail"));
    const phoneNumber = freshPhone();
    addPhoneNumberForUser(user.id, phoneNumber);
    recordInboundMessage(phoneNumber);
    const doc = saveDocument(user.id, {
      phone: phoneNumber,
      filename: null,
      mimeType: "image/jpeg",
      storedPath: "/tmp/fake",
      caption: null,
      title: "Hilton Booking",
      extractedText: "text",
      category: "receipts",
    });
    saveMatchKeys(user.id, doc.id, { referenceCode: "H9ZZ23" });
    mockHubListNewMessages.mockResolvedValue([fakeMessage({ id: "m13", subject: "Change to booking H9ZZ23" })]);
    vi.mocked(sendWhatsAppMessage).mockRejectedValue(new Error("network down"));

    await checkNewEmailsAgainstRecentDocuments(user.id);

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    const matchKey = `recon-match:${doc.id}:1:m13`;
    expect(hasAlerted(user.id, matchKey)).toBe(false);
    // This is the crux of the fix: if the scan key got marked here, the email would be filtered
    // out of `unscanned` on every future tick (see the `messages.filter` at the top of the
    // function) and this retriable-in-name-only match would never actually be retried.
    expect(hasAlerted(user.id, "recon-scan:1:m13")).toBe(false);

    // Prove the retriability is real, not just an unset flag: a later tick with delivery now
    // succeeding must re-examine this same email and actually deliver the notification.
    vi.mocked(sendWhatsAppMessage).mockReset().mockResolvedValue(undefined);
    mockHubListNewMessages.mockResolvedValue([fakeMessage({ id: "m13", subject: "Change to booking H9ZZ23" })]);

    await checkNewEmailsAgainstRecentDocuments(user.id);

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    expect(hasAlerted(user.id, matchKey)).toBe(true);
    expect(hasAlerted(user.id, "recon-scan:1:m13")).toBe(true);
  });

  it("leaves a message beyond the per-tick notification cap unscanned rather than marking it scanned unexamined", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("email-to-doc-cap-overflow"));
    const phoneNumber = freshPhone();
    addPhoneNumberForUser(user.id, phoneNumber);
    recordInboundMessage(phoneNumber);
    const doc = saveDocument(user.id, {
      phone: phoneNumber,
      filename: null,
      mimeType: "image/jpeg",
      storedPath: "/tmp/fake",
      caption: null,
      title: "Cap Overflow Doc",
      extractedText: "text",
      category: "receipts",
    });
    saveMatchKeys(user.id, doc.id, { referenceCode: "OVERFLOWCODE1" });

    // MAX_MATCH_NOTIFICATIONS_PER_TICK is 5 (see reconciliation.ts) — six matching messages
    // means the sixth is beyond the cap and must never be examined at all this tick.
    const messages = Array.from({ length: 6 }, (_, i) =>
      fakeMessage({ id: `cap-${i}`, subject: `Change to booking OVERFLOWCODE1 (${i})` })
    );
    mockHubListNewMessages.mockResolvedValue(messages);

    await checkNewEmailsAgainstRecentDocuments(user.id);

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(5);
    for (let i = 0; i < 5; i++) {
      expect(hasAlerted(user.id, `recon-scan:1:cap-${i}`)).toBe(true);
    }
    // The sixth message was never reached by the loop (it `break`s once the cap is hit), so it
    // must stay unscanned to get a fair chance on the next tick — not marked-and-dropped.
    expect(hasAlerted(user.id, "recon-scan:1:cap-5")).toBe(false);
  });

  // Same onboarding-window suppression as alerts.ts/importantEmailAlerts.ts (see those files'
  // tests of the same name for the full rationale).
  it("records but does not send while onboarding is still in progress", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("email-to-doc-mid-onboarding"));
    const phoneNumber = freshPhone();
    addPhoneNumberForUser(user.id, phoneNumber);
    recordInboundMessage(phoneNumber);
    setPendingSetup(user.id, "ask_briefing");
    const doc = saveDocument(user.id, {
      phone: phoneNumber,
      filename: null,
      mimeType: "image/jpeg",
      storedPath: "/tmp/fake",
      caption: null,
      title: "Hilton Booking",
      extractedText: "text",
      category: "receipts",
    });
    saveMatchKeys(user.id, doc.id, { referenceCode: "ONBOARDCODE1" });
    mockHubListNewMessages.mockResolvedValue([
      fakeMessage({ id: "onb-1", subject: "Change to booking ONBOARDCODE1" }),
    ]);

    await checkNewEmailsAgainstRecentDocuments(user.id);

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(hasAlerted(user.id, `recon-match:${doc.id}:1:onb-1`)).toBe(true);
    expect(hasAlerted(user.id, "recon-scan:1:onb-1")).toBe(true);
    expect(takeSuppressedOnboardingAlertCount(user.id)).toBe(1);
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
  it("includes the document title, identifier, and date, with the title and identifier bolded", () => {
    const msg = buildMatchNotification(
      "Delta Boarding Pass",
      { flightNumber: "DL1234", eventDate: "2026-09-12" },
      null
    );
    expect(msg).toContain("*Delta Boarding Pass*");
    expect(msg).toContain("*DL1234*");
    expect(msg).toContain("2026-09-12");
  });

  it("prefers referenceCode over flightNumber when both are present", () => {
    const msg = buildMatchNotification("Hotel Booking", { referenceCode: "K4X9QP", flightNumber: "DL1234" }, null);
    expect(msg).toContain("K4X9QP");
    expect(msg).not.toContain("DL1234");
  });

  it("omits a stray date segment when eventDate is absent", () => {
    const msg = buildMatchNotification("Hotel Booking", { referenceCode: "K4X9QP" }, null);
    expect(msg).not.toContain("undefined");
  });

  it("greets the user by name when one is known", () => {
    const msg = buildMatchNotification("Hotel Booking", { referenceCode: "K4X9QP" }, "Sam");
    expect(msg).toContain("Sam");
  });

  it("omits the greeting, and never shows a raw email address, when no name is known", () => {
    const msg = buildMatchNotification("Hotel Booking", { referenceCode: "K4X9QP" }, null);
    expect(msg).not.toContain("@");
    expect(msg.startsWith("[")).toBe(false);
  });
});

describe("reconciliation scan depth", () => {
  it("checkDocumentAgainstRecentEmails asks for RECONCILIATION_SCAN_LIMIT messages, not 50", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("scan-depth-doc"));
    const phoneNumber = freshPhone();
    addPhoneNumberForUser(user.id, phoneNumber);
    recordInboundMessage(phoneNumber);
    const doc = saveDocument(user.id, {
      phone: phoneNumber,
      filename: null,
      mimeType: "image/jpeg",
      storedPath: "/tmp/fake",
      caption: null,
      title: "Some Booking",
      extractedText: "text",
      category: "travel",
    });
    mockHubListMessages.mockResolvedValue([]);

    await checkDocumentAgainstRecentEmails(user.id, doc.id, doc.title!, { referenceCode: "ABCD1234" });

    expect(mockHubListMessages).toHaveBeenCalledWith(user.id, { limit: RECONCILIATION_SCAN_LIMIT });
    expect(RECONCILIATION_SCAN_LIMIT).toBe(150);
  });

  // checkNewEmailsAgainstRecentDocuments runs on the scheduler tick and only ever acts on
  // messages it hasn't scanned before (its own unscanned filter) — genuinely "what's new since
  // last check", unlike checkDocumentAgainstRecentEmails above (which needs the full current
  // window right now, checking one just-saved document against mail that could have arrived any
  // time within it). So it shares hub.ts's incremental hubListNewMessages instead, which takes
  // no limit at all — see hub.ts's HISTORY_BASELINE_LIMIT comment for why.
  it("checkNewEmailsAgainstRecentDocuments uses the incremental hubListNewMessages, not a fixed-limit list", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("scan-depth-email"));
    const phoneNumber = freshPhone();
    addPhoneNumberForUser(user.id, phoneNumber);
    recordInboundMessage(phoneNumber);
    const doc = saveDocument(user.id, {
      phone: phoneNumber,
      filename: null,
      mimeType: "image/jpeg",
      storedPath: "/tmp/fake",
      caption: null,
      title: "Some Booking",
      extractedText: "text",
      category: "travel",
    });
    saveMatchKeys(user.id, doc.id, { referenceCode: "EFGH5678" });
    mockHubListNewMessages.mockResolvedValue([]);

    await checkNewEmailsAgainstRecentDocuments(user.id);

    expect(mockHubListNewMessages).toHaveBeenCalledWith(user.id);
    expect(mockHubListMessages).not.toHaveBeenCalled();
  });
});
