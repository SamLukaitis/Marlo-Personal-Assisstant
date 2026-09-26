// Outlook's incremental "what's new" fetch for the 5-minute background scans — Graph delta query,
// the counterpart of google.listNewMessages.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AccountRow } from "../db/store.js";

vi.mock("../db/store.js", () => ({
  updateAccountTokens: vi.fn(),
}));

const { microsoftListNewMessages } = await import("./microsoft.js");

function account(historyId: string | null): AccountRow {
  return {
    id: 1,
    ownerId: 1,
    provider: "microsoft",
    email: "me@outlook.com",
    accessToken: "fake-access-token",
    refreshToken: "fake-refresh-token",
    expiryDate: Date.now() + 60 * 60 * 1000,
    canRead: true,
    historyId,
  } as AccountRow;
}

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}
function fail(status: number, body = "") {
  return { ok: false, status, json: async () => ({}), text: async () => body } as Response;
}
function graphMessage(id: string, receivedDateTime = new Date().toISOString()) {
  return {
    id,
    subject: "Subject",
    from: { emailAddress: { name: "Jane", address: "jane@example.com" } },
    bodyPreview: "preview",
    receivedDateTime,
    isRead: false,
  };
}
function urls(): string[] {
  return vi.mocked(fetch).mock.calls.map((c) => decodeURIComponent(String(c[0])));
}

const DELTA_LINK = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=old";
const NEXT_DELTA = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=new";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("microsoftListNewMessages — no checkpoint yet", () => {
  it("starts a delta round from now, lists the inbox normally, and returns the delta link", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(ok({ value: [], "@odata.deltaLink": NEXT_DELTA }))
      .mockResolvedValueOnce(ok({ value: [graphMessage("a"), graphMessage("b")] }));

    const result = await microsoftListNewMessages(account(null), { limit: 150 });

    expect(result.historyId).toBe(NEXT_DELTA);
    expect(result.messages.map((m) => m.id)).toEqual(["a", "b"]);
    const [delta, list] = urls();
    expect(delta).toContain("/me/mailFolders/inbox/messages/delta?$select=id,receivedDateTime&$filter=receivedDateTime ge ");
    expect(list).toContain("/me/mailFolders/inbox/messages?$orderby=receivedDateTime desc&$top=150");
  });
});

describe("microsoftListNewMessages — incremental", () => {
  it("fetches only the messages the delta reported, across pages, and returns the new delta link", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(ok({ value: [{ id: "a", receivedDateTime: new Date().toISOString() }], "@odata.nextLink": `${DELTA_LINK}&$skiptoken=2` }))
      .mockResolvedValueOnce(ok({ value: [{ id: "b", receivedDateTime: new Date().toISOString() }], "@odata.deltaLink": NEXT_DELTA }))
      .mockResolvedValueOnce(ok(graphMessage("a")))
      .mockResolvedValueOnce(ok(graphMessage("b")));

    const result = await microsoftListNewMessages(account(DELTA_LINK));

    expect(result.historyId).toBe(NEXT_DELTA);
    expect(result.messages.map((m) => m.id).sort()).toEqual(["a", "b"]);
    const called = urls();
    expect(called[0]).toBe(decodeURIComponent(DELTA_LINK));
    expect(called.filter((u) => u.includes("/me/messages/"))).toHaveLength(2);
    expect(called.some((u) => u.includes("$top=150"))).toBe(false);
  });

  it("costs a single call when nothing changed", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(ok({ value: [], "@odata.deltaLink": NEXT_DELTA }));

    const result = await microsoftListNewMessages(account(DELTA_LINK));

    expect(result).toEqual({ messages: [], historyId: NEXT_DELTA });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("skips removals and changes to old mail (e.g. marking last month's email read) without fetching them", async () => {
    const lastMonth = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        ok({
          value: [
            { id: "gone", "@removed": { reason: "deleted" } },
            { id: "old", receivedDateTime: lastMonth },
            { id: "new", receivedDateTime: new Date().toISOString() },
          ],
          "@odata.deltaLink": NEXT_DELTA,
        })
      )
      .mockResolvedValueOnce(ok(graphMessage("new")));

    const result = await microsoftListNewMessages(account(DELTA_LINK));

    expect(result.messages.map((m) => m.id)).toEqual(["new"]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("skips a message deleted or moved before it could be fetched, instead of stalling the checkpoint", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        ok({
          value: [
            { id: "moved", receivedDateTime: new Date().toISOString() },
            { id: "kept", receivedDateTime: new Date().toISOString() },
          ],
          "@odata.deltaLink": NEXT_DELTA,
        })
      )
      .mockImplementation(async (url) =>
        String(url).includes("/moved?") ? fail(404, "ErrorItemNotFound") : ok(graphMessage("kept"))
      );

    const result = await microsoftListNewMessages(account(DELTA_LINK));

    expect(result.messages.map((m) => m.id)).toEqual(["kept"]);
    expect(result.historyId).toBe(NEXT_DELTA);
  });

  it("rethrows any other fetch failure so the old checkpoint is kept for a retry", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(ok({ value: [{ id: "a", receivedDateTime: new Date().toISOString() }], "@odata.deltaLink": NEXT_DELTA }))
      .mockResolvedValueOnce(fail(429, "throttled"));

    await expect(microsoftListNewMessages(account(DELTA_LINK))).rejects.toThrow(/429/);
  });

  it("rebaselines when Graph says the delta link has expired", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(fail(410, '{"error":{"code":"SyncStateNotFound"}}'))
      .mockResolvedValueOnce(ok({ value: [], "@odata.deltaLink": NEXT_DELTA }))
      .mockResolvedValueOnce(ok({ value: [graphMessage("a")] }));

    const result = await microsoftListNewMessages(account(DELTA_LINK), { limit: 150 });

    expect(result.historyId).toBe(NEXT_DELTA);
    expect(result.messages.map((m) => m.id)).toEqual(["a"]);
  });
});
