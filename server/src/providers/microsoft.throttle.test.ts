// Graph throttles per mailbox (MailboxConcurrency: ~4 requests in flight per app), and the assistant
// runs tools in parallel alongside background scans — so a 429 is routine and must be retried.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AccountRow } from "../db/store.js";

vi.mock("../db/store.js", () => ({
  updateAccountTokens: vi.fn(),
}));

const { microsoftArchiveMessages, microsoftSendMessage } = await import("./microsoft.js");

const account = {
  id: 1,
  ownerId: 1,
  provider: "microsoft",
  email: "me@outlook.com",
  accessToken: "fake-access-token",
  refreshToken: "fake-refresh-token",
  expiryDate: Date.now() + 60 * 60 * 1000,
  canRead: true,
  canSend: true,
  canDelete: true,
} as AccountRow;

function ok(body: unknown, status = 200) {
  return { ok: true, status, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) } as Response;
}
function throttled(status = 429, retryAfter = "0") {
  const body = '{"error":{"code":"ApplicationThrottled","message":"Application is over its MailboxConcurrency limit."}}';
  return { ok: false, status, headers: new Headers({ "Retry-After": retryAfter }), json: async () => ({}), text: async () => body } as Response;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Graph throttling", () => {
  it("retries a throttled move instead of failing the whole archive", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(ok({ value: [{ id: "m1", isRead: false }] }))
      .mockResolvedValueOnce(throttled())
      .mockResolvedValueOnce(ok({ id: "m1-moved" }, 201));

    await expect(microsoftArchiveMessages(account, "from:jane", 10)).resolves.toBe(1);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("retries a throttled send (429 means Graph did not accept it)", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(throttled())
      .mockResolvedValueOnce({ ok: true, status: 202, headers: new Headers(), text: async () => "" } as Response);

    await expect(microsoftSendMessage(account, "jane@example.com", "Hi", "Body")).resolves.toMatchObject({ provider: "microsoft" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("gives up after a few attempts and surfaces the 429", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(ok({ value: [{ id: "m1", isRead: false }] }))
      .mockResolvedValue(throttled());

    await expect(microsoftArchiveMessages(account, "from:jane", 10)).rejects.toThrow(/429/);
    expect(vi.mocked(fetch).mock.calls.length).toBeLessThanOrEqual(1 + 5);
  });

  it("does not retry a 503 on a write — the request may have gone through", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(ok({ value: [{ id: "m1", isRead: false }] }))
      .mockResolvedValueOnce(throttled(503));

    await expect(microsoftArchiveMessages(account, "from:jane", 10)).rejects.toThrow(/503/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
