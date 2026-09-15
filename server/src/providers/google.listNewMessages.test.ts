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
