import { describe, it, expect, vi, beforeEach } from "vitest";

// A briefing built over a dead Gmail token used to read "no new mail" — the email section just
// came back empty. It now says the mailbox couldn't be read, in a line the model can't drop.
const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: (...args: unknown[]) => mockCreate(...args) };
  },
}));
const mockGoogleListMessages = vi.fn();
const mockGoogleListEvents = vi.fn();
vi.mock("../providers/google.js", () => ({
  googleListMessages: (...args: unknown[]) => mockGoogleListMessages(...args),
  googleListEvents: (...args: unknown[]) => mockGoogleListEvents(...args),
}));
vi.mock("../providers/whatsapp.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../providers/whatsapp.js")>();
  return { ...actual, isWhatsAppConfigured: vi.fn().mockReturnValue(false) };
});

process.env.ANTHROPIC_API_KEY ??= "test-key";

const { findOrCreateUserByEmail, upsertAccount, markAccountAuthBroken } = await import("../db/store.js");
const { refreshBriefing, saveBriefingSettings, briefingFactBlock, isQuietDay, connectionNoticeLines } = await import(
  "./briefing.js"
);

let counter = 0;
function userWith(provider: "google" | "microsoft") {
  counter += 1;
  const user = findOrCreateUserByEmail(`brief-conn-${Date.now()}-${counter}@example.com`);
  saveBriefingSettings(user.id, {
    enabled: true,
    includeNews: false,
    topics: [],
    includeMarkets: false,
    tickers: [],
    includeWeather: false,
    weatherLocation: "",
    proactive: false,
    sendTime: "07:30",
  });
  const account = upsertAccount(user.id, {
    provider,
    email: `inbox-${Date.now()}-${counter}@example.com`,
    accessToken: "t",
    refreshToken: "r",
    expiryDate: null,
  });
  return { ownerId: user.id, account };
}

const invalidGrant = () =>
  Object.assign(new Error("invalid_grant"), { response: { status: 400, data: { error: "invalid_grant" } } });

const emptyDay = {
  localTime: "07:30",
  localWeekday: "Tuesday",
  location: "",
  weather: null,
  quotes: [],
  unread: { count: 0, shown: [] },
  todayEvents: [],
  upcomingEvents: [],
  flagged: [],
  news: [],
};

beforeEach(() => {
  mockCreate.mockReset();
  mockCreate.mockResolvedValue({ content: [{ type: "text", text: "Morning Sam — quiet one today." }], usage: {} });
  mockGoogleListMessages.mockReset();
  mockGoogleListEvents.mockReset();
});

describe("briefing over a broken connection", () => {
  it("says the Gmail couldn't be read and how to reconnect, instead of leaving email out", async () => {
    const { ownerId, account } = userWith("google");
    mockGoogleListMessages.mockRejectedValue(invalidGrant());
    mockGoogleListEvents.mockRejectedValue(invalidGrant());

    const { content } = await refreshBriefing(ownerId);

    expect(content).toContain("Morning Sam");
    expect(content).toMatch(/I couldn't read your \*Gmail\*/);
    expect(content).toContain(account.email);
    expect(content).toMatch(/reply \*reconnect\*/i);
  });

  it("tells the model the mailbox couldn't be read, so it never calls the day quiet", async () => {
    const { ownerId, account } = userWith("google");
    mockGoogleListMessages.mockRejectedValue(invalidGrant());
    mockGoogleListEvents.mockRejectedValue(invalidGrant());

    await refreshBriefing(ownerId);

    const facts = mockCreate.mock.calls[0][0].messages[0].content as string;
    expect(facts).toContain(account.email);
    expect(facts).not.toContain("QUIET DAY");
  });

  it("adds nothing when every connection is healthy", async () => {
    const { ownerId } = userWith("google");
    mockGoogleListMessages.mockResolvedValue([]);
    mockGoogleListEvents.mockResolvedValue([]);

    const { content } = await refreshBriefing(ownerId);

    expect(content).toBe("Morning Sam — quiet one today.");
  });

  it("names Outlook for a broken Microsoft account", () => {
    const { ownerId, account } = userWith("microsoft");
    markAccountAuthBroken(ownerId, account.id);

    expect(connectionNoticeLines(ownerId)).toEqual([expect.stringMatching(/I couldn't read your \*Outlook\*/)]);
  });

  it("a day with a broken connection is not a quiet day", () => {
    const day = { ...emptyDay, brokenConnections: ["Gmail (a@example.com)"] };

    expect(isQuietDay(day)).toBe(false);
    expect(briefingFactBlock(day)).toContain("Gmail (a@example.com)");
  });
});
