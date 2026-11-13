import { describe, it, expect, vi, beforeEach } from "vitest";

// hub.ts's own permission logic is what's under test here — the actual Google/Microsoft API
// calls are mocked out entirely, same posture as reconciliation.test.ts/xeroForwarding.test.ts
// mocking whatsapp.ts.
const mockGoogleListMessages = vi.fn();
const mockGoogleSendMessage = vi.fn();
const mockGoogleArchiveMessages = vi.fn();
const mockGoogleGetMessage = vi.fn();
const mockGoogleListNewMessages = vi.fn();
const mockGoogleListEvents = vi.fn();
vi.mock("../providers/google.js", () => ({
  googleListMessages: (...args: unknown[]) => mockGoogleListMessages(...args),
  googleSendMessage: (...args: unknown[]) => mockGoogleSendMessage(...args),
  googleArchiveMessages: (...args: unknown[]) => mockGoogleArchiveMessages(...args),
  googleGetMessage: (...args: unknown[]) => mockGoogleGetMessage(...args),
  googleListNewMessages: (...args: unknown[]) => mockGoogleListNewMessages(...args),
  googleListEvents: (...args: unknown[]) => mockGoogleListEvents(...args),
}));
const mockMicrosoftSendMessage = vi.fn();
const mockMicrosoftListChats = vi.fn();
const mockMicrosoftListNewMessages = vi.fn();
vi.mock("../providers/microsoft.js", () => ({
  microsoftListNewMessages: (...args: unknown[]) => mockMicrosoftListNewMessages(...args),
  microsoftSendMessage: (...args: unknown[]) => mockMicrosoftSendMessage(...args),
  microsoftListChats: (...args: unknown[]) => mockMicrosoftListChats(...args),
}));

const { findOrCreateUserByEmail, upsertAccount, updateAccountPermissions, searchReadEmails, getAccount } =
  await import("../db/store.js");
const {
  hubListMessages,
  hubSendMessage,
  hubArchiveMessages,
  hubGetMessage,
  hubListNewMessages,
  holdNewMessageCheckpoint,
  withMessageCache,
  senderDisplayName,
  isAutomatedMail,
  hubListEvents,
  hubListChats,
} = await import("./hub.js");

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

function fakeMessage(accountId: number, id: string) {
  return {
    id,
    accountId,
    accountEmail: `acct-${accountId}@example.com`,
    provider: "google" as const,
    subject: "Subject",
    from: "someone@example.com",
    snippet: "snippet",
    receivedAt: new Date().toISOString(),
    unread: true,
  };
}

beforeEach(() => {
  mockGoogleListMessages.mockReset();
  mockGoogleSendMessage.mockReset();
  mockGoogleArchiveMessages.mockReset();
  mockGoogleGetMessage.mockReset();
  mockGoogleListNewMessages.mockReset();
});

describe("per-account permission enforcement", () => {
  it("hubSendMessage throws when the account's canSend is turned off", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("hub-send-off"));
    const account = upsertAccount(user.id, {
      provider: "google",
      email: uniqueEmail("inbox-send-off"),
      accessToken: "t",
      refreshToken: "r",
      expiryDate: null,
    });
    updateAccountPermissions(user.id, account.id, { canSend: false });

    await expect(
      hubSendMessage(user.id, account.id, "to@example.com", "Subject", "Body")
    ).rejects.toThrow(/[Ss]ending is turned off/);
    expect(mockGoogleSendMessage).not.toHaveBeenCalled();
  });

  it("hubSendMessage succeeds when canSend is on (the default)", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("hub-send-on"));
    const account = upsertAccount(user.id, {
      provider: "google",
      email: uniqueEmail("inbox-send-on"),
      accessToken: "t",
      refreshToken: "r",
      expiryDate: null,
    });
    mockGoogleSendMessage.mockResolvedValue({ messageId: "m1", provider: "google", accountEmail: account.email });

    await expect(
      hubSendMessage(user.id, account.id, "to@example.com", "Subject", "Body")
    ).resolves.toMatchObject({ messageId: "m1" });
    expect(mockGoogleSendMessage).toHaveBeenCalledTimes(1);
  });

  it("hubSendMessage sends from an Outlook account through the Microsoft provider", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("hub-send-ms"));
    const account = upsertAccount(user.id, {
      provider: "microsoft",
      email: uniqueEmail("inbox-send-ms"),
      accessToken: "t",
      refreshToken: "r",
      expiryDate: null,
    });
    mockMicrosoftSendMessage.mockResolvedValue({ messageId: "", provider: "microsoft", accountEmail: account.email });

    await expect(
      hubSendMessage(user.id, account.id, "to@example.com", "Subject", "Body")
    ).resolves.toMatchObject({ provider: "microsoft" });
    expect(mockMicrosoftSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: account.id }),
      "to@example.com",
      "Subject",
      "Body",
      undefined
    );
    expect(mockGoogleSendMessage).not.toHaveBeenCalled();
  });

  it("hubArchiveMessages throws when the account's canDelete is turned off", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("hub-archive-off"));
    const account = upsertAccount(user.id, {
      provider: "google",
      email: uniqueEmail("inbox-archive-off"),
      accessToken: "t",
      refreshToken: "r",
      expiryDate: null,
    });
    updateAccountPermissions(user.id, account.id, { canDelete: false });

    await expect(hubArchiveMessages(user.id, account.id, "from:nike")).rejects.toThrow(
      /[Aa]rchiving\/deleting is turned off/
    );
    expect(mockGoogleArchiveMessages).not.toHaveBeenCalled();
  });

  it("hubGetMessage throws when the account's canRead is turned off", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("hub-read-off"));
    const account = upsertAccount(user.id, {
      provider: "google",
      email: uniqueEmail("inbox-read-off"),
      accessToken: "t",
      refreshToken: "r",
      expiryDate: null,
    });
    updateAccountPermissions(user.id, account.id, { canRead: false });

    await expect(hubGetMessage(user.id, account.id, "msg-1")).rejects.toThrow(/[Rr]eading is turned off/);
  });

  it("hubListMessages with no accountId silently excludes read-restricted accounts from the aggregate", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("hub-list-agg"));
    const readable = upsertAccount(user.id, {
      provider: "google",
      email: uniqueEmail("inbox-readable"),
      accessToken: "t",
      refreshToken: "r",
      expiryDate: null,
    });
    const restricted = upsertAccount(user.id, {
      provider: "google",
      email: uniqueEmail("inbox-restricted"),
      accessToken: "t",
      refreshToken: "r",
      expiryDate: null,
    });
    updateAccountPermissions(user.id, restricted.id, { canRead: false });

    mockGoogleListMessages.mockImplementation(async (account: { id: number }) => [
      fakeMessage(account.id, `msg-${account.id}`),
    ]);

    const results = await hubListMessages(user.id, {});
    expect(results).toHaveLength(1);
    expect(results[0].accountId).toBe(readable.id);
    expect(mockGoogleListMessages).toHaveBeenCalledTimes(1);
  });

  it("hubListMessages with an explicit accountId still throws for a read-restricted account", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("hub-list-explicit"));
    const account = upsertAccount(user.id, {
      provider: "google",
      email: uniqueEmail("inbox-explicit-off"),
      accessToken: "t",
      refreshToken: "r",
      expiryDate: null,
    });
    updateAccountPermissions(user.id, account.id, { canRead: false });

    await expect(hubListMessages(user.id, { accountId: account.id })).rejects.toThrow(
      /[Rr]eading is turned off/
    );
    expect(mockGoogleListMessages).not.toHaveBeenCalled();
  });
});

describe("read_emails cache", () => {
  it("hubListMessages persists metadata for every listed message, with no body yet", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("hub-cache-list"));
    const account = upsertAccount(user.id, {
      provider: "google",
      email: uniqueEmail("inbox-cache-list"),
      accessToken: "t",
      refreshToken: "r",
      expiryDate: null,
    });
    mockGoogleListMessages.mockResolvedValueOnce([
      { ...fakeMessage(account.id, "cache-1"), subject: "Your order shipped" },
    ]);

    await hubListMessages(user.id, { accountId: account.id });

    const results = searchReadEmails(user.id, "shipped");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ messageId: "cache-1", subject: "Your order shipped", body: null });
  });

  it("hubGetMessage persists the full body onto the cached row", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("hub-cache-get"));
    const account = upsertAccount(user.id, {
      provider: "google",
      email: uniqueEmail("inbox-cache-get"),
      accessToken: "t",
      refreshToken: "r",
      expiryDate: null,
    });
    mockGoogleGetMessage.mockResolvedValueOnce({
      ...fakeMessage(account.id, "cache-2"),
      body: "Full text with the tracking number 98765.",
    });

    await hubGetMessage(user.id, account.id, "cache-2");

    const results = searchReadEmails(user.id, "tracking number");
    expect(results).toHaveLength(1);
    expect(results[0].body).toBe("Full text with the tracking number 98765.");
  });

  it("does not cache anything when hubGetMessage returns null (message not found)", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("hub-cache-get-miss"));
    const account = upsertAccount(user.id, {
      provider: "google",
      email: uniqueEmail("inbox-cache-get-miss"),
      accessToken: "t",
      refreshToken: "r",
      expiryDate: null,
    });
    mockGoogleGetMessage.mockResolvedValueOnce(null);

    await hubGetMessage(user.id, account.id, "missing");

    expect(searchReadEmails(user.id, "missing")).toHaveLength(0);
  });
});

describe("hubListNewMessages", () => {
  it("passes the baseline limit through and returns whatever the provider gives back", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("hub-new-basic"));
    const account = upsertAccount(user.id, {
      provider: "google",
      email: uniqueEmail("inbox-new-basic"),
      accessToken: "t",
      refreshToken: "r",
      expiryDate: null,
    });
    mockGoogleListNewMessages.mockResolvedValueOnce({ messages: [fakeMessage(account.id, "new-1")], historyId: null });

    const results = await hubListNewMessages(user.id);

    expect(results).toHaveLength(1);
    expect(mockGoogleListNewMessages).toHaveBeenCalledWith(
      expect.objectContaining({ id: account.id }),
      { limit: 150 }
    );
  });

  it("excludes read-restricted accounts", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("hub-new-restricted"));
    const restricted = upsertAccount(user.id, {
      provider: "google",
      email: uniqueEmail("inbox-new-restricted"),
      accessToken: "t",
      refreshToken: "r",
      expiryDate: null,
    });
    updateAccountPermissions(user.id, restricted.id, { canRead: false });
    mockGoogleListNewMessages.mockResolvedValue({ messages: [], historyId: null });

    await hubListNewMessages(user.id);

    expect(mockGoogleListNewMessages).not.toHaveBeenCalled();
  });

  // The user's own reply or draft must never reach the scanners as incoming mail — they turned it
  // into "needs a reply" alerts about something the user had just written themselves.
  it("drops mail written from the mailbox's own address", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("hub-new-own"));
    const email = uniqueEmail("inbox-new-own");
    const account = upsertAccount(user.id, { provider: "google", email, accessToken: "t", refreshToken: "r", expiryDate: null });
    mockGoogleListNewMessages.mockResolvedValueOnce({
      messages: [
        { ...fakeMessage(account.id, "own"), accountEmail: email, from: `Me <${email.toUpperCase()}>` },
        { ...fakeMessage(account.id, "theirs"), accountEmail: email },
      ],
      historyId: null,
    });

    const results = await hubListNewMessages(user.id);

    expect(results.map((m) => m.id)).toEqual(["theirs"]);
  });

  it("persists metadata for whatever it returns, same as hubListMessages", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("hub-new-cache"));
    const account = upsertAccount(user.id, {
      provider: "google",
      email: uniqueEmail("inbox-new-cache"),
      accessToken: "t",
      refreshToken: "r",
      expiryDate: null,
    });
    mockGoogleListNewMessages.mockResolvedValueOnce({
      messages: [{ ...fakeMessage(account.id, "new-2"), subject: "Package delayed" }],
      historyId: null,
    });

    await hubListNewMessages(user.id);

    expect(searchReadEmails(user.id, "delayed")).toHaveLength(1);
  });

  // Replaying onboarding (or reconnecting, or adding a second mailbox) gives the account a fresh
  // id, so none of its pre-connect mail is in any scanner's ledger — without this floor, every
  // background scan treated that whole backlog as new and alerted on days-old mail.
  it("never returns mail received before the account was connected", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("hub-new-floor"));
    const account = upsertAccount(user.id, {
      provider: "google",
      email: uniqueEmail("inbox-new-floor"),
      accessToken: "t",
      refreshToken: "r",
      expiryDate: null,
    });
    const beforeConnect = new Date(account.connectedAt! - 60 * 60 * 1000).toISOString();
    mockGoogleListNewMessages.mockResolvedValueOnce({
      messages: [
        { ...fakeMessage(account.id, "old-booking"), receivedAt: beforeConnect },
        { ...fakeMessage(account.id, "after-connect"), receivedAt: new Date(account.connectedAt! + 1000).toISOString() },
      ],
      historyId: null,
    });

    const messages = await hubListNewMessages(user.id);

    expect(messages.map((m) => m.id)).toEqual(["after-connect"]);
  });

  it("keeps the original connection time when the same mailbox re-authenticates", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("hub-new-floor-reauth"));
    const details = {
      provider: "google" as const,
      email: uniqueEmail("inbox-new-floor-reauth"),
      accessToken: "t",
      refreshToken: "r",
      expiryDate: null,
    };
    const first = upsertAccount(user.id, details);
    await new Promise((r) => setTimeout(r, 5));
    const again = upsertAccount(user.id, { ...details, accessToken: "t2" });

    expect(again.id).toBe(first.id);
    expect(again.connectedAt).toBe(first.connectedAt);
  });

  it("within one withMessageCache scope, collapses repeated calls for the same owner into a single fetch — regardless of caller", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("hub-new-collapse"));
    upsertAccount(user.id, {
      provider: "google",
      email: uniqueEmail("inbox-new-collapse"),
      accessToken: "t",
      refreshToken: "r",
      expiryDate: null,
    });
    mockGoogleListNewMessages.mockResolvedValue({ messages: [], historyId: null });

    await withMessageCache(async () => {
      await hubListNewMessages(user.id);
      await hubListNewMessages(user.id);
      await hubListNewMessages(user.id);
    });

    expect(mockGoogleListNewMessages).toHaveBeenCalledTimes(1);
  });

  it("does not carry the cache across separate withMessageCache scopes — each tick fetches fresh", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("hub-new-no-leak"));
    upsertAccount(user.id, {
      provider: "google",
      email: uniqueEmail("inbox-new-no-leak"),
      accessToken: "t",
      refreshToken: "r",
      expiryDate: null,
    });
    mockGoogleListNewMessages.mockResolvedValue({ messages: [], historyId: null });

    await withMessageCache(() => hubListNewMessages(user.id));
    await withMessageCache(() => hubListNewMessages(user.id));

    expect(mockGoogleListNewMessages).toHaveBeenCalledTimes(2);
  });
});

// Regression coverage for losing alerts on Gmail: the history checkpoint used to be saved the moment
// new mail was listed, so anything a scanner deliberately left unhandled (failed classification,
// failed WhatsApp delivery) never came back on the next tick. The checkpoint is now saved only once
// the work is done, and a scanner can hold it so the same mail is listed again.
describe("hubListNewMessages checkpoint", () => {
  function seedGmail(prefix: string) {
    const user = findOrCreateUserByEmail(uniqueEmail(prefix));
    const account = upsertAccount(user.id, {
      provider: "google",
      email: uniqueEmail(`${prefix}-inbox`),
      accessToken: "t",
      refreshToken: "r",
      expiryDate: null,
    });
    return { user, account };
  }

  it("saves the checkpoint right away for a call outside any tick scope", async () => {
    const { user, account } = seedGmail("ckpt-unscoped");
    mockGoogleListNewMessages.mockResolvedValue({ messages: [], historyId: "123" });

    await hubListNewMessages(user.id);

    expect(getAccount(user.id, account.id)?.historyId).toBe("123");
  });

  it("uses Outlook's delta fetch and saves its delta link as the checkpoint", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("ckpt-ms"));
    const account = upsertAccount(user.id, {
      provider: "microsoft",
      email: uniqueEmail("ckpt-ms-inbox"),
      accessToken: "t",
      refreshToken: "r",
      expiryDate: null,
    });
    mockMicrosoftListNewMessages.mockResolvedValue({ messages: [], historyId: "https://graph/delta?token=1" });

    await withMessageCache(() => hubListNewMessages(user.id));

    expect(mockMicrosoftListNewMessages).toHaveBeenCalledWith(expect.objectContaining({ id: account.id }), { limit: 150 });
    expect(getAccount(user.id, account.id)?.historyId).toBe("https://graph/delta?token=1");
  });

  it("inside a tick scope, saves the checkpoint only once the scope finishes", async () => {
    const { user, account } = seedGmail("ckpt-scoped");
    mockGoogleListNewMessages.mockResolvedValue({ messages: [], historyId: "456" });

    let seenDuringScope: string | null | undefined;
    await withMessageCache(async () => {
      await hubListNewMessages(user.id);
      seenDuringScope = getAccount(user.id, account.id)?.historyId;
    });

    expect(seenDuringScope).toBeNull();
    expect(getAccount(user.id, account.id)?.historyId).toBe("456");
  });

  it("keeps the old checkpoint when a scanner holds it during the scope", async () => {
    const { user, account } = seedGmail("ckpt-held");
    mockGoogleListNewMessages.mockResolvedValue({ messages: [], historyId: "789" });

    await withMessageCache(async () => {
      await hubListNewMessages(user.id);
      holdNewMessageCheckpoint(user.id);
    });

    expect(getAccount(user.id, account.id)?.historyId).toBeNull();
  });

  it("does not save the checkpoint if the scope throws", async () => {
    const { user, account } = seedGmail("ckpt-throws");
    mockGoogleListNewMessages.mockResolvedValue({ messages: [], historyId: "321" });

    await expect(
      withMessageCache(async () => {
        await hubListNewMessages(user.id);
        throw new Error("scanner crashed");
      })
    ).rejects.toThrow("scanner crashed");

    expect(getAccount(user.id, account.id)?.historyId).toBeNull();
  });

  it("stops honoring a hold that has lasted over an hour, so a permanent failure can't pin the checkpoint", async () => {
    const { user, account } = seedGmail("ckpt-stale-hold");
    mockGoogleListNewMessages.mockResolvedValue({ messages: [], historyId: "999" });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-15T10:00:00Z"));
      await withMessageCache(async () => {
        await hubListNewMessages(user.id);
        holdNewMessageCheckpoint(user.id);
      });
      expect(getAccount(user.id, account.id)?.historyId).toBeNull();

      vi.setSystemTime(new Date("2026-09-15T11:01:00Z"));
      await withMessageCache(async () => {
        await hubListNewMessages(user.id);
        holdNewMessageCheckpoint(user.id);
      });
      expect(getAccount(user.id, account.id)?.historyId).toBe("999");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("withMessageCache", () => {
  it("collapses two identical aggregate calls (same owner/query/limit) into one provider fetch", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("hub-cache-dedup"));
    const account = upsertAccount(user.id, {
      provider: "google",
      email: uniqueEmail("inbox-dedup"),
      accessToken: "t",
      refreshToken: "r",
      expiryDate: null,
    });
    mockGoogleListMessages.mockResolvedValue([fakeMessage(account.id, "m1")]);

    const [a, b] = await withMessageCache(() =>
      Promise.all([
        hubListMessages(user.id, { limit: 50 }),
        hubListMessages(user.id, { limit: 50 }),
      ])
    );

    expect(a).toEqual(b);
    expect(mockGoogleListMessages).toHaveBeenCalledTimes(1);
  });

  it("does not dedupe calls with different limits — each is fetched independently", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("hub-cache-different-limits"));
    const account = upsertAccount(user.id, {
      provider: "google",
      email: uniqueEmail("inbox-diff-limit"),
      accessToken: "t",
      refreshToken: "r",
      expiryDate: null,
    });
    mockGoogleListMessages.mockResolvedValue([fakeMessage(account.id, "m1")]);

    await withMessageCache(() =>
      Promise.all([
        hubListMessages(user.id, { limit: 50 }),
        hubListMessages(user.id, { limit: 150 }),
      ])
    );

    expect(mockGoogleListMessages).toHaveBeenCalledTimes(2);
  });

  it("never caches outside of withMessageCache — interactive callers always get a fresh fetch", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("hub-cache-no-scope"));
    const account = upsertAccount(user.id, {
      provider: "google",
      email: uniqueEmail("inbox-no-scope"),
      accessToken: "t",
      refreshToken: "r",
      expiryDate: null,
    });
    mockGoogleListMessages.mockResolvedValue([fakeMessage(account.id, "m1")]);

    await hubListMessages(user.id, { limit: 50 });
    await hubListMessages(user.id, { limit: 50 });

    expect(mockGoogleListMessages).toHaveBeenCalledTimes(2);
  });

  it("does not leak the cache across separate withMessageCache scopes", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("hub-cache-scoped"));
    const account = upsertAccount(user.id, {
      provider: "google",
      email: uniqueEmail("inbox-scoped"),
      accessToken: "t",
      refreshToken: "r",
      expiryDate: null,
    });
    mockGoogleListMessages.mockResolvedValue([fakeMessage(account.id, "m1")]);

    await withMessageCache(() => hubListMessages(user.id, { limit: 50 }));
    await withMessageCache(() => hubListMessages(user.id, { limit: 50 }));

    expect(mockGoogleListMessages).toHaveBeenCalledTimes(2);
  });
});

describe("senderDisplayName", () => {
  it("extracts a quoted display name", () => {
    expect(senderDisplayName('"Jane Doe" <jane@example.com>')).toBe("Jane Doe");
  });

  it("extracts an unquoted display name", () => {
    expect(senderDisplayName("Jane Doe <jane@example.com>")).toBe("Jane Doe");
  });

  it("falls back to the local part of a bare email address", () => {
    expect(senderDisplayName("no-reply@delta.com")).toBe("no-reply");
  });

  it("returns a bare display name with no address as-is", () => {
    expect(senderDisplayName("Jane Doe")).toBe("Jane Doe");
  });
});

describe("isAutomatedMail", () => {
  const base = { from: "Jane Doe <jane@example.com>" };

  it("treats a known automated sender address as automated", () => {
    expect(isAutomatedMail({ from: "no-reply@delta.com" })).toBe(true);
  });

  it("treats mail the provider flagged as bulk as automated, whatever the address looks like", () => {
    expect(isAutomatedMail({ from: "Pinterest <recommendations@explore.pinterest.com>", bulk: true })).toBe(true);
  });

  it("treats an ordinary address with no bulk flag as a real person", () => {
    expect(isAutomatedMail(base)).toBe(false);
    expect(isAutomatedMail({ ...base, bulk: false })).toBe(false);
  });
});

describe("hubListEvents", () => {
  // Outlook times come back as "...Z" and Google's as "...+02:00" (or plain dates for all-day), so
  // comparing the strings put 10:00+02:00 (08:00 UTC) after 09:00Z.
  it("sorts events by their actual start instant, not by string", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("events-sort"));
    upsertAccount(user.id, { provider: "google", email: uniqueEmail("events-sort-inbox"), accessToken: "t", refreshToken: "r", expiryDate: null });
    const event = (id: string, start: string) => ({ id, accountId: 1, accountEmail: "a@example.com", provider: "google", title: id, start, end: start });
    mockGoogleListEvents.mockResolvedValueOnce([
      event("utc-nine", "2026-09-15T09:00:00.000Z"),
      event("berlin-ten", "2026-09-15T10:00:00+02:00"),
    ]);

    const events = await hubListEvents(user.id, 7);

    expect(events.map((e) => e.id)).toEqual(["berlin-ten", "utc-nine"]);
  });
});

describe("Teams chats", () => {
  it("a chat failure (e.g. a personal Outlook account with no Teams) doesn't flag the mailbox for reconnecting", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("hub-chats-403"));
    const account = upsertAccount(user.id, {
      provider: "microsoft",
      email: uniqueEmail("inbox-chats-403"),
      accessToken: "t",
      refreshToken: "r",
      expiryDate: null,
    });
    mockMicrosoftListChats.mockRejectedValue(new Error("Graph /me/chats returned 403: Forbidden"));

    await expect(hubListChats(user.id)).resolves.toEqual([]);
    expect(getAccount(user.id, account.id)?.authBroken).toBe(false);
  });
});

describe("expired connections in background scans", () => {
  // Production, Nov 2026: one revoked Gmail token was retried on every 5-minute tick for days,
  // each time logging Google's ~85-line error dump and burying every other log line.
  it("stops calling a mailbox already flagged as expired, and logs the first failure in one line", async () => {
    const { describeProviderError, accountsForBackgroundScan } = await import("./hub.js");
    const user = findOrCreateUserByEmail(uniqueEmail("hub-broken-scan"));
    const account = upsertAccount(user.id, {
      provider: "google",
      email: uniqueEmail("inbox-broken-scan"),
      accessToken: "t",
      refreshToken: "r",
      expiryDate: null,
    });
    const invalidGrant = Object.assign(new Error("invalid_grant"), {
      response: { status: 400, data: { error: "invalid_grant", error_description: "Token has been expired or revoked." } },
      config: { huge: "x".repeat(5000) },
    });
    expect(describeProviderError(invalidGrant)).toBe("invalid_grant (Token has been expired or revoked.) [400]");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockGoogleListNewMessages.mockClear();
    mockGoogleListNewMessages.mockRejectedValue(invalidGrant);
    try {
      await expect(hubListNewMessages(user.id)).resolves.toEqual([]);
      expect(getAccount(user.id, account.id)?.authBroken).toBe(true);
      const logged = errorSpy.mock.calls.filter((c) => String(c[0]).startsWith("hub: provider call failed"));
      expect(logged).toHaveLength(1);
      expect(logged[0]).toHaveLength(1); // one string, never the raw error object
      expect(String(logged[0][0])).not.toContain("xxxx");

      await hubListNewMessages(user.id);
      await hubListNewMessages(user.id);
      expect(mockGoogleListNewMessages).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
      mockGoogleListNewMessages.mockReset();
    }

    // Looked at again after a few hours, in case the flag was a mistake.
    const broken = getAccount(user.id, account.id)!;
    expect(accountsForBackgroundScan([broken], Date.now() + 7 * 60 * 60 * 1000)).toHaveLength(1);
  });

  it("an unexpected error with no HTTP status keeps its stack", async () => {
    const { describeProviderError } = await import("./hub.js");
    expect(describeProviderError(new TypeError("x is not a function"))).toContain("TypeError: x is not a function\n");
  });
});
