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

const mockHubListNewMessages = vi.fn();
const mockHubListMessages = vi.fn();
const mockHubGetMessage = vi.fn();
const mockHoldCheckpoint = vi.fn();
vi.mock("./hub.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./hub.js")>();
  return {
    ...actual,
    hubListNewMessages: (...args: unknown[]) => mockHubListNewMessages(...args),
    hubListMessages: (...args: unknown[]) => mockHubListMessages(...args),
    hubGetMessage: (...args: unknown[]) => mockHubGetMessage(...args),
    holdNewMessageCheckpoint: (...args: unknown[]) => mockHoldCheckpoint(...args),
  };
});

const mockClassify = vi.fn();
vi.mock("./importantEmailClassifier.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./importantEmailClassifier.js")>();
  return { ...actual, classifyImportantEmails: (...args: unknown[]) => mockClassify(...args) };
});

const { sendWhatsAppMessage, sendWhatsAppTemplate, isWhatsAppConfigured } = await import("../providers/whatsapp.js");
const {
  findOrCreateUserByEmail,
  addPhoneNumberForUser,
  recordInboundMessage,
  hasAlerted,
  listEntities,
  setSetting,
  setPendingSetup,
  clearPendingSetup,
  getWhatsAppHistory,
} = await import("../db/store.js");
const { markOnboardingConnected } = await import("./onboardingAlertSuppression.js");
const {
  checkForImportantEmails,
  formatImportantEmailAlert,
  scanAndCurateImportantEmailsForOnboarding,
  IMPORTANT_EMAIL_ENTITY_TYPE,
} = await import("./importantEmailAlerts.js");
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
// xeroForwarding.test.ts, reminderScheduler.test.ts) — this file uses 44700005.
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
    receivedAt: string;
    bulk: boolean;
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
  mockHubListNewMessages.mockResolvedValueOnce([]);
  await checkForImportantEmails(ownerId);
}

beforeEach(() => {
  vi.mocked(sendWhatsAppMessage).mockReset();
  vi.mocked(sendWhatsAppTemplate).mockReset();
  vi.mocked(isWhatsAppConfigured).mockReset().mockReturnValue(true);
  mockHubListNewMessages.mockReset();
  mockHubListMessages.mockReset();
  mockHubGetMessage.mockReset();
  mockHoldCheckpoint.mockReset();
  mockClassify.mockReset().mockResolvedValue(new Map());
});

describe("checkForImportantEmails", () => {
  it("baselines the existing inbox on first run without classifying or notifying", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("baseline"));
    mockHubListNewMessages.mockResolvedValueOnce([fakeMessage({ id: "old-1" })]);

    await checkForImportantEmails(user.id);

    expect(mockClassify).not.toHaveBeenCalled();
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(hasAlerted(user.id, "important-email:1:old-1")).toBe(true);
  });

  // A user who opens a flight-booking notification the moment it arrives (entirely normal
  // behavior) must not lose the alert — unread was never the real "already handled" signal,
  // hasAlerted's per-message ledger below already is, so a read automated-sender email is still
  // a valid candidate. Only the sender-type filter (automated vs a real person) narrows this.
  it("filters to automated-sender mail regardless of read status, ignoring mail from real people", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("filter"));
    registerActivePhone(user.id);
    await baseline(user.id);

    mockHubListNewMessages.mockResolvedValueOnce([
      fakeMessage({ id: "already-read", unread: false, from: "no-reply@delta.com", subject: "Already read" }),
      fakeMessage({ id: "real-person", unread: true, from: "jane@example.com" }),
      fakeMessage({ id: "candidate", unread: true, from: "no-reply@delta.com", subject: "Flight change" }),
    ]);

    await checkForImportantEmails(user.id);

    expect(mockClassify).toHaveBeenCalledTimes(1);
    const [candidates] = mockClassify.mock.calls[0];
    expect(candidates.map((c: { subject: string }) => c.subject)).toEqual(["Already read", "Flight change"]);
  });

  // The other half of the "real person" alert fix: marketing mail flagged as bulk leaves the
  // real-person bucket, so it has to land here instead — otherwise a genuinely useful delivery
  // notice from an ordinary-looking address would fall between the two features.
  it("classifies mail the provider flagged as bulk, even from an ordinary-looking address", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("filter-bulk"));
    registerActivePhone(user.id);
    await baseline(user.id);

    mockHubListNewMessages.mockResolvedValueOnce([
      fakeMessage({ id: "bulk", from: "DHL <tracking@dhl.com>", subject: "Out for delivery", bulk: true }),
      fakeMessage({ id: "person", from: "jane@example.com", subject: "Dinner?" }),
    ]);

    await checkForImportantEmails(user.id);

    const [candidates] = mockClassify.mock.calls[0];
    expect(candidates.map((c: { subject: string }) => c.subject)).toEqual(["Out for delivery"]);
  });

  // Google/Microsoft's "an app was granted access" notification fires for Marlowe's own OAuth
  // connect/reconnect too — expected and self-caused, not a security event — but the classifier
  // can't tell that apart from a real new-sign-in alert from subject/snippet alone.
  it("filters out a notification about our own app being granted access, before it reaches the classifier", async () => {
    const originalServerUrl = process.env.SERVER_URL;
    process.env.SERVER_URL = "https://marlowe.up.railway.app";
    try {
      const user = findOrCreateUserByEmail(uniqueEmail("own-app"));
      registerActivePhone(user.id);
      await baseline(user.id);

      mockHubListNewMessages.mockResolvedValueOnce([
        fakeMessage({
          id: "own-app-1",
          from: "no-reply@accounts.google.com",
          subject: "Security alert",
          snippet:
            "Someone (possibly unauthorized) granted an app called marlowe.up.railway.app access to your Google Account data.",
        }),
        fakeMessage({ id: "real-alert", from: "no-reply@accounts.google.com", subject: "New sign-in" }),
      ]);

      await checkForImportantEmails(user.id);

      expect(mockClassify).toHaveBeenCalledTimes(1);
      const [candidates] = mockClassify.mock.calls[0];
      expect(candidates.map((c: { index: number }) => c.index)).toEqual([0]);
      expect(candidates[0]).not.toMatchObject({ subject: "Security alert" });
      expect(hasAlerted(user.id, "important-email:1:own-app-1")).toBe(false);
    } finally {
      process.env.SERVER_URL = originalServerUrl;
    }
  });

  // A one-time code is meaningless by the time a WhatsApp notification relays it (usually
  // already expired), and forwarding one reads as Marlowe leaking a security-sensitive code out
  // of the user's inbox — hardcoded exclusion, not left to the classifier's judgement.
  it("never classifies or alerts on a verification/login code email", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("verification-code"));
    registerActivePhone(user.id);
    await baseline(user.id);

    mockHubListNewMessages.mockResolvedValueOnce([
      fakeMessage({ id: "code-1", subject: "Your verification code", snippet: "Your code is 482913." }),
      fakeMessage({ id: "code-2", subject: "Security code", snippet: "Use 118422 to sign in." }),
      fakeMessage({ id: "real-alert", subject: "New sign-in", snippet: "We noticed a new sign-in." }),
    ]);

    await checkForImportantEmails(user.id);

    expect(mockClassify).toHaveBeenCalledTimes(1);
    const [candidates] = mockClassify.mock.calls[0];
    expect(candidates.map((c: { subject: string }) => c.subject)).toEqual(["New sign-in"]);
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it("records the alert in history with the email's ids so it can be replied to", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("match-ref"));
    const phone = registerActivePhone(user.id);
    await baseline(user.id);
    mockHubListNewMessages.mockResolvedValueOnce([
      fakeMessage({ id: "flight-ref-1", accountId: 9, subject: "Your flight changed" }),
    ]);
    mockClassify.mockResolvedValueOnce(new Map([[0, { category: "flight_change", summary: "Gate moved." }]]));

    await checkForImportantEmails(user.id);

    const [, sentText] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(sentText).not.toContain("flight-ref-1");
    const last = getWhatsAppHistory(phone).at(-1)!;
    expect(last.content).toContain("account_id=9");
    expect(last.content).toContain("message_id=flight-ref-1");
  });

  it("sends a WhatsApp alert for a classified match, formatted with the category", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("match"));
    const phone = registerActivePhone(user.id);
    await baseline(user.id);

    mockHubListNewMessages.mockResolvedValueOnce([
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
    expect(text).toContain("Your gate moved to B12.");
    expect(text).not.toContain("@"); // never a raw email address in the visible text
    expect(hasAlerted(user.id, "important-email:1:flight-1")).toBe(true);
  });

  it("greets the user by their saved name when one is set", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("named"));
    registerActivePhone(user.id);
    setSetting(user.id, "user_name", "Sam");
    await baseline(user.id);

    mockHubListNewMessages.mockResolvedValueOnce([fakeMessage({ id: "flight-named" })]);
    mockClassify.mockResolvedValueOnce(
      new Map([[0, { category: "flight_change", summary: "Your gate moved to B12." }]])
    );

    await checkForImportantEmails(user.id);

    const [, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(text).toBe("✈️ Sam, Your gate moved to B12.");
  });

  it("does not re-classify or re-alert the same message on a later tick", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("dedup"));
    const phone = registerActivePhone(user.id);
    await baseline(user.id);

    mockHubListNewMessages.mockResolvedValue([fakeMessage({ id: "flight-2" })]);
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

    mockHubListNewMessages.mockResolvedValue([fakeMessage({ id: "boring-1" })]);
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

    mockHubListNewMessages.mockResolvedValueOnce([fakeMessage({ id: "err-1" })]);
    mockClassify.mockRejectedValueOnce(new Error("API down"));

    await checkForImportantEmails(user.id);

    expect(mockClassify).toHaveBeenCalledTimes(1);
    expect(hasAlerted(user.id, "important-email:1:err-1")).toBe(false);
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  // Unmarked isn't enough on its own for Gmail: without holding the history checkpoint, the next
  // tick's incremental fetch starts past this mail and never returns it again.
  it("holds the mail checkpoint when classification fails, so the mail is listed again next tick", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("classify-fail-hold"));
    registerActivePhone(user.id);
    await baseline(user.id);

    mockHubListNewMessages.mockResolvedValueOnce([fakeMessage({ id: "err-hold-1" })]);
    mockClassify.mockRejectedValueOnce(new Error("API down"));

    await checkForImportantEmails(user.id);

    expect(mockHoldCheckpoint).toHaveBeenCalledWith(user.id);
  });

  it("holds the mail checkpoint when an alert fails to deliver", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("deliver-fail-hold"));
    registerActivePhone(user.id);
    await baseline(user.id);

    mockHubListNewMessages.mockResolvedValueOnce([fakeMessage({ id: "fail-hold-1" })]);
    mockClassify.mockResolvedValueOnce(new Map([[0, { category: "invoice_due", summary: "" }]]));
    vi.mocked(sendWhatsAppMessage).mockRejectedValueOnce(new Error("network down"));

    await checkForImportantEmails(user.id);

    expect(mockHoldCheckpoint).toHaveBeenCalledWith(user.id);
  });

  it("does not hold the checkpoint when everything was handled", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("all-handled-no-hold"));
    registerActivePhone(user.id);
    await baseline(user.id);

    mockHubListNewMessages.mockResolvedValueOnce([fakeMessage({ id: "ok-1" })]);
    mockClassify.mockResolvedValueOnce(new Map([[0, { category: "invoice_due", summary: "" }]]));
    vi.mocked(sendWhatsAppMessage).mockResolvedValue(undefined);

    await checkForImportantEmails(user.id);

    expect(mockHoldCheckpoint).not.toHaveBeenCalled();
  });

  it("leaves a matched message unmarked (retriable) when delivery fails", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("deliver-fail"));
    const phone = registerActivePhone(user.id);
    await baseline(user.id);

    mockHubListNewMessages.mockResolvedValueOnce([fakeMessage({ id: "fail-1" })]);
    mockClassify.mockResolvedValueOnce(new Map([[0, { category: "invoice_due", summary: "" }]]));
    vi.mocked(sendWhatsAppMessage).mockRejectedValueOnce(new Error("network down"));

    await checkForImportantEmails(user.id);

    expect(hasAlerted(user.id, "important-email:1:fail-1")).toBe(false);
  });

  it("on retry after a partial failure, only resends to the number that missed it", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("deliver-partial"));
    registerActivePhone(user.id);
    const second = registerActivePhone(user.id);
    await baseline(user.id);

    const msg = fakeMessage({ id: "partial-1" });
    const classified = new Map([[0, { category: "invoice_due", summary: "" }]]);
    mockHubListNewMessages.mockResolvedValueOnce([msg]);
    mockClassify.mockResolvedValueOnce(classified);
    vi.mocked(sendWhatsAppMessage).mockImplementation(async (to: string) => {
      if (to === second) throw new Error("network down");
    });
    await checkForImportantEmails(user.id);
    expect(hasAlerted(user.id, "important-email:1:partial-1")).toBe(false);

    vi.mocked(sendWhatsAppMessage).mockReset().mockResolvedValue(undefined);
    mockHubListNewMessages.mockResolvedValueOnce([msg]);
    mockClassify.mockResolvedValueOnce(classified);
    await checkForImportantEmails(user.id);

    expect(vi.mocked(sendWhatsAppMessage).mock.calls.map((c) => c[0])).toEqual([second]);
    expect(hasAlerted(user.id, "important-email:1:partial-1")).toBe(true);
  });

  it("leaves a matched message unmarked when WhatsApp isn't configured", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("not-configured"));
    await baseline(user.id);

    mockHubListNewMessages.mockResolvedValueOnce([fakeMessage({ id: "noconfig-1" })]);
    mockClassify.mockResolvedValueOnce(new Map([[0, { category: "invoice_due", summary: "" }]]));
    vi.mocked(isWhatsAppConfigured).mockReturnValue(false);

    await checkForImportantEmails(user.id);

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(hasAlerted(user.id, "important-email:1:noconfig-1")).toBe(false);
  });

  it("leaves a matched message unmarked when the user has no registered phone numbers", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("no-numbers"));
    await baseline(user.id);

    mockHubListNewMessages.mockResolvedValueOnce([fakeMessage({ id: "nonum-1" })]);
    mockClassify.mockResolvedValueOnce(new Map([[0, { category: "invoice_due", summary: "" }]]));

    await checkForImportantEmails(user.id);

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(hasAlerted(user.id, "important-email:1:nonum-1")).toBe(false);
  });

  it("stores the matched email as a queryable entity when the alert is delivered", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("entity-store"));
    registerActivePhone(user.id);
    await baseline(user.id);

    mockHubListNewMessages.mockResolvedValueOnce([
      fakeMessage({ id: "flight-entity", subject: "Your flight changed", from: "no-reply@delta.com" }),
    ]);
    mockClassify.mockResolvedValueOnce(
      new Map([[0, { category: "flight_change", summary: "Your gate moved to B12." }]])
    );

    await checkForImportantEmails(user.id);

    const stored = listEntities(user.id, { type: IMPORTANT_EMAIL_ENTITY_TYPE });
    expect(stored).toHaveLength(1);
    expect(stored[0].data).toMatchObject({
      accountId: 1,
      accountEmail: "test@example.com",
      messageId: "flight-entity",
      category: "flight_change",
      subject: "Your flight changed",
      from: "no-reply@delta.com",
      summary: "Your gate moved to B12.",
    });
  });

  it("does not store an entity when delivery fails", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("entity-deliver-fail"));
    registerActivePhone(user.id);
    await baseline(user.id);

    mockHubListNewMessages.mockResolvedValueOnce([fakeMessage({ id: "fail-entity" })]);
    mockClassify.mockResolvedValueOnce(new Map([[0, { category: "invoice_due", summary: "" }]]));
    vi.mocked(sendWhatsAppMessage).mockRejectedValueOnce(new Error("network down"));

    await checkForImportantEmails(user.id);

    expect(listEntities(user.id, { type: IMPORTANT_EMAIL_ENTITY_TYPE })).toHaveLength(0);
  });

  it("caps alerts per tick and sends a summary for the overflow", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("cap"));
    const phone = registerActivePhone(user.id);
    await baseline(user.id);

    // MAX_ALERTS_PER_CHECK is 5 — six matches means the sixth goes into the overflow summary.
    const messages = Array.from({ length: 6 }, (_, i) =>
      fakeMessage({ id: `cap-${i}`, subject: `Notice ${i}` })
    );
    mockHubListNewMessages.mockResolvedValueOnce(messages);
    const classified = new Map<number, { category: "invoice_due"; summary: string }>();
    for (let i = 0; i < 6; i++) classified.set(i, { category: "invoice_due", summary: "" });
    mockClassify.mockResolvedValueOnce(classified);

    await checkForImportantEmails(user.id);

    // 5 individual alerts + 1 overflow summary = 6 sends.
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(6);
    const lastCall = vi.mocked(sendWhatsAppMessage).mock.calls[5];
    expect(lastCall[1]).toContain("1 more");
    // Marlowe offers to go through it — never sends the user off to do it themselves.
    expect(lastCall[1]).toContain("just ask and I'll run through it");
    expect(lastCall[1]).not.toMatch(/check your inbox/i);
    for (let i = 0; i < 6; i++) {
      expect(hasAlerted(user.id, `important-email:1:cap-${i}`)).toBe(true);
    }
    // The overflow email is stored too, so list_flagged_emails can answer "what was the other one?"
    expect(listEntities(user.id, { type: IMPORTANT_EMAIL_ENTITY_TYPE })).toHaveLength(6);
  });

  // Alerts must never interleave with postConnectSetup's own questions — they wait (unmarked,
  // checkpoint held) until the closing message, then go out individually as normal.
  it("holds every alert while the post-connect question chain is still running", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("chain-hold"));
    registerActivePhone(user.id);
    await baseline(user.id);
    // Past the first-minutes hold, so only the chain itself is holding alerts back here.
    setSetting(user.id, "onboarding_connected_at", String(Date.now() - 5 * 60 * 1000));
    setPendingSetup(user.id, "ask_briefing");

    const msg = fakeMessage({ id: "mid-chain", subject: "Flight changed" });
    mockHubListNewMessages.mockResolvedValueOnce([msg]);
    mockClassify.mockResolvedValue(new Map([[0, { category: "flight_change", summary: "Gate moved." }]]));

    await checkForImportantEmails(user.id);

    expect(mockClassify).not.toHaveBeenCalled();
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(hasAlerted(user.id, "important-email:1:mid-chain")).toBe(false);
    expect(mockHoldCheckpoint).toHaveBeenCalledWith(user.id);

    clearPendingSetup(user.id);
    mockHubListNewMessages.mockResolvedValueOnce([msg]);
    await checkForImportantEmails(user.id);

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    expect(hasAlerted(user.id, "important-email:1:mid-chain")).toBe(true);
  });

  // pending_setup is only set once "Connected!" and the first question have gone out — a tick in
  // those first seconds must not get an alert out ahead of "Connected!" itself.
  it("holds alerts in the first minutes after connecting, before the chain has even started", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("chain-not-started"));
    registerActivePhone(user.id);
    await baseline(user.id);
    markOnboardingConnected(user.id);

    mockHubListNewMessages.mockResolvedValueOnce([fakeMessage({ id: "early", subject: "Flight changed" })]);
    mockClassify.mockResolvedValueOnce(new Map([[0, { category: "flight_change", summary: "Gate moved." }]]));

    await checkForImportantEmails(user.id);

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(hasAlerted(user.id, "important-email:1:early")).toBe(false);
  });

  // A brand-new user whose inbox couldn't be read (or was empty) at connect time: the scheduler's
  // legacy first-run branch must not then swallow their first real post-connect emails as backlog.
  it("alerts on the first post-connect email even when the onboarding scan couldn't read the inbox", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("first-tick-after-empty"));
    registerActivePhone(user.id);
    mockHubListMessages.mockResolvedValueOnce([]);
    expect(await scanAndCurateImportantEmailsForOnboarding(user.id)).toBeNull();

    mockHubListNewMessages.mockResolvedValueOnce([fakeMessage({ id: "first-real", subject: "Flight changed" })]);
    mockClassify.mockResolvedValueOnce(new Map([[0, { category: "flight_change", summary: "Gate moved." }]]));
    await checkForImportantEmails(user.id);

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
  });

  it("stops holding once an abandoned chain is well past the connection", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("chain-abandoned"));
    registerActivePhone(user.id);
    await baseline(user.id);
    setSetting(user.id, "onboarding_connected_at", String(Date.now() - 2 * 60 * 60 * 1000));
    setPendingSetup(user.id, "ask_briefing");

    mockHubListNewMessages.mockResolvedValueOnce([fakeMessage({ id: "late", subject: "Flight changed" })]);
    mockClassify.mockResolvedValueOnce(new Map([[0, { category: "flight_change", summary: "Gate moved." }]]));

    await checkForImportantEmails(user.id);

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
  });

});

describe("scanAndCurateImportantEmailsForOnboarding", () => {
  // An empty preview (not null) means "checked, nothing urgent" — postConnectSetup says so.
  it("returns an empty preview when there's nothing automated in the inbox", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("onboard-empty"));
    mockHubListMessages.mockResolvedValueOnce([fakeMessage({ id: "person-1", from: "jane@example.com" })]);

    const result = await scanAndCurateImportantEmailsForOnboarding(user.id);

    expect(result).toEqual({ lines: [], moreCount: 0 });
    expect(mockClassify).not.toHaveBeenCalled();
  });

  // hub.ts turns a provider failure into an empty list, so empty can't honestly mean "nothing urgent".
  it("returns null (couldn't check) when the inbox list comes back empty", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("onboard-empty-list"));
    mockHubListMessages.mockResolvedValueOnce([]);

    const result = await scanAndCurateImportantEmailsForOnboarding(user.id);

    expect(result).toBeNull();
    expect(mockClassify).not.toHaveBeenCalled();
  });

  it("marks every examined candidate (matched and not) so it is never reclassified later", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("onboard-baseline"));
    mockHubListMessages.mockResolvedValueOnce([
      fakeMessage({ id: "match-1", subject: "Your flight changed" }),
      fakeMessage({ id: "boring-1", subject: "Newsletter" }),
    ]);
    mockClassify.mockResolvedValueOnce(new Map([[0, { category: "flight_change", summary: "Gate moved to B12." }]]));

    await scanAndCurateImportantEmailsForOnboarding(user.id);

    expect(hasAlerted(user.id, "important-email:1:match-1")).toBe(true);
    expect(hasAlerted(user.id, "important-email:1:boring-1")).toBe(true);

    // Even if the scheduler were somehow handed the same mail, it has nothing left to do.
    mockHubListNewMessages.mockResolvedValueOnce([
      fakeMessage({ id: "match-1", subject: "Your flight changed" }),
      fakeMessage({ id: "boring-1", subject: "Newsletter" }),
    ]);
    mockClassify.mockClear();
    await checkForImportantEmails(user.id);
    expect(mockClassify).not.toHaveBeenCalled();
  });

  it("stores every match as a queryable entity, same as the scheduler-driven scan", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("onboard-entities"));
    mockHubListMessages.mockResolvedValueOnce([fakeMessage({ id: "flight-1", subject: "Your flight changed" })]);
    mockClassify.mockResolvedValueOnce(
      new Map([[0, { category: "flight_change", summary: "Gate moved to B12." }]])
    );

    await scanAndCurateImportantEmailsForOnboarding(user.id);

    expect(listEntities(user.id, { type: IMPORTANT_EMAIL_ENTITY_TYPE })).toHaveLength(1);
  });

  it("orders the preview by fixed category priority, not discovery order", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("onboard-priority"));
    mockHubListMessages.mockResolvedValueOnce([
      fakeMessage({ id: "a", subject: "Newsletter renewal" }),
      fakeMessage({ id: "b", subject: "New sign-in" }),
      fakeMessage({ id: "c", subject: "Flight changed" }),
    ]);
    mockClassify.mockResolvedValueOnce(
      new Map([
        [0, { category: "subscription_renewal", summary: "Renews tomorrow." }],
        [1, { category: "security_alert", summary: "New sign-in detected." }],
        [2, { category: "flight_change", summary: "Gate moved to B12." }],
      ])
    );

    const result = await scanAndCurateImportantEmailsForOnboarding(user.id);

    expect(result?.lines).toEqual([
      "🔐 New sign-in detected.",
      "✈️ Gate moved to B12.",
      "🔁 Renews tomorrow.",
    ]);
    expect(result?.moreCount).toBe(0);
  });

  it("caps the preview at 3 and reports the rest as a count", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("onboard-cap"));
    const messages = Array.from({ length: 5 }, (_, i) => fakeMessage({ id: `m${i}`, subject: `Notice ${i}` }));
    mockHubListMessages.mockResolvedValueOnce(messages);
    const classified = new Map<number, { category: "invoice_due"; summary: string }>();
    for (let i = 0; i < 5; i++) classified.set(i, { category: "invoice_due", summary: `Invoice ${i} due.` });
    mockClassify.mockResolvedValueOnce(classified);

    const result = await scanAndCurateImportantEmailsForOnboarding(user.id);

    expect(result?.lines).toHaveLength(3);
    expect(result?.moreCount).toBe(2);
  });

  // Pre-connect mail is never handed to the scheduler (hub.ts's connected_at floor), so a failed
  // classification just means no preview — never a burst of backlog alerts later.
  it("returns null (couldn't check) without holding any checkpoint when classification fails", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("onboard-classify-fail"));
    mockHubListMessages.mockResolvedValueOnce([fakeMessage({ id: "err-1" })]);
    mockClassify.mockRejectedValueOnce(new Error("API down"));

    const result = await scanAndCurateImportantEmailsForOnboarding(user.id);

    expect(result).toBeNull();
    expect(mockHoldCheckpoint).not.toHaveBeenCalled();
  });

  // The replay-onboarding bug: the owner-level baseline flag survived from the first connection,
  // so this scan bailed out and the "Connected!" message fell back to a bare unread count.
  it("still previews when the owner was already baselined by an earlier connection", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("onboard-already-baselined"));
    await baseline(user.id);
    mockHubListMessages.mockResolvedValueOnce([fakeMessage({ id: "replay-1", subject: "Flight changed" })]);
    mockClassify.mockResolvedValueOnce(new Map([[0, { category: "flight_change", summary: "Gate moved to B12." }]]));

    const result = await scanAndCurateImportantEmailsForOnboarding(user.id);

    expect(result?.lines).toEqual(["✈️ Gate moved to B12."]);
  });

  it("does not preview the same email twice across reconnects of the same mailbox", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("onboard-no-repeat"));
    const msg = fakeMessage({ id: "seen-1", subject: "Flight changed" });
    mockHubListMessages.mockResolvedValueOnce([msg]);
    mockClassify.mockResolvedValueOnce(new Map([[0, { category: "flight_change", summary: "Gate moved." }]]));
    await scanAndCurateImportantEmailsForOnboarding(user.id);

    mockClassify.mockClear();
    mockHubListMessages.mockResolvedValueOnce([msg]);
    const result = await scanAndCurateImportantEmailsForOnboarding(user.id);

    expect(result).toEqual({ lines: [], moreCount: 0 });
    expect(mockClassify).not.toHaveBeenCalled();
  });

  it("returns an empty preview when the classifier finds nothing important", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("onboard-nothing-matched"));
    mockHubListMessages.mockResolvedValueOnce([fakeMessage({ id: "news-1", subject: "Newsletter" })]);
    mockClassify.mockResolvedValueOnce(new Map());

    const result = await scanAndCurateImportantEmailsForOnboarding(user.id);

    expect(result).toEqual({ lines: [], moreCount: 0 });
  });

  it("returns null (couldn't check) when listing the inbox fails", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("onboard-list-fail"));
    mockHubListMessages.mockRejectedValueOnce(new Error("Gmail down"));

    const result = await scanAndCurateImportantEmailsForOnboarding(user.id);

    expect(result).toBeNull();
  });

  // The whole point of the lookback: a backlog of older automated mail sitting in the inbox
  // before the user ever connected must never be classified or shown — only genuinely recent
  // mail (the 24 hours before connecting) is worth surfacing as a "wow moment".
  it("only classifies and previews mail from the last 24 hours", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("onboard-lookback"));
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25h ago
    const recent = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(); // 1h ago
    mockHubListMessages.mockResolvedValueOnce([
      fakeMessage({ id: "stale-1", subject: "Old renewal notice", receivedAt: old }),
      fakeMessage({ id: "fresh-1", subject: "Flight changed", receivedAt: recent }),
    ]);
    mockClassify.mockResolvedValueOnce(
      new Map([[0, { category: "flight_change", summary: "Gate moved to B12." }]])
    );

    const result = await scanAndCurateImportantEmailsForOnboarding(user.id);

    // Only the recent message reached the classifier.
    expect(mockClassify).toHaveBeenCalledTimes(1);
    const [candidates] = mockClassify.mock.calls[0];
    expect(candidates.map((c: { subject: string }) => c.subject)).toEqual(["Flight changed"]);
    expect(result?.lines).toEqual(["✈️ Gate moved to B12."]);
  });

  it("never classifies or previews a verification/login code, even one from the last 24 hours", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("onboard-verification-code"));
    mockHubListMessages.mockResolvedValueOnce([
      fakeMessage({ id: "code-1", subject: "Your one-time code", snippet: "Your code is 552013." }),
    ]);

    const result = await scanAndCurateImportantEmailsForOnboarding(user.id);

    expect(result).toEqual({ lines: [], moreCount: 0 });
    expect(mockClassify).not.toHaveBeenCalled();
  });
});

describe("checkForImportantEmails — invoice forward offer", () => {
  it("offers to forward and sets pending state when Xero is connected and the email has an attachment", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("invoice-offer"));
    const phone = registerActivePhone(user.id);
    setXeroForwardingEmail(user.id, "abc123@bills.xero.com");
    await baseline(user.id);

    mockHubListNewMessages.mockResolvedValueOnce([
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

    mockHubListNewMessages.mockResolvedValueOnce([fakeMessage({ id: "inv-2" })]);
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

    mockHubListNewMessages.mockResolvedValueOnce([fakeMessage({ id: "inv-3" })]);
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

    mockHubListNewMessages.mockResolvedValueOnce([fakeMessage({ id: "inv-text", subject: "Your receipt" })]);
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

    mockHubListNewMessages.mockResolvedValueOnce([
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

    mockHubListNewMessages.mockResolvedValueOnce([fakeMessage({ id: "inv-4" })]);
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
  it("greets the user by name, leads with the emoji, and shows no email address or robotic label/subject", () => {
    const text = formatImportantEmailAlert(
      fakeMessage({ subject: "Your invoice is due", from: "billing@vendor.com", snippet: "£120 due 1 Sep" }),
      "invoice_due",
      "Sam"
    );
    expect(text).toBe("💳 Sam, £120 due 1 Sep");
    expect(text).not.toContain("@");
    expect(text).not.toContain("Invoice/payment due");
    expect(text).not.toContain("Your invoice is due"); // the raw subject line, not the summary/snippet
  });

  it("omits the greeting entirely when no name is known yet", () => {
    const text = formatImportantEmailAlert(
      fakeMessage({ snippet: "£120 due 1 Sep" }),
      "invoice_due",
      null
    );
    expect(text).toBe("💳 £120 due 1 Sep");
  });

  it("falls back to the raw snippet when no summary is given", () => {
    const text = formatImportantEmailAlert(fakeMessage({ snippet: "£120 due 1 Sep" }), "invoice_due", "Sam");
    expect(text).toContain("£120 due 1 Sep");
  });

  it("prefers the model-written summary (which may carry *bold* markers) over the raw snippet", () => {
    const text = formatImportantEmailAlert(
      fakeMessage({ snippet: "You&#39;ve got an invoice&hellip; view it here..." }),
      "invoice_due",
      "Sam",
      "*£120* is due on *1 September*."
    );
    expect(text).toContain("*£120* is due on *1 September*.");
    expect(text).not.toContain("&#39;");
  });
});
