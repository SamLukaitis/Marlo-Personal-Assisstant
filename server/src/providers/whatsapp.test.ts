import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  sendWhatsAppReplyButtons,
  sendWhatsAppCtaUrl,
  sendWhatsAppListMessage,
  sendChoiceMessage,
  extractIncomingMessages,
  WhatsAppSendError,
} from "./whatsapp.js";

const originalFetch = global.fetch;
const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.WHATSAPP_PHONE_NUMBER_ID = "123456";
  process.env.WHATSAPP_TOKEN = "test-token";
});

afterEach(() => {
  global.fetch = originalFetch;
  process.env = { ...originalEnv };
});

function mockFetchOk() {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => "{}" });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe("sendWhatsAppReplyButtons", () => {
  it("posts an interactive button message with the given buttons", async () => {
    const fetchMock = mockFetchOk();

    await sendWhatsAppReplyButtons("447000000001", "Want a daily update?", [
      { id: "briefing_yes", title: "Yes please" },
      { id: "briefing_no", title: "No thanks" },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.type).toBe("interactive");
    expect(body.interactive.type).toBe("button");
    expect(body.interactive.body.text).toBe("Want a daily update?");
    expect(body.interactive.action.buttons).toEqual([
      { type: "reply", reply: { id: "briefing_yes", title: "Yes please" } },
      { type: "reply", reply: { id: "briefing_no", title: "No thanks" } },
    ]);
  });

  it("throws a WhatsAppSendError on a non-ok response", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 400, text: async () => '{"error":{"code":100}}' }) as unknown as typeof fetch;

    await expect(sendWhatsAppReplyButtons("447000000001", "hi", [{ id: "a", title: "A" }])).rejects.toThrow(
      WhatsAppSendError
    );
  });
});

describe("sendWhatsAppCtaUrl", () => {
  it("posts an interactive cta_url message with the given link", async () => {
    const fetchMock = mockFetchOk();

    await sendWhatsAppCtaUrl("447000000001", "Tap to connect", "Connect Gmail", "https://example.com/connect");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.interactive.type).toBe("cta_url");
    expect(body.interactive.action.parameters).toEqual({
      display_text: "Connect Gmail",
      url: "https://example.com/connect",
    });
  });
});

describe("extractIncomingMessages — interactive button replies", () => {
  it("parses a button_reply into an IncomingInteractiveMessage", () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: "447000000001",
                    id: "wamid.abc",
                    type: "interactive",
                    interactive: { type: "button_reply", button_reply: { id: "briefing_yes", title: "Yes please" } },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const messages = extractIncomingMessages(payload);

    expect(messages).toEqual([
      { kind: "interactive", from: "447000000001", messageId: "wamid.abc", buttonId: "briefing_yes" },
    ]);
  });

  it("ignores an interactive message that isn't a button_reply", () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: "447000000001",
                    id: "wamid.abc",
                    type: "interactive",
                    interactive: { type: "list_reply" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    expect(extractIncomingMessages(payload)).toEqual([]);
  });
});

describe("sendWhatsAppListMessage", () => {
  it("posts an interactive list message with the given rows", async () => {
    const fetchMock = mockFetchOk();

    await sendWhatsAppListMessage("447000000001", "Pick one", "Choose", [
      { id: "pa:abc:0", title: "Sarah Chen" },
      { id: "pa:abc:1", title: "Sarah Lee" },
    ]);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.interactive.type).toBe("list");
    expect(body.interactive.body.text).toBe("Pick one");
    expect(body.interactive.action.button).toBe("Choose");
    expect(body.interactive.action.sections).toEqual([
      {
        rows: [
          { id: "pa:abc:0", title: "Sarah Chen" },
          { id: "pa:abc:1", title: "Sarah Lee" },
        ],
      },
    ]);
  });
});

describe("sendChoiceMessage", () => {
  it("uses reply buttons for 3 or fewer choices", async () => {
    const fetchMock = mockFetchOk();

    await sendChoiceMessage("447000000001", "Archive 3 emails?", [
      { id: "pa:abc:yes", title: "Yes" },
      { id: "pa:abc:no", title: "No" },
    ]);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.interactive.type).toBe("button");
  });

  it("uses a list message for more than 3 choices", async () => {
    const fetchMock = mockFetchOk();

    await sendChoiceMessage("447000000001", "Which one?", [
      { id: "pa:abc:0", title: "A" },
      { id: "pa:abc:1", title: "B" },
      { id: "pa:abc:2", title: "C" },
      { id: "pa:abc:3", title: "D" },
    ]);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.interactive.type).toBe("list");
  });
});

describe("extractIncomingMessages — interactive list replies", () => {
  it("parses a list_reply into an IncomingInteractiveMessage", () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: "447000000001",
                    id: "wamid.def",
                    type: "interactive",
                    interactive: { type: "list_reply", list_reply: { id: "pa:abc:0", title: "Sarah Chen" } },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const messages = extractIncomingMessages(payload);
    expect(messages).toEqual([{ kind: "interactive", from: "447000000001", messageId: "wamid.def", buttonId: "pa:abc:0" }]);
  });
});
