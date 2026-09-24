// Regression coverage for a real bug: googleListNewMessages saved the new Gmail history checkpoint
// before fetching the messages it had just discovered. If that fetch failed (e.g. the Gmail
// "units per minute" quota error from 2026-09-10), the checkpoint had already moved past those
// messages, so no later scan ever saw them. The provider now only reports the new checkpoint —
// hub.ts decides when it's safe to save it.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AccountRow } from "../db/store.js";

const { mockHistoryList, mockMessagesGet, mockGetProfile, mockMessagesList, mockSetAccountHistoryId } = vi.hoisted(
  () => ({
    mockHistoryList: vi.fn(),
    mockMessagesGet: vi.fn(),
    mockGetProfile: vi.fn(),
    mockMessagesList: vi.fn(),
    mockSetAccountHistoryId: vi.fn(),
  })
);

vi.mock("../db/store.js", () => ({
  updateAccountTokens: vi.fn(),
  setAccountHistoryId: mockSetAccountHistoryId,
}));

vi.mock("googleapis", () => ({
  google: {
    auth: {
      OAuth2: class {
        setCredentials() {}
        on() {}
      },
    },
    gmail: () => ({
      users: {
        getProfile: mockGetProfile,
        history: { list: mockHistoryList },
        messages: { get: mockMessagesGet, list: mockMessagesList },
      },
    }),
  },
}));

const { googleListNewMessages } = await import("./google.js");

function fakeAccount(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: 1,
    ownerId: 1,
    provider: "google",
    email: "test@example.com",
    accessToken: "at",
    refreshToken: "rt",
    expiryDate: Date.now() + 3600_000,
    authBroken: false,
    authBrokenAt: null,
    canRead: true,
    canSend: true,
    canDelete: true,
    historyId: "100",
    ...overrides,
  };
}

function fullMessage(id: string) {
  return { data: { id, internalDate: String(Date.now()), payload: { headers: [] }, labelIds: [] } };
}

beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = "test-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
  mockHistoryList.mockReset();
  mockMessagesGet.mockReset();
  mockGetProfile.mockReset();
  mockMessagesList.mockReset();
  mockSetAccountHistoryId.mockReset();
});

describe("googleListNewMessages", () => {
  it("never saves the checkpoint itself, even when fetching the added messages fails", async () => {
    mockHistoryList.mockResolvedValue({
      data: { history: [{ messagesAdded: [{ message: { id: "m1" } }] }], historyId: "200" },
    });
    mockMessagesGet.mockRejectedValue(new Error("Quota exceeded"));

    await expect(googleListNewMessages(fakeAccount())).rejects.toThrow("Quota exceeded");
    expect(mockSetAccountHistoryId).not.toHaveBeenCalled();
  });

  it("returns the new checkpoint alongside the added messages", async () => {
    mockHistoryList.mockResolvedValue({
      data: { history: [{ messagesAdded: [{ message: { id: "m1" } }] }], historyId: "200" },
    });
    mockMessagesGet.mockResolvedValue(fullMessage("m1"));

    const result = await googleListNewMessages(fakeAccount());

    expect(result.historyId).toBe("200");
    expect(result.messages.map((m) => m.id)).toEqual(["m1"]);
    expect(mockSetAccountHistoryId).not.toHaveBeenCalled();
  });

  // The flip side of the test above: a 404 means that message is gone for good, so it must NOT be
  // treated like the quota error. Rejecting withheld the checkpoint, so the next tick resumed from
  // the same startHistoryId, rediscovered the same dead id and failed identically — stalling the
  // account's scans every 5 minutes until the id aged out of Gmail's ~1 week history retention.
  it("skips a message deleted between history.list and the fetch, keeping the rest of the batch", async () => {
    mockHistoryList.mockResolvedValue({
      data: {
        history: [{ messagesAdded: [{ message: { id: "gone" } }, { message: { id: "m2" } }] }],
        historyId: "200",
      },
    });
    mockMessagesGet.mockImplementation(async ({ id }: { id: string }) => {
      if (id === "gone") throw Object.assign(new Error("Requested entity was not found."), { code: 404 });
      return fullMessage(id);
    });

    const result = await googleListNewMessages(fakeAccount());

    expect(result.messages.map((m) => m.id)).toEqual(["m2"]);
    expect(result.historyId).toBe("200");
  });

  it("still surfaces non-404 fetch failures rather than silently dropping messages", async () => {
    mockHistoryList.mockResolvedValue({
      data: { history: [{ messagesAdded: [{ message: { id: "m1" } }] }], historyId: "200" },
    });
    mockMessagesGet.mockRejectedValue(
      Object.assign(new Error("Quota exceeded"), { response: { status: 429 } })
    );

    await expect(googleListNewMessages(fakeAccount())).rejects.toThrow("Quota exceeded");
  });

  it("returns the mailbox's current checkpoint from a baseline (no checkpoint yet) list", async () => {
    mockGetProfile.mockResolvedValue({ data: { historyId: "555" } });
    mockMessagesList.mockResolvedValue({ data: { messages: [{ id: "m9" }] } });
    mockMessagesGet.mockResolvedValue(fullMessage("m9"));

    const result = await googleListNewMessages(fakeAccount({ historyId: null }));

    expect(result.historyId).toBe("555");
    expect(result.messages.map((m) => m.id)).toEqual(["m9"]);
    expect(mockSetAccountHistoryId).not.toHaveBeenCalled();
  });
});

// Marketing mail from ordinary-looking addresses (Pinterest, Babbel, ...) slipped past
// AUTOMATED_SENDER_PATTERN into the "a real person emailed you" alerts. Gmail already sorts that
// mail into its Promotions/Social/Updates/Forums tabs, and bulk senders set List-Unsubscribe —
// both are surfaced as `bulk` so hub.ts's isAutomatedMail can use them.
describe("googleListNewMessages — bulk-mail signals", () => {
  function messageWith(id: string, labelIds: string[], headers: { name: string; value: string }[] = []) {
    return { data: { id, internalDate: String(Date.now()), payload: { headers }, labelIds } };
  }

  async function listOne(message: ReturnType<typeof messageWith>) {
    mockHistoryList.mockResolvedValue({
      data: { history: [{ messagesAdded: [{ message: { id: message.data.id } }] }], historyId: "200" },
    });
    mockMessagesGet.mockResolvedValue(message);
    const result = await googleListNewMessages(fakeAccount());
    return result.messages[0];
  }

  it.each(["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_UPDATES", "CATEGORY_FORUMS"])(
    "marks a message in Gmail's %s tab as bulk",
    async (label) => {
      expect((await listOne(messageWith("m1", ["INBOX", label]))).bulk).toBe(true);
    }
  );

  it("marks a message carrying a List-Unsubscribe header as bulk, even in the Primary tab", async () => {
    const m = await listOne(
      messageWith("m1", ["INBOX", "CATEGORY_PERSONAL"], [{ name: "List-Unsubscribe", value: "<mailto:u@x.com>" }])
    );
    expect(m.bulk).toBe(true);
  });

  it("leaves a Primary-tab message with no unsubscribe header unmarked", async () => {
    const m = await listOne(messageWith("m1", ["INBOX", "CATEGORY_PERSONAL"], [{ name: "From", value: "Jane <j@x.com>" }]));
    expect(m.bulk).toBe(false);
  });

  it("asks Gmail for the List-Unsubscribe header", async () => {
    await listOne(messageWith("m1", ["INBOX"]));
    expect(mockMessagesGet.mock.calls[0][0].metadataHeaders).toContain("List-Unsubscribe");
  });
});
