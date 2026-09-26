// Outlook mail had no bulk signal, so marketing mail from an ordinary-looking address (UNiDAYS,
// Pinterest) pinged as "X emailed you". google.ts derives it from List-Unsubscribe; so does this.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AccountRow } from "../db/store.js";

vi.mock("../db/store.js", () => ({
  updateAccountTokens: vi.fn(),
}));

const { microsoftListMessages } = await import("./microsoft.js");

const account = {
  id: 1,
  ownerId: 1,
  provider: "microsoft",
  email: "test@example.com",
  accessToken: "fake-access-token",
  refreshToken: "fake-refresh-token",
  expiryDate: Date.now() + 60 * 60 * 1000,
  canRead: true,
} as AccountRow;

function graphMessage(id: string, headers?: { name: string; value: string }[]) {
  return {
    id,
    subject: "Subject",
    from: { emailAddress: { name: "Someone", address: "someone@example.com" } },
    bodyPreview: "preview",
    receivedDateTime: "2026-09-25T10:00:00Z",
    isRead: false,
    webLink: "https://outlook.example/x",
    internetMessageHeaders: headers,
  };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("microsoftListMessages bulk detection", () => {
  it("flags mail carrying a List-Unsubscribe header as bulk, and leaves personal mail alone", async () => {
    const body = {
      value: [
        graphMessage("marketing", [
          { name: "Received", value: "from x" },
          { name: "List-Unsubscribe", value: "<https://unsubscribe.example/u>" },
        ]),
        graphMessage("personal", [{ name: "Received", value: "from y" }]),
        graphMessage("no-headers"),
      ],
    };
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200, json: async () => body, text: async () => "" } as Response);

    const messages = await microsoftListMessages(account, { limit: 10 });

    expect(messages.map((m) => [m.id, m.bulk])).toEqual([
      ["marketing", true],
      ["personal", false],
      ["no-headers", false],
    ]);
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain("internetMessageHeaders");
  });
});
