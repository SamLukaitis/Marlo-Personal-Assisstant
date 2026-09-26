// server/src/services/alerts.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
vi.mock("./hub.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./hub.js")>();
  return { ...actual, hubListNewMessages: (...args: unknown[]) => mockHubListNewMessages(...args) };
});

const mockTriage = vi.fn();
vi.mock("./realPersonTriage.js", () => ({
  triageRealPersonEmails: (...args: unknown[]) => mockTriage(...args),
}));

const { sendWhatsAppMessage, isWhatsAppConfigured } = await import("../providers/whatsapp.js");
const {
  findOrCreateUserByEmail,
  addPhoneNumberForUser,
  recordInboundMessage,
  hasAlerted,
  saveEntity,
  setSetting,
  setPendingSetup,
  getWhatsAppHistory,
} = await import("../db/store.js");
const { resolveQuotedMessageContext } = await import("./quotedMessage.js");
const { checkForNewImportantMessages } = await import("./alerts.js");
const { setRealPersonAlertsEnabled, realPersonAlertsEnabledSince, setRealPersonAlertMode } = await import(
  "./emailAlertSettings.js"
);
const { queuedEmailDigestCount } = await import("./emailDigest.js");
const { takeSuppressedOnboardingAlertCount } = await import("./onboardingAlertSuppression.js");

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

// See importantEmailAlerts.test.ts's own comment on phone number prefixes shared across test
// files — this file uses "44700006".
function freshPhone(): string {
  counter += 1;
  return `44700006${String(counter).padStart(4, "0")}`;
}

// Digest is the default mode; most tests here are about the per-email ping, so this opts the user
// into instant. The digest tests switch back to "digest" explicitly.
function registerActivePhone(ownerId: number): string {
  setRealPersonAlertMode(ownerId, "instant");
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
    bulk: boolean;
  }>
) {
  return {
    id: "msg-1",
    accountId: 1,
    accountEmail: "test@example.com",
    provider: "google" as const,
    subject: "Subject",
    from: "jane@example.com",
    snippet: "snippet",
    receivedAt: new Date().toISOString(),
    unread: true,
    ...overrides,
  };
}

async function baseline(ownerId: number) {
  mockHubListNewMessages.mockResolvedValueOnce([]);
  await checkForNewImportantMessages(ownerId);
}

beforeEach(() => {
  vi.mocked(sendWhatsAppMessage).mockReset();
  vi.mocked(isWhatsAppConfigured).mockReset().mockReturnValue(true);
  mockHubListNewMessages.mockReset();
  mockTriage.mockReset().mockResolvedValue(new Map());
});

describe("checkForNewImportantMessages", () => {
  // Reported: turned real-person alerts on, emailed immediately, never got a ping — the first
  // tick after enabling treated that email as pre-existing inbox and swallowed it.
  it("alerts on mail that arrived after the user switched alerts on, even on the baseline run", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("alerts-baseline-after-enable"));
    const phone = registerActivePhone(user.id);
    setRealPersonAlertsEnabled(user.id, false);
    setRealPersonAlertsEnabled(user.id, true);
    const enabledAt = realPersonAlertsEnabledSince(user.id);
    mockHubListNewMessages.mockResolvedValueOnce([
      fakeMessage({ id: "before", receivedAt: new Date(enabledAt - 3_600_000).toISOString() }),
      fakeMessage({ id: "after", subject: "Sent after enabling", receivedAt: new Date(enabledAt + 30_000).toISOString() }),
    ]);

    await checkForNewImportantMessages(user.id);

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    const [sentTo, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(sentTo).toBe(phone);
    expect(text).toContain("Sent after enabling");
    expect(hasAlerted(user.id, "1:before")).toBe(true);
  });

  it("baselines the existing inbox on first run without notifying", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("alerts-baseline"));
    mockHubListNewMessages.mockResolvedValueOnce([fakeMessage({ id: "old-1" })]);

    await checkForNewImportantMessages(user.id);

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(hasAlerted(user.id, "1:old-1")).toBe(true);
  });

  // The actual bug fix: a user who opens a real person's email the moment it arrives (entirely
  // normal) must not lose the alert. hasAlerted's per-message ledger is the real "already
  // handled" check, independent of read status — unread was a redundant, strictly worse
  // substitute that silently and permanently dropped a message read before this scan ever saw it.
  it("notifies for a real person's message regardless of whether it's already been read", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("alerts-read-status"));
    const phone = registerActivePhone(user.id);
    await baseline(user.id);

    mockHubListNewMessages.mockResolvedValueOnce([
      fakeMessage({ id: "already-read", unread: false, from: "jane@example.com", subject: "Already read" }),
    ]);

    await checkForNewImportantMessages(user.id);

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    const [sentTo, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(sentTo).toBe(phone);
    expect(text).toContain("Already read");
  });

  it("in digest mode queues a real person's email for the daily summary instead of pinging", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("alerts-digest-mode"));
    registerActivePhone(user.id);
    await baseline(user.id);
    setRealPersonAlertMode(user.id, "digest");

    mockHubListNewMessages.mockResolvedValueOnce([
      fakeMessage({ id: "d1", subject: "Lunch?", from: "Sarah <sarah@example.com>" }),
      fakeMessage({ id: "d2", subject: "Results", from: "Dr Patel <patel@example.com>" }),
    ]);
    await checkForNewImportantMessages(user.id);

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(queuedEmailDigestCount(user.id)).toBe(2);
    expect(hasAlerted(user.id, "1:d1")).toBe(true);

    // Already handled, so a rescan can't queue it a second time.
    mockHubListNewMessages.mockResolvedValueOnce([fakeMessage({ id: "d1", from: "Sarah <sarah@example.com>" })]);
    await checkForNewImportantMessages(user.id);
    expect(queuedEmailDigestCount(user.id)).toBe(2);
  });

  it("in digest mode still drops what triage says to skip, rather than queueing it", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("alerts-digest-triage"));
    registerActivePhone(user.id);
    await baseline(user.id);
    setRealPersonAlertMode(user.id, "digest");
    mockTriage.mockResolvedValueOnce(new Map([[0, "not_personal"]]));

    mockHubListNewMessages.mockResolvedValueOnce([fakeMessage({ id: "promo", from: "Shop <hi@shop.com>" })]);
    await checkForNewImportantMessages(user.id);

    expect(queuedEmailDigestCount(user.id)).toBe(0);
    expect(hasAlerted(user.id, "1:promo")).toBe(true);
  });

  // Reported: replying "yes" (or swipe-replying) to an alert got "I don't see a pending question" —
  // the alert wasn't in history and had no wamid. The ids are in history only, never in the text sent.
  it("records the alert in history with the email's ids, and a swipe-reply to it resolves to that", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("alerts-quotable"));
    const phone = registerActivePhone(user.id);
    await baseline(user.id);
    vi.mocked(sendWhatsAppMessage).mockResolvedValue("wamid.ALERT1");
    mockHubListNewMessages.mockResolvedValueOnce([
      fakeMessage({ id: "gmail-77", accountId: 5, subject: "Testing", from: "Sam <sam@example.com>" }),
    ]);

    await checkForNewImportantMessages(user.id);

    const [, sentText] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(sentText).not.toContain("gmail-77");
    const last = getWhatsAppHistory(phone).at(-1)!;
    expect(last.role).toBe("assistant");
    expect(last.content).toContain("Testing");
    expect(last.content).toContain("account_id=5");
    expect(last.content).toContain("message_id=gmail-77");
    expect(last.content).toContain("sam@example.com");
    const quoted = resolveQuotedMessageContext(user.id, "wamid.ALERT1", false);
    expect(quoted).toContain("message_id=gmail-77");
    expect(quoted).not.toContain("can't see");
  });

  it("ignores automated-sender mail regardless of read status", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("alerts-automated"));
    registerActivePhone(user.id);
    await baseline(user.id);

    mockHubListNewMessages.mockResolvedValueOnce([
      fakeMessage({ id: "automated-1", from: "no-reply@delta.com" }),
    ]);

    await checkForNewImportantMessages(user.id);

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it("ignores marketing mail the provider flagged as bulk, even from an ordinary-looking address", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("alerts-bulk"));
    registerActivePhone(user.id);
    await baseline(user.id);

    mockHubListNewMessages.mockResolvedValueOnce([
      fakeMessage({ id: "bulk-1", from: "Babbel <hello@babbel.com>", bulk: true }),
    ]);

    await checkForNewImportantMessages(user.id);

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it("does not re-notify for the same message on a later tick", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("alerts-dedup"));
    registerActivePhone(user.id);
    await baseline(user.id);

    mockHubListNewMessages.mockResolvedValue([fakeMessage({ id: "msg-2" })]);

    await checkForNewImportantMessages(user.id);
    await checkForNewImportantMessages(user.id);

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
  });

  it("greets the user by name and shows the sender's display name, never a raw email address", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("alerts-format"));
    registerActivePhone(user.id);
    setSetting(user.id, "user_name", "Sam");
    await baseline(user.id);

    mockHubListNewMessages.mockResolvedValueOnce([
      fakeMessage({
        id: "fmt-1",
        from: '"Jane Doe" <jane@example.com>',
        subject: "Quick question",
        snippet: "Are you free Thursday?",
      }),
    ]);

    await checkForNewImportantMessages(user.id);

    const [, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(text).toContain("Sam");
    expect(text).toContain("Jane Doe");
    expect(text).not.toContain("@");
    expect(text).toContain("Quick question");
    expect(text).toContain("Are you free Thursday?");
  });

  it("omits the greeting when no name is known yet", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("alerts-format-noname"));
    registerActivePhone(user.id);
    await baseline(user.id);

    mockHubListNewMessages.mockResolvedValueOnce([fakeMessage({ id: "fmt-2", from: "jane@example.com" })]);

    await checkForNewImportantMessages(user.id);

    const [, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(text).not.toContain("@");
    expect(text).toContain("jane"); // local-part fallback display name
  });

  // Same onboarding-window suppression as importantEmailAlerts.ts (see that file's test of the
  // same name for the full rationale) — a real bug where a fresh connection's mail backlog got
  // pushed as separate WhatsApp alerts interleaved with onboarding's own questions.
  it("records but does not send while onboarding is still in progress", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("alerts-mid-onboarding"));
    registerActivePhone(user.id);
    await baseline(user.id);
    setPendingSetup(user.id, "ask_briefing");

    mockHubListNewMessages.mockResolvedValueOnce([
      fakeMessage({ id: "onb-1", from: "jane@example.com" }),
      fakeMessage({ id: "onb-2", from: "bob@example.com" }),
    ]);

    await checkForNewImportantMessages(user.id);

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(hasAlerted(user.id, "1:onb-1")).toBe(true);
    expect(hasAlerted(user.id, "1:onb-2")).toBe(true);
    expect(takeSuppressedOnboardingAlertCount(user.id)).toBe(2);
  });
});

// The scan used to drop or suppress mail without leaving any trace, so "I emailed it and got no
// alert" could not be diagnosed from the logs. These pin one line per scan that saw any mail,
// naming the gate that decided it — and never containing the mail's content.
describe("checkForNewImportantMessages diagnostics", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  const scanLogs = () => logSpy.mock.calls.map((c) => c.join(" ")).filter((l) => l.startsWith("alerts:"));

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it("stays silent when the scan fetched no mail at all", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("diag-quiet"));
    registerActivePhone(user.id);
    await baseline(user.id);
    logSpy.mockClear();
    mockHubListNewMessages.mockResolvedValueOnce([]);

    await checkForNewImportantMessages(user.id);

    expect(scanLogs()).toEqual([]);
  });

  it("logs the baseline run with how many messages it swallowed", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("diag-baseline"));
    mockHubListNewMessages.mockResolvedValueOnce([
      fakeMessage({ id: "old-1", receivedAt: new Date(Date.now() - 3_600_000).toISOString() }),
    ]);

    await checkForNewImportantMessages(user.id);

    expect(scanLogs().join("\n")).toMatch(new RegExp(`owner ${user.id}.*baselined 1`));
  });

  it("logs a delivered alert with counts, and never the subject, sender or snippet", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("diag-sent"));
    registerActivePhone(user.id);
    await baseline(user.id);
    logSpy.mockClear();
    mockHubListNewMessages.mockResolvedValueOnce([
      fakeMessage({ id: "d-1", subject: "Secret subject", from: "jane@example.com", snippet: "secret snippet" }),
    ]);

    await checkForNewImportantMessages(user.id);

    const out = scanLogs().join("\n");
    expect(out).toMatch(new RegExp(`owner ${user.id}.*sent 1`));
    expect(out).not.toMatch(/Secret subject|jane@example\.com|secret snippet/);
  });

  it("names onboarding suppression as the reason when it swallows mail", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("diag-suppressed"));
    registerActivePhone(user.id);
    await baseline(user.id);
    setPendingSetup(user.id, "ask_briefing");
    logSpy.mockClear();
    mockHubListNewMessages.mockResolvedValueOnce([fakeMessage({ id: "s-1" })]);

    await checkForNewImportantMessages(user.id);

    expect(scanLogs().join("\n")).toMatch(new RegExp(`owner ${user.id}.*suppressed by onboarding.*1`));
  });

  it("names the missing registered number when there is nowhere to send", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("diag-nonumber"));
    await baseline(user.id);
    logSpy.mockClear();
    mockHubListNewMessages.mockResolvedValueOnce([fakeMessage({ id: "n-1" })]);

    await checkForNewImportantMessages(user.id);

    expect(scanLogs().join("\n")).toMatch(new RegExp(`owner ${user.id}.*no registered phone number`));
  });

  it("names unconfigured WhatsApp when that is what stopped the alert", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("diag-noconfig"));
    registerActivePhone(user.id);
    await baseline(user.id);
    vi.mocked(isWhatsAppConfigured).mockReturnValue(false);
    logSpy.mockClear();
    mockHubListNewMessages.mockResolvedValueOnce([fakeMessage({ id: "c-1" })]);

    await checkForNewImportantMessages(user.id);

    expect(scanLogs().join("\n")).toMatch(new RegExp(`owner ${user.id}.*WhatsApp is not configured`));
  });

  it("says when everything fetched was automated mail or already handled", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("diag-nocandidates"));
    registerActivePhone(user.id);
    await baseline(user.id);
    logSpy.mockClear();
    mockHubListNewMessages.mockResolvedValueOnce([fakeMessage({ id: "a-1", from: "no-reply@delta.com" })]);

    await checkForNewImportantMessages(user.id);

    expect(scanLogs().join("\n")).toMatch(new RegExp(`owner ${user.id}.*no real-person mail`));
  });
});

describe("checkForNewImportantMessages triage", () => {
  it("does not alert on mail the triage rules out, and never revisits it", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("triage-skip"));
    registerActivePhone(user.id);
    await baseline(user.id);
    mockTriage.mockResolvedValueOnce(new Map([[0, "not_personal"]]));
    mockHubListNewMessages.mockResolvedValue([
      fakeMessage({ id: "promo", from: "UNiDAYS <hello@myunidays.com>", subject: "VIP access" }),
    ]);

    await checkForNewImportantMessages(user.id);
    await checkForNewImportantMessages(user.id);

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(mockTriage).toHaveBeenCalledTimes(1);
    expect(hasAlerted(user.id, "1:promo")).toBe(true);
  });

  it("alerts on the rest of the batch when only some mail is ruled out", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("triage-partial"));
    registerActivePhone(user.id);
    await baseline(user.id);
    mockTriage.mockResolvedValueOnce(new Map([[0, "not_personal"]]));
    mockHubListNewMessages.mockResolvedValueOnce([
      fakeMessage({ id: "promo", subject: "Big sale" }),
      fakeMessage({ id: "friend", subject: "Dinner?" }),
    ]);

    await checkForNewImportantMessages(user.id);

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendWhatsAppMessage).mock.calls[0][1]).toContain("Dinner?");
  });

  it("shows the triage the important-email alerts already sent in the last two days", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("triage-recent"));
    registerActivePhone(user.id);
    await baseline(user.id);
    saveEntity(user.id, {
      type: "important_email",
      data: { summary: "Your reservation at *Wild Rover Cusco* is confirmed." },
    });
    mockHubListNewMessages.mockResolvedValueOnce([fakeMessage({ id: "venue", from: "cusco@hostel.example" })]);

    await checkForNewImportantMessages(user.id);

    expect(mockTriage.mock.calls[0][1]).toEqual(["Your reservation at *Wild Rover Cusco* is confirmed."]);
  });

  it("still alerts when the triage call fails", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("triage-fail"));
    registerActivePhone(user.id);
    await baseline(user.id);
    mockTriage.mockRejectedValueOnce(new Error("api down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockHubListNewMessages.mockResolvedValueOnce([fakeMessage({ id: "p-1", subject: "Hi there" })]);

    await checkForNewImportantMessages(user.id);

    errorSpy.mockRestore();
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
  });

  it("sends a tidied preview: entities decoded", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("triage-tidy"));
    registerActivePhone(user.id);
    await baseline(user.id);
    mockHubListNewMessages.mockResolvedValueOnce([
      fakeMessage({ id: "t-1", snippet: "Room type: everyone&#39;s favourite Pod-Style." }),
    ]);

    await checkForNewImportantMessages(user.id);

    const text = vi.mocked(sendWhatsAppMessage).mock.calls[0][1] as string;
    expect(text).toContain("everyone's favourite Pod-Style.");
    expect(text).not.toContain("&#39;");
  });
});
