// Outlook paths that had drifted behind Gmail's: search syntax, message bodies, calendar offsets,
// archive scope, and sending (including the reconnect case for pre-Mail.Send connections).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AccountRow } from "../db/store.js";

vi.mock("../db/store.js", () => ({
  updateAccountTokens: vi.fn(),
}));

const {
  toGraphMailQuery,
  toGraphDateTime,
  microsoftListMessages,
  microsoftGetMessage,
  microsoftCreateEvent,
  microsoftArchiveMessages,
  microsoftSendMessage,
  OutlookSendPermissionError,
} = await import("./microsoft.js");

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
  return { ok: true, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}
function fail(status: number, body = "") {
  return { ok: false, status, json: async () => ({}), text: async () => body } as Response;
}
function graphMessage(id: string, isRead = false) {
  return {
    id,
    subject: "Subject",
    from: { emailAddress: { name: "Jane", address: "jane@example.com" } },
    bodyPreview: "preview",
    receivedDateTime: "2026-09-25T10:00:00Z",
    isRead,
  };
}
function calledUrl(i = 0): string {
  return decodeURIComponent(String(vi.mocked(fetch).mock.calls[i][0]));
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("toGraphMailQuery", () => {
  const now = Date.parse("2026-09-26T12:00:00Z");

  it("passes plain words and from:/subject: through untouched", () => {
    expect(toGraphMailQuery('from:jane subject:"Q3 report" invoice', now)).toEqual({
      kql: 'from:jane subject:"Q3 report" invoice',
      folder: null,
    });
  });

  it("maps Gmail's date, attachment, read-state and folder operators", () => {
    const q = toGraphMailQuery("from:nike newer_than:7d has:attachment is:unread in:inbox", now);
    expect(q).toEqual({
      kql: "from:nike",
      folder: "inbox",
      receivedAfter: "2026-09-19",
      hasAttachment: true,
      unread: true,
    });
  });

  it("reads absolute after:/before: dates in either separator", () => {
    const q = toGraphMailQuery("after:2026/9/1 before:2026-09-10", now);
    expect(q.receivedAfter).toBe("2026-09-01");
    expect(q.receivedBefore).toBe("2026-09-10");
    expect(q.kql).toBe("");
  });

  it("drops Gmail-only operators with no Outlook equivalent instead of searching for them", () => {
    expect(toGraphMailQuery("label:work category:promotions is:starred receipt", now).kql).toBe("receipt");
  });

  it("maps in:sent to Sent Items and filename: to KQL attachment:", () => {
    const q = toGraphMailQuery("in:sent filename:invoice.pdf", now);
    expect(q.folder).toBe("sentitems");
    expect(q.kql).toBe("attachment:invoice.pdf");
  });
});

describe("microsoftListMessages with a query", () => {
  it("sends translated KQL, with dates and attachments folded into the search", async () => {
    vi.mocked(fetch).mockResolvedValue(ok({ value: [] }));
    await microsoftListMessages(account, { query: "from:nike has:attachment after:2026/09/01" });
    const url = calledUrl();
    expect(url).toContain('/me/messages?$search="from:nike hasAttachments:true received>=2026-09-01"');
    expect(url).not.toContain("has:attachment");
  });

  it("escapes a quoted phrase so it can't close the $search string early", async () => {
    vi.mocked(fetch).mockResolvedValue(ok({ value: [] }));
    await microsoftListMessages(account, { query: 'subject:"Q3 report"' });
    expect(calledUrl()).toContain('$search="subject:\\"Q3 report\\""');
  });

  it("filters is:unread client-side when there's free text, since KQL can't express it", async () => {
    vi.mocked(fetch).mockResolvedValue(ok({ value: [graphMessage("a", false), graphMessage("b", true)] }));
    const messages = await microsoftListMessages(account, { query: "invoice is:unread" });
    expect(messages.map((m) => m.id)).toEqual(["a"]);
  });

  it("uses an ordered $filter on the folder when only operators were given", async () => {
    vi.mocked(fetch).mockResolvedValue(ok({ value: [] }));
    await microsoftListMessages(account, { query: "in:inbox is:unread newer_than:1d" });
    const url = calledUrl();
    expect(url).toContain("/me/mailFolders/inbox/messages?$filter=receivedDateTime ge ");
    expect(url).toContain("isRead eq false");
    expect(url).toContain("$orderby=receivedDateTime desc");
    expect(url).not.toContain("$search");
  });
});

describe("microsoftGetMessage body", () => {
  it("asks Graph for a text body", async () => {
    vi.mocked(fetch).mockResolvedValue(ok({ ...graphMessage("m"), body: { contentType: "text", content: "Hello there" } }));
    const message = await microsoftGetMessage(account, "m");
    expect(message?.body).toBe("Hello there");
    const init = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Prefer).toBe('outlook.body-content-type="text"');
  });

  it("converts HTML properly when Graph returns it anyway — no CSS or entities leak through", async () => {
    const html = "<html><head><style>.x{color:red}</style></head><body><p>Hi&nbsp;Sam</p><p>See you Friday</p></body></html>";
    vi.mocked(fetch).mockResolvedValue(ok({ ...graphMessage("m"), body: { contentType: "html", content: html } }));
    const message = await microsoftGetMessage(account, "m");
    expect(message?.body).toBe("Hi Sam\nSee you Friday");
  });
});

describe("toGraphDateTime / microsoftCreateEvent", () => {
  it("resolves an offset to UTC wall-clock time when no zone is given", () => {
    expect(toGraphDateTime("2026-09-19T09:00:00+01:00", undefined)).toEqual({
      dateTime: "2026-09-19T08:00:00",
      timeZone: "UTC",
    });
    expect(toGraphDateTime("2026-09-19T09:00:00Z", undefined)).toEqual({
      dateTime: "2026-09-19T09:00:00",
      timeZone: "UTC",
    });
  });

  it("leaves local clock time with an explicit zone untouched", () => {
    expect(toGraphDateTime("2026-09-19T17:29:00", "America/Bogota")).toEqual({
      dateTime: "2026-09-19T17:29:00",
      timeZone: "America/Bogota",
    });
  });

  it("creates the event at the right instant for an offset start", async () => {
    vi.mocked(fetch).mockResolvedValue(ok({ id: "evt" }));
    await microsoftCreateEvent(account, {
      title: "Dentist",
      start: "2026-09-19T09:00:00+02:00",
      end: "2026-09-19T09:30:00+02:00",
    });
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.start).toEqual({ dateTime: "2026-09-19T07:00:00", timeZone: "UTC" });
    expect(body.end).toEqual({ dateTime: "2026-09-19T07:30:00", timeZone: "UTC" });
  });
});

describe("microsoftArchiveMessages", () => {
  it("only searches the inbox, so Sent Items and already-archived mail are never moved", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(ok({ value: [{ id: "a" }, { id: "b" }] }))
      .mockResolvedValue(ok({ id: "moved" }, 201));
    const count = await microsoftArchiveMessages(account, "from:nike");
    expect(count).toBe(2);
    expect(calledUrl(0)).toContain('/me/mailFolders/inbox/messages?$search="from:nike"');
    expect(calledUrl(1)).toContain("/me/messages/a/move");
  });
});

describe("microsoftSendMessage", () => {
  it("sends through /me/sendMail with the attachment inline", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 202, json: async () => ({}), text: async () => "" } as Response);
    const result = await microsoftSendMessage(account, "xero@example.com", "Receipt", "See attached.", {
      filename: "receipt.pdf",
      mimeType: "application/pdf",
      data: Buffer.from("%PDF fake"),
    });
    expect(result).toEqual({ messageId: "", provider: "microsoft", accountEmail: "me@outlook.com" });
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toMatch(/\/me\/sendMail$/);
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.message.toRecipients).toEqual([{ emailAddress: { address: "xero@example.com" } }]);
    expect(body.message.attachments[0]).toMatchObject({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: "receipt.pdf",
      contentBytes: Buffer.from("%PDF fake").toString("base64"),
    });
    expect(body.saveToSentItems).toBe(true);
  });

  it("raises OutlookSendPermissionError on a 403 when the token has no Mail.Send", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(fail(403, '{"error":{"code":"ErrorAccessDenied"}}'))
      .mockResolvedValueOnce(ok({ access_token: "t", expires_in: 3600, scope: "Mail.Read Mail.ReadWrite User.Read" }));
    await expect(microsoftSendMessage(account, "a@b.com", "s", "b")).rejects.toBeInstanceOf(OutlookSendPermissionError);
  });

  it("reports a 403 as an ordinary failure when Mail.Send was granted", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(fail(403, "blocked by policy"))
      .mockResolvedValueOnce(
        ok({ access_token: "t", expires_in: 3600, scope: "https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.Read" })
      );
    const err = await microsoftSendMessage(account, "a@b.com", "s", "b").catch((e) => e);
    expect(err).not.toBeInstanceOf(OutlookSendPermissionError);
    expect(String(err.message)).toContain("blocked by policy");
  });

  it("refuses an attachment too large for an inline send", async () => {
    await expect(
      microsoftSendMessage(account, "a@b.com", "s", "b", {
        filename: "big.pdf",
        mimeType: "application/pdf",
        data: Buffer.alloc(3 * 1024 * 1024 + 1),
      })
    ).rejects.toThrow(/over 3 MB/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
