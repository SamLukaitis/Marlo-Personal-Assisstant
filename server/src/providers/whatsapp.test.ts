import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  sendWhatsAppReplyButtons,
  sendWhatsAppCtaUrl,
  sendWhatsAppListMessage,
  sendChoiceMessage,
  sendWhatsAppMediaFromBuffer,
  sendWhatsAppReaction,
  sendWhatsAppMessage,
  sendWhatsAppTypingIndicator,
  extractIncomingMessages,
  sendWhatsAppTemplate,
  simulatedPhoneForOwner,
  newSimulatedTestUserPhone,
  isSimulatedPhone,
  isSimulatedTestUserPhone,
  WhatsAppSendError,
} from "./whatsapp.js";
import { getSimTranscript } from "./whatsappSimTranscript.js";

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

  it("returns the sent message's wamid so a later swipe-reply to it can be resolved", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, text: async () => '{"messages":[{"id":"wamid.ABC"}]}' }) as unknown as typeof fetch;

    await expect(sendWhatsAppReplyButtons("447000000001", "hi", [{ id: "a", title: "A" }])).resolves.toBe("wamid.ABC");
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

describe("WhatsApp Simulator guard", () => {
  it("simulatedPhoneForOwner/isSimulatedPhone round-trip and never collide with a real number", () => {
    expect(isSimulatedPhone(simulatedPhoneForOwner(1))).toBe(true);
    expect(isSimulatedPhone(simulatedPhoneForOwner(42))).toBe(true);
    expect(isSimulatedPhone("447000000001")).toBe(false);
  });

  it("sendWhatsAppMessage never calls Meta's API for a simulated number", async () => {
    const fetchMock = mockFetchOk();

    const wamid = await sendWhatsAppMessage(simulatedPhoneForOwner(7), "hi");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(wamid).toBeDefined();
  });

  it("sendWhatsAppReplyButtons/sendWhatsAppListMessage/sendWhatsAppReaction all skip Meta for a simulated number", async () => {
    const fetchMock = mockFetchOk();
    const to = simulatedPhoneForOwner(7);

    await sendWhatsAppReplyButtons(to, "q", [{ id: "a", title: "A" }]);
    await sendWhatsAppListMessage(to, "q", "Choose", [{ id: "a", title: "A" }]);
    await sendWhatsAppReaction(to, "sim-msg-1", "👍");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sendWhatsAppTypingIndicator skips Meta for a sim-prefixed message id", async () => {
    const fetchMock = mockFetchOk();

    await sendWhatsAppTypingIndicator("sim-abc123");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a real number/message id still goes through to Meta as before", async () => {
    const fetchMock = mockFetchOk();

    await sendWhatsAppMessage("447000000001", "hi");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("new test-user numbers are simulated and distinct from any owner's own sim number", () => {
    const a = newSimulatedTestUserPhone();
    const b = newSimulatedTestUserPhone();
    expect(isSimulatedPhone(a)).toBe(true);
    expect(isSimulatedTestUserPhone(a)).toBe(true);
    expect(isSimulatedTestUserPhone(simulatedPhoneForOwner(100123))).toBe(false);
    expect(a).not.toBe(b);
  });

  it("sendWhatsAppCtaUrl/sendWhatsAppMediaFromBuffer/sendWhatsAppTemplate also skip Meta for a simulated number", async () => {
    const fetchMock = mockFetchOk();
    const to = newSimulatedTestUserPhone();

    await sendWhatsAppCtaUrl(to, "Tap to connect", "Connect Gmail", "https://example.com/connect");
    await sendWhatsAppMediaFromBuffer(to, Buffer.from("x"), "application/pdf", "invoice.pdf");
    await sendWhatsAppTemplate(to, "marlowe_digest", "Your day");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("records every intercepted send in the simulator transcript, with buttons and links as data", async () => {
    mockFetchOk();
    const to = newSimulatedTestUserPhone();

    await sendWhatsAppMessage(to, "hello");
    await sendWhatsAppReplyButtons(to, "Gmail or Outlook?", [
      { id: "gmail", title: "Gmail" },
      { id: "outlook", title: "Outlook" },
    ]);
    await sendWhatsAppListMessage(to, "Pick one", "Choose", [{ id: "r1", title: "Row 1", description: "d" }]);
    await sendWhatsAppCtaUrl(to, "Tap to connect", "Connect Gmail", "https://example.com/connect");
    await sendWhatsAppMediaFromBuffer(to, Buffer.from("x"), "application/pdf", "invoice.pdf");
    await sendWhatsAppTemplate(to, "marlowe_alert", "Flight moved");
    await sendWhatsAppReaction(to, "sim-1", "👍");

    const t = getSimTranscript(to);
    expect(t.every((e) => e.role === "assistant")).toBe(true);
    expect(t.map((e) => e.text)).toEqual([
      "hello",
      "Gmail or Outlook?",
      "Pick one",
      "Tap to connect",
      "[document: invoice.pdf]",
      "[template marlowe_alert] Flight moved",
      "[reacted 👍]",
    ]);
    expect(t[1].choices).toEqual([
      { id: "gmail", title: "Gmail" },
      { id: "outlook", title: "Outlook" },
    ]);
    expect(t[2].choices).toEqual([{ id: "r1", title: "Row 1" }]);
    expect(t[3].link).toEqual({ label: "Connect Gmail", url: "https://example.com/connect" });
  });

  it("never records a real number's sends", async () => {
    mockFetchOk();

    await sendWhatsAppMessage("447000000001", "hi");

    expect(getSimTranscript("447000000001")).toEqual([]);
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

describe("extractIncomingMessages — unsupported message types", () => {
  it("parses a sticker message into an IncomingUnsupportedMessage carrying its raw type", () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [{ from: "447000000001", id: "wamid.sticker1", type: "sticker" }],
              },
            },
          ],
        },
      ],
    };

    expect(extractIncomingMessages(payload)).toEqual([
      { kind: "unsupported", from: "447000000001", messageId: "wamid.sticker1", type: "sticker" },
    ]);
  });

  it("drops a message missing both from and id rather than producing an unusable entry", () => {
    const payload = {
      entry: [{ changes: [{ value: { messages: [{ type: "sticker" }] } }] }],
    };

    expect(extractIncomingMessages(payload)).toEqual([]);
  });
});

describe("extractIncomingMessages — location", () => {
  it("parses a dropped pin with a name and address into an IncomingLocationMessage", () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: "447000000001",
                    id: "wamid.loc",
                    type: "location",
                    location: {
                      latitude: 51.5074,
                      longitude: -0.1278,
                      name: "Big Ben",
                      address: "London SW1A 0AA",
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    expect(extractIncomingMessages(payload)).toEqual([
      {
        kind: "location",
        from: "447000000001",
        messageId: "wamid.loc",
        latitude: 51.5074,
        longitude: -0.1278,
        name: "Big Ben",
        address: "London SW1A 0AA",
      },
    ]);
  });

  it("parses a raw pin with no name/address", () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: "447000000001",
                    id: "wamid.loc2",
                    type: "location",
                    location: { latitude: 51.5, longitude: -0.1 },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    expect(extractIncomingMessages(payload)).toEqual([
      { kind: "location", from: "447000000001", messageId: "wamid.loc2", latitude: 51.5, longitude: -0.1 },
    ]);
  });

  it("drops a location message missing coordinates rather than falling back to unsupported", () => {
    const payload = {
      entry: [
        {
          changes: [
            { value: { messages: [{ from: "447000000001", id: "wamid.loc3", type: "location", location: {} }] } },
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

  // Meta rejects an interactive body over 1,024 chars — exactly what an email draft shown in an
  // ask_user_choice question produces. The user used to get "Sorry, I hit an error" instead.
  it("sends an over-long question as a plain message first, then the buttons under a short prompt", async () => {
    const fetchMock = mockFetchOk();
    const draft = `To: jane@x.com\nSubject: Re: Thursday\n\n${"Lots of words here. ".repeat(80)}\n\nReady to send this?`;

    await sendChoiceMessage("447000000001", draft, [
      { id: "pa:abc:edit", title: "Edit" },
      { id: "pa:abc:yes", title: "Send" },
      { id: "pa:abc:no", title: "Leave in Drafts" },
    ]);

    const bodies = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body));
    const texts = bodies.filter((b) => b.type === "text").map((b) => b.text.body);
    const interactive = bodies.filter((b) => b.type === "interactive");
    expect(texts.join("\n")).toContain("Lots of words here.");
    expect(texts.every((t) => t.length <= 4096)).toBe(true);
    expect(interactive).toHaveLength(1);
    expect(interactive[0].interactive.body.text).toBe("Ready to send this?");
    expect(bodies[bodies.length - 1].type).toBe("interactive");
  });

  it("falls back to a generic prompt when even the last paragraph is too long for the body", async () => {
    const fetchMock = mockFetchOk();

    await sendChoiceMessage("447000000001", "x".repeat(3000), [
      { id: "pa:abc:yes", title: "Yes" },
      { id: "pa:abc:no", title: "No" },
    ]);

    const bodies = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body));
    const interactive = bodies.find((b) => b.type === "interactive");
    expect(interactive.interactive.body.text.length).toBeLessThanOrEqual(1024);
  });

  it("keeps button titles within WhatsApp's 20-character limit", async () => {
    const fetchMock = mockFetchOk();

    await sendChoiceMessage("447000000001", "Send it?", [
      { id: "pa:abc:yes", title: "Send it to everyone right now" },
      { id: "pa:abc:no", title: "No" },
    ]);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const titles: string[] =
      body.interactive.type === "button"
        ? body.interactive.action.buttons.map((b: { reply: { title: string } }) => b.reply.title)
        : body.interactive.action.sections[0].rows.map((r: { title: string }) => r.title);
    const limit = body.interactive.type === "button" ? 20 : 24;
    expect(titles.every((t) => t.length <= limit)).toBe(true);
  });

  it("keeps list row titles within 24 characters, with the full label in the row description", async () => {
    const fetchMock = mockFetchOk();
    const longName = "Jane Longsurname-Doublebarrel (work)";

    await sendChoiceMessage("447000000001", "Which Jane?", [
      { id: "pa:abc:0", title: longName },
      { id: "pa:abc:1", title: "B" },
      { id: "pa:abc:2", title: "C" },
      { id: "pa:abc:3", title: "D" },
    ]);

    const rows = JSON.parse(fetchMock.mock.calls[0][1].body).interactive.action.sections[0].rows;
    expect(rows.every((r: { title: string }) => r.title.length <= 24)).toBe(true);
    expect(rows[0].description).toBe(longName);
  });

  it("never sends more than 10 list rows", async () => {
    const fetchMock = mockFetchOk();
    const choices = Array.from({ length: 12 }, (_, i) => ({ id: `pa:abc:${i}`, title: `Option ${i}` }));

    await sendChoiceMessage("447000000001", "Which one?", choices);

    const rows = JSON.parse(fetchMock.mock.calls[0][1].body).interactive.action.sections[0].rows;
    expect(rows).toHaveLength(10);
  });
});

describe("sendWhatsAppMediaFromBuffer", () => {
  it("uploads the buffer then sends an image message for jpeg/png", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "media-1" }) })
      .mockResolvedValueOnce({ ok: true, text: async () => "{}" });
    global.fetch = fetchMock as unknown as typeof fetch;

    await sendWhatsAppMediaFromBuffer("447000000001", Buffer.from("fake-bytes"), "image/jpeg", "license.jpg");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain("/media");
    const sendBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(sendBody.type).toBe("image");
    expect(sendBody.image).toEqual({ id: "media-1" });
  });

  it("sends a document message (with filename) for a non-image mime type", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "media-2" }) })
      .mockResolvedValueOnce({ ok: true, text: async () => "{}" });
    global.fetch = fetchMock as unknown as typeof fetch;

    await sendWhatsAppMediaFromBuffer("447000000001", Buffer.from("fake-bytes"), "application/pdf", "ticket.pdf");

    const sendBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(sendBody.type).toBe("document");
    expect(sendBody.document).toEqual({ id: "media-2", filename: "ticket.pdf" });
  });

  it("throws a WhatsAppSendError if the upload itself fails", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 400, text: async () => '{"error":{"code":100}}' }) as unknown as typeof fetch;

    await expect(
      sendWhatsAppMediaFromBuffer("447000000001", Buffer.from("x"), "image/jpeg", "a.jpg")
    ).rejects.toThrow(WhatsAppSendError);
  });
});

describe("sendWhatsAppTemplate wamid", () => {
  it("returns the sent template's wamid so a swipe-reply to it can be resolved", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ messages: [{ id: "wamid.TPL" }] }),
    }) as unknown as typeof fetch;

    await expect(sendWhatsAppTemplate("447000000001", "marlowe_alert", "hi")).resolves.toBe("wamid.TPL");
  });
});

describe("sendWhatsAppReaction", () => {
  it("posts a reaction message targeting the given message id", async () => {
    const fetchMock = mockFetchOk();

    await sendWhatsAppReaction("447000000001", "wamid.original", "👍");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.type).toBe("reaction");
    expect(body.reaction).toEqual({ message_id: "wamid.original", emoji: "👍" });
  });

  it("throws a WhatsAppSendError on a non-ok response", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 400, text: async () => '{"error":{"code":100}}' }) as unknown as typeof fetch;

    await expect(sendWhatsAppReaction("447000000001", "wamid.original", "👍")).rejects.toThrow(
      WhatsAppSendError
    );
  });
});

describe("extractIncomingMessages — reactions", () => {
  it("parses a reaction into an IncomingReactionMessage", () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: "447000000001",
                    id: "wamid.reaction1",
                    type: "reaction",
                    reaction: { message_id: "wamid.original", emoji: "👍" },
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
      {
        kind: "reaction",
        from: "447000000001",
        messageId: "wamid.reaction1",
        reactedToMessageId: "wamid.original",
        emoji: "👍",
      },
    ]);
  });

  it("parses a reaction removal (empty emoji) rather than dropping it", () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: "447000000001",
                    id: "wamid.reaction2",
                    type: "reaction",
                    reaction: { message_id: "wamid.original", emoji: "" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    expect(extractIncomingMessages(payload)).toEqual([
      {
        kind: "reaction",
        from: "447000000001",
        messageId: "wamid.reaction2",
        reactedToMessageId: "wamid.original",
        emoji: "",
      },
    ]);
  });

  it("no longer falls into the generic unsupported bucket", () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: "447000000001",
                    id: "wamid.reaction3",
                    type: "reaction",
                    reaction: { message_id: "wamid.original", emoji: "🎉" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const messages = extractIncomingMessages(payload);
    expect(messages.every((m) => m.kind !== "unsupported")).toBe(true);
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

describe("extractIncomingMessages — reply/quote and forwarded context", () => {
  it("carries the quoted wamid from a text message's context.id (a swipe-to-reply)", () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: "447000000001",
                    id: "wamid.reply1",
                    type: "text",
                    text: { body: "what's this" },
                    context: { id: "wamid.original" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    expect(extractIncomingMessages(payload)).toEqual([
      {
        kind: "text",
        from: "447000000001",
        text: "what's this",
        messageId: "wamid.reply1",
        quotedMessageId: "wamid.original",
      },
    ]);
  });

  it("has no quotedMessageId on an ordinary text message with no context", () => {
    const payload = {
      entry: [
        {
          changes: [{ value: { messages: [{ from: "447000000001", id: "wamid.plain", type: "text", text: { body: "hi" } }] } }],
        },
      ],
    };

    const [message] = extractIncomingMessages(payload);
    expect(message).not.toHaveProperty("quotedMessageId");
  });

  it("marks a forwarded text message via context.forwarded", () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: "447000000001",
                    id: "wamid.fwd1",
                    type: "text",
                    text: { body: "look at this" },
                    context: { forwarded: true },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    expect(extractIncomingMessages(payload)).toEqual([
      {
        kind: "text",
        from: "447000000001",
        text: "look at this",
        messageId: "wamid.fwd1",
        forwarded: true,
      },
    ]);
  });

  it("carries the quoted wamid onto a swipe-reply to a photo/document too", () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: "447000000001",
                    id: "wamid.reply2",
                    type: "image",
                    image: { id: "media-1", mime_type: "image/jpeg" },
                    context: { id: "wamid.originalphoto" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const [message] = extractIncomingMessages(payload);
    expect(message).toMatchObject({ kind: "media", quotedMessageId: "wamid.originalphoto" });
  });
});

describe("sendWhatsAppMessage", () => {
  it("returns the sent message's wamid from the API response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ messages: [{ id: "wamid.sent123" }] }),
    }) as unknown as typeof fetch;

    const wamid = await sendWhatsAppMessage("447000000001", "hello");

    expect(wamid).toBe("wamid.sent123");
  });

  it("returns undefined rather than throwing when the response body is unparseable", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => "not json" }) as unknown as typeof fetch;

    const wamid = await sendWhatsAppMessage("447000000001", "hello");

    expect(wamid).toBeUndefined();
  });
});
