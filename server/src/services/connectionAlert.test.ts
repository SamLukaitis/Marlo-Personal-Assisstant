import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// A dead Google/Microsoft token used to be visible only on the web Settings page. These tests pin
// the WhatsApp side: one message when an account first breaks, sent through the attention gate.
const mockGoogleListMessages = vi.fn();
vi.mock("../providers/google.js", () => ({
  googleListMessages: (...args: unknown[]) => mockGoogleListMessages(...args),
}));
vi.mock("../providers/whatsapp.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../providers/whatsapp.js")>();
  return {
    ...actual,
    sendWhatsAppMessage: vi.fn(),
    sendWhatsAppTemplate: vi.fn(),
    isWhatsAppConfigured: vi.fn().mockReturnValue(true),
  };
});
// Same reason as attention.test.ts: the real module drags attention.ts in through a cycle.
vi.mock("./phoneActions.js", () => ({
  phoneSuggestionsEnabled: vi.fn(() => false),
  createPhoneAction: vi.fn(),
  PROACTIVE_TTL_MS: 36 * 60 * 60 * 1000,
}));

const { sendWhatsAppMessage, sendWhatsAppTemplate } = await import("../providers/whatsapp.js");
const {
  findOrCreateUserByEmail,
  addPhoneNumberForUser,
  recordInboundMessage,
  upsertAccount,
  getAccount,
  markAccountAuthHealthy,
  listAttentionItems,
} = await import("../db/store.js");
const { setUserTimezone } = await import("./userTimezone.js");
const { hubListMessages } = await import("./hub.js");
const { deliverDueAttentionItems } = await import("./attention.js");
const { DateTime } = await import("luxon");

const ZONE = "Europe/London";
let counter = 0;

// Phone prefix "44700012" — unique to this file (see importantEmailAlerts.test.ts on shared prefixes).
function userWithGmail() {
  counter += 1;
  const user = findOrCreateUserByEmail(`conn-alert-${Date.now()}-${counter}@example.com`);
  const phone = `44700012${String(counter).padStart(4, "0")}`;
  addPhoneNumberForUser(user.id, phone);
  recordInboundMessage(phone);
  setUserTimezone(user.id, ZONE);
  const account = upsertAccount(user.id, {
    provider: "google",
    email: `gmail-${Date.now()}-${counter}@example.com`,
    accessToken: "t",
    refreshToken: "r",
    expiryDate: null,
  });
  return { ownerId: user.id, account };
}

// The shape googleapis (gaxios) throws when a refresh token has been revoked or has expired.
function invalidGrant() {
  return Object.assign(new Error("invalid_grant"), { response: { status: 400, data: { error: "invalid_grant" } } });
}

function sentTexts(): string[] {
  return [
    ...vi.mocked(sendWhatsAppMessage).mock.calls.map(([, text]) => text as string),
    ...vi.mocked(sendWhatsAppTemplate).mock.calls.map(([, , text]) => text as string),
  ];
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

beforeEach(() => {
  mockGoogleListMessages.mockReset();
  vi.mocked(sendWhatsAppMessage).mockReset();
  vi.mocked(sendWhatsAppTemplate).mockReset();
  vi.mocked(sendWhatsAppMessage).mockResolvedValue("wamid.x" as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("broken-connection WhatsApp alert", () => {
  it("sends one message, naming the mailbox and how to reconnect, when an account first breaks", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(DateTime.fromISO("2026-10-20T11:00", { zone: ZONE }).toJSDate());
    const { ownerId, account } = userWithGmail();
    mockGoogleListMessages.mockRejectedValue(invalidGrant());

    await hubListMessages(ownerId, { limit: 10 });

    await vi.waitFor(() => expect(sentTexts()).toHaveLength(1));
    const [text] = sentTexts();
    expect(text).toContain("*Gmail*");
    expect(text).toContain(account.email);
    expect(text).toMatch(/reply \*reconnect\*/i);
    expect(getAccount(ownerId, account.id)?.authBroken).toBe(true);
  });

  it("doesn't send again on later failed polls of the same breakage", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(DateTime.fromISO("2026-10-20T11:00", { zone: ZONE }).toJSDate());
    const { ownerId } = userWithGmail();
    mockGoogleListMessages.mockRejectedValue(invalidGrant());

    await hubListMessages(ownerId, { limit: 10 });
    await vi.waitFor(() => expect(sentTexts()).toHaveLength(1));
    await hubListMessages(ownerId, { limit: 10 });
    await hubListMessages(ownerId, { limit: 10 });
    await settle();

    expect(sentTexts()).toHaveLength(1);
  });

  // Gmail answers a burst of requests with 403 rateLimitExceeded. That's not a dead token, and
  // telling the user to reconnect over it would be wrong.
  it("treats a rate-limit 403 as a passing failure, not a broken connection", async () => {
    const { ownerId, account } = userWithGmail();
    mockGoogleListMessages.mockRejectedValue(
      Object.assign(new Error("User-rate limit exceeded"), {
        response: { status: 403, data: { error: { errors: [{ reason: "userRateLimitExceeded" }] } } },
      })
    );

    await hubListMessages(ownerId, { limit: 10 });
    await settle();

    expect(getAccount(ownerId, account.id)?.authBroken).toBe(false);
    expect(sentTexts()).toHaveLength(0);
  });

  it("waits out quiet hours, and drops the alert if the account was reconnected in the meantime", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(DateTime.fromISO("2026-10-20T23:30", { zone: ZONE }).toJSDate());
    const { ownerId, account } = userWithGmail();
    mockGoogleListMessages.mockRejectedValue(invalidGrant());

    await hubListMessages(ownerId, { limit: 10 });
    await vi.waitFor(() => expect(listAttentionItems(ownerId, { statuses: ["pending"] })).toHaveLength(1));
    expect(sentTexts()).toHaveLength(0);

    markAccountAuthHealthy(ownerId, account.id);
    vi.setSystemTime(DateTime.fromISO("2026-10-21T08:00", { zone: ZONE }).toJSDate());
    await deliverDueAttentionItems(ownerId);

    expect(sentTexts()).toHaveLength(0);
    expect(listAttentionItems(ownerId, { statuses: ["pending"] })).toHaveLength(0);
  });

  it("sends the deferred alert in the morning when the account is still broken", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(DateTime.fromISO("2026-10-20T23:30", { zone: ZONE }).toJSDate());
    const { ownerId } = userWithGmail();
    mockGoogleListMessages.mockRejectedValue(invalidGrant());

    await hubListMessages(ownerId, { limit: 10 });
    await vi.waitFor(() => expect(listAttentionItems(ownerId, { statuses: ["pending"] })).toHaveLength(1));

    vi.setSystemTime(DateTime.fromISO("2026-10-21T08:00", { zone: ZONE }).toJSDate());
    await deliverDueAttentionItems(ownerId);

    expect(sentTexts()).toHaveLength(1);
  });
});
