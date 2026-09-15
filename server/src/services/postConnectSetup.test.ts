import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../providers/whatsapp.js", () => ({
  sendWhatsAppMessage: vi.fn(),
  sendWhatsAppReplyButtons: vi.fn(),
}));
vi.mock("./hub.js", () => ({
  hubListMessages: vi.fn().mockResolvedValue([]),
  hubListEvents: vi.fn().mockResolvedValue([]),
}));
vi.mock("./chatDispatch.js", () => ({
  handleText: vi.fn().mockResolvedValue(undefined),
}));

const { sendWhatsAppMessage, sendWhatsAppReplyButtons } = await import("../providers/whatsapp.js");
const { hubListMessages, hubListEvents } = await import("./hub.js");
const { handleText } = await import("./chatDispatch.js");
const {
  startPostConnectSetup,
  handleNameReply,
  handleFirstTaskReply,
  handlePostConnectSetupReply,
} = await import("./postConnectSetup.js");
const { findOrCreateUserByEmail, getPendingSetup, getEnabledTools, getSetting, upsertAccount } =
  await import("../db/store.js");
const { getBriefingSettings } = await import("./briefing.js");
const { todayKey } = await import("./dateKey.js");

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}
function newOwnerId(): number {
  return findOrCreateUserByEmail(uniqueEmail("post-connect-setup")).id;
}

const PHONE = "447000002001";
function tap(buttonId: string) {
  return { kind: "interactive" as const, from: PHONE, buttonId, messageId: `msg-${Math.random()}` };
}
function text(body: string) {
  return { kind: "text" as const, from: PHONE, text: body, messageId: `msg-${Math.random()}` };
}

beforeEach(() => {
  vi.mocked(sendWhatsAppMessage).mockClear();
  vi.mocked(sendWhatsAppReplyButtons).mockClear();
  vi.mocked(hubListMessages).mockClear().mockResolvedValue([]);
  vi.mocked(hubListEvents).mockClear().mockResolvedValue([]);
  vi.mocked(handleText).mockClear().mockResolvedValue(undefined);
});

describe("startPostConnectSetup", () => {
  it("sends the connected confirmation and the name question, and sets ask_name pending", async () => {
    const ownerId = newOwnerId();

    await startPostConnectSetup(ownerId, PHONE);

    expect(sendWhatsAppMessage).toHaveBeenCalledWith(PHONE, expect.stringContaining("Connected"));
    expect(sendWhatsAppMessage).toHaveBeenCalledWith(PHONE, expect.stringContaining("what should I call you"));
    expect(sendWhatsAppReplyButtons).not.toHaveBeenCalled();
    expect(getPendingSetup(ownerId)).toBe("ask_name");
  });

  it("volunteers a concrete insight — the next event's title and a single unread email's subject — rather than just counts", async () => {
    const ownerId = newOwnerId();
    vi.mocked(hubListMessages).mockResolvedValue([
      { unread: true, subject: "Invoice from Acme due Friday" } as never,
      { unread: false } as never,
    ]);
    vi.mocked(hubListEvents).mockResolvedValue([
      { title: "Team standup", start: "2026-09-15T09:00:00.000Z" } as never,
    ]);

    await startPostConnectSetup(ownerId, PHONE);

    const [, confirmText] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(confirmText).toContain("Invoice from Acme due Friday");
    expect(confirmText).toContain("Team standup");
  });

  it("falls back to a plain count when there's more than one unread email or no calendar events", async () => {
    const ownerId = newOwnerId();
    vi.mocked(hubListMessages).mockResolvedValue([
      { unread: true, subject: "A" } as never,
      { unread: true, subject: "B" } as never,
    ]);
    vi.mocked(hubListEvents).mockResolvedValue([]);

    await startPostConnectSetup(ownerId, PHONE);

    const [, confirmText] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(confirmText).toContain("2 unread emails");
  });
});

describe("handleNameReply", () => {
  it("returns false for a non-text message or when nothing is pending", async () => {
    const ownerId = newOwnerId();
    expect(await handleNameReply(ownerId, tap("anything"))).toBe(false);
    expect(await handleNameReply(ownerId, text("Sam"))).toBe(false); // nothing pending yet
  });

  it("on a real name: saves it and asks the first-task question next", async () => {
    const ownerId = newOwnerId();
    await startPostConnectSetup(ownerId, PHONE);
    vi.mocked(sendWhatsAppMessage).mockClear();

    const handled = await handleNameReply(ownerId, text("Sam"));

    expect(handled).toBe(true);
    expect(getSetting(ownerId, "user_name")).toBe("Sam");
    expect(sendWhatsAppMessage).toHaveBeenCalledWith(PHONE, expect.stringContaining("skip"));
    expect(getPendingSetup(ownerId)).toBe("ask_first_task");
  });

  it("trims whitespace around the name", async () => {
    const ownerId = newOwnerId();
    await startPostConnectSetup(ownerId, PHONE);

    await handleNameReply(ownerId, text("  Sam  "));

    expect(getSetting(ownerId, "user_name")).toBe("Sam");
  });

  it("on skip: saves no name, and asks the first-task question next", async () => {
    const ownerId = newOwnerId();
    await startPostConnectSetup(ownerId, PHONE);

    const handled = await handleNameReply(ownerId, text("skip"));

    expect(handled).toBe(true);
    expect(getSetting(ownerId, "user_name")).toBeNull();
    expect(getPendingSetup(ownerId)).toBe("ask_first_task");
  });

  it("on a blank/whitespace-only reply: saves no name, still advances", async () => {
    const ownerId = newOwnerId();
    await startPostConnectSetup(ownerId, PHONE);

    const handled = await handleNameReply(ownerId, text("   "));

    expect(handled).toBe(true);
    expect(getSetting(ownerId, "user_name")).toBeNull();
    expect(getPendingSetup(ownerId)).toBe("ask_first_task");
  });
});

describe("handleFirstTaskReply", () => {
  async function pastName(ownerId: number) {
    await startPostConnectSetup(ownerId, PHONE);
    await handleNameReply(ownerId, text("Sam"));
    vi.mocked(sendWhatsAppMessage).mockClear();
  }

  it("returns false for a non-text message or when nothing is pending", async () => {
    const ownerId = newOwnerId();
    expect(await handleFirstTaskReply(ownerId, tap("anything"))).toBe(false);
    expect(await handleFirstTaskReply(ownerId, text("skip"))).toBe(false); // nothing pending yet
  });

  it("on skip: acknowledges without calling the assistant, and asks the briefing question next", async () => {
    const ownerId = newOwnerId();
    await pastName(ownerId);

    const handled = await handleFirstTaskReply(ownerId, text("skip"));

    expect(handled).toBe(true);
    expect(handleText).not.toHaveBeenCalled();
    expect(sendWhatsAppReplyButtons).toHaveBeenCalledTimes(1);
    const [, , buttons] = vi.mocked(sendWhatsAppReplyButtons).mock.calls[0];
    expect(buttons.map((b) => b.id)).toEqual(["briefing_yes", "briefing_no"]);
    expect(getPendingSetup(ownerId)).toBe("ask_briefing");
  });

  it("on a real request: forwards it to ordinary chat handling, then asks the briefing question right after", async () => {
    const ownerId = newOwnerId();
    await pastName(ownerId);

    const handled = await handleFirstTaskReply(ownerId, text("reply to John's email for me"));

    expect(handled).toBe(true);
    expect(handleText).toHaveBeenCalledWith(ownerId, PHONE, "reply to John's email for me", expect.any(String));
    expect(getPendingSetup(ownerId)).toBe("ask_briefing");
  });
});

describe("handlePostConnectSetupReply", () => {
  async function pastFirstTask(ownerId: number) {
    await startPostConnectSetup(ownerId, PHONE);
    await handleNameReply(ownerId, text("skip"));
    await handleFirstTaskReply(ownerId, text("skip"));
    vi.mocked(sendWhatsAppReplyButtons).mockClear();
    vi.mocked(sendWhatsAppMessage).mockClear();
  }

  function connectMicrosoft(ownerId: number) {
    upsertAccount(ownerId, {
      provider: "microsoft",
      email: uniqueEmail("post-connect-setup-ms"),
      accessToken: "t",
      refreshToken: "r",
      expiryDate: null,
    });
  }

  it("returns false and does nothing for a non-interactive message", async () => {
    const ownerId = newOwnerId();
    await pastFirstTask(ownerId);

    const handled = await handlePostConnectSetupReply(ownerId, text("yes"));

    expect(handled).toBe(false);
    expect(sendWhatsAppReplyButtons).not.toHaveBeenCalled();
  });

  it("returns false when there's no pending setup step for this owner", async () => {
    const ownerId = newOwnerId();
    const handled = await handlePostConnectSetupReply(ownerId, tap("briefing_yes"));
    expect(handled).toBe(false);
  });

  it("returns false for a stray button id that doesn't match the outstanding question", async () => {
    const ownerId = newOwnerId();
    await pastFirstTask(ownerId);

    const handled = await handlePostConnectSetupReply(ownerId, tap("teams_yes"));

    expect(handled).toBe(false);
    expect(getPendingSetup(ownerId)).toBe("ask_briefing"); // unchanged
  });

  it("on a Yes to the briefing question: saves proactive=true, defaults the content, stamps last_proactive_send_date, and finishes setup when no Microsoft account is connected", async () => {
    const ownerId = newOwnerId();
    await pastFirstTask(ownerId);

    const handled = await handlePostConnectSetupReply(ownerId, tap("briefing_yes"));

    expect(handled).toBe(true);
    const settings = getBriefingSettings(ownerId);
    expect(settings.proactive).toBe(true);
    expect(settings.includeNews).toBe(true);
    expect(settings.topics.length).toBeGreaterThan(0);
    expect(getSetting(ownerId, "last_proactive_send_date")).toBe(todayKey());
    expect(sendWhatsAppMessage).toHaveBeenCalledWith(PHONE, expect.stringContaining("news"));
    expect(sendWhatsAppReplyButtons).not.toHaveBeenCalled(); // no Microsoft account, so no Teams question
    expect(getPendingSetup(ownerId)).toBeNull();
    expect(sendWhatsAppMessage).toHaveBeenCalledWith(PHONE, expect.stringContaining("All set"));
  });

  it("on a Yes to the briefing question, with a Microsoft account connected: asks about Teams next instead of finishing", async () => {
    const ownerId = newOwnerId();
    connectMicrosoft(ownerId);
    await pastFirstTask(ownerId);

    const handled = await handlePostConnectSetupReply(ownerId, tap("briefing_yes"));

    expect(handled).toBe(true);
    const [, , buttons] = vi.mocked(sendWhatsAppReplyButtons).mock.calls[0];
    expect(buttons.map((b) => b.id)).toEqual(["teams_yes", "teams_no"]);
    expect(getPendingSetup(ownerId)).toBe("ask_teams");
  });

  it("on a No to the briefing question: saves proactive=false and finishes setup when no Microsoft account is connected", async () => {
    const ownerId = newOwnerId();
    await pastFirstTask(ownerId);

    const handled = await handlePostConnectSetupReply(ownerId, tap("briefing_no"));

    expect(handled).toBe(true);
    expect(getBriefingSettings(ownerId).proactive).toBe(false);
    expect(getSetting(ownerId, "last_proactive_send_date")).toBeNull();
    expect(sendWhatsAppReplyButtons).not.toHaveBeenCalled();
    expect(getPendingSetup(ownerId)).toBeNull();
    expect(sendWhatsAppMessage).toHaveBeenCalledWith(PHONE, expect.stringContaining("All set"));
  });

  it("on a No to the briefing question, with a Microsoft account connected: asks about Teams next", async () => {
    const ownerId = newOwnerId();
    connectMicrosoft(ownerId);
    await pastFirstTask(ownerId);

    await handlePostConnectSetupReply(ownerId, tap("briefing_no"));

    const [, , buttons] = vi.mocked(sendWhatsAppReplyButtons).mock.calls[0];
    expect(buttons.map((b) => b.id)).toEqual(["teams_yes", "teams_no"]);
    expect(getPendingSetup(ownerId)).toBe("ask_teams");
  });

  it("on the Teams question: toggles the teams tool, clears pending setup, and sends the closing message", async () => {
    const ownerId = newOwnerId();
    connectMicrosoft(ownerId);
    await pastFirstTask(ownerId);
    await handlePostConnectSetupReply(ownerId, tap("briefing_no"));
    vi.mocked(sendWhatsAppMessage).mockClear();
    vi.mocked(sendWhatsAppReplyButtons).mockClear();

    const handled = await handlePostConnectSetupReply(ownerId, tap("teams_yes"));

    expect(handled).toBe(true);
    expect(getEnabledTools(ownerId).has("teams")).toBe(true);
    expect(sendWhatsAppReplyButtons).not.toHaveBeenCalled(); // no further scripted button question
    expect(getPendingSetup(ownerId)).toBeNull();
    expect(sendWhatsAppMessage).toHaveBeenCalledWith(PHONE, expect.stringContaining("All set"));
    expect(sendWhatsAppMessage).toHaveBeenCalledWith(PHONE, expect.stringContaining("Sam"));
  });
});
