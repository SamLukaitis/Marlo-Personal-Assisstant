import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../providers/whatsapp.js", () => ({
  sendWhatsAppMessage: vi.fn(),
  sendWhatsAppReplyButtons: vi.fn(),
}));
vi.mock("./hub.js", () => ({
  hubListMessages: vi.fn().mockResolvedValue([]),
  hubListEvents: vi.fn().mockResolvedValue([]),
}));

const { sendWhatsAppMessage, sendWhatsAppReplyButtons } = await import("../providers/whatsapp.js");
const { hubListMessages, hubListEvents } = await import("./hub.js");
const { startPostConnectSetup, handlePostConnectSetupReply } = await import("./postConnectSetup.js");
const { findOrCreateUserByEmail, getPendingSetup, getEnabledTools } = await import("../db/store.js");
const { getBriefingSettings } = await import("./briefing.js");

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
});

describe("startPostConnectSetup", () => {
  it("sends the connected confirmation and the first briefing question, and sets ask_briefing pending", async () => {
    const ownerId = newOwnerId();

    await startPostConnectSetup(ownerId, PHONE);

    expect(sendWhatsAppMessage).toHaveBeenCalledWith(PHONE, expect.stringContaining("Connected"));
    expect(sendWhatsAppReplyButtons).toHaveBeenCalledTimes(1);
    const [, , buttons] = vi.mocked(sendWhatsAppReplyButtons).mock.calls[0];
    expect(buttons.map((b) => b.id)).toEqual(["briefing_yes", "briefing_no"]);
    expect(getPendingSetup(ownerId)).toBe("ask_briefing");
  });

  it("includes unread mail / calendar counts in the confirmation as a best-effort fact", async () => {
    const ownerId = newOwnerId();
    vi.mocked(hubListMessages).mockResolvedValue([
      { unread: true } as never,
      { unread: false } as never,
    ]);
    vi.mocked(hubListEvents).mockResolvedValue([{} as never]);

    await startPostConnectSetup(ownerId, PHONE);

    const [, confirmText] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(confirmText).toContain("1 unread email");
    expect(confirmText).toContain("1 thing on today's calendar");
  });
});

describe("handlePostConnectSetupReply", () => {
  it("returns false and does nothing for a non-interactive message", async () => {
    const ownerId = newOwnerId();
    await startPostConnectSetup(ownerId, PHONE);
    vi.mocked(sendWhatsAppReplyButtons).mockClear();

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
    await startPostConnectSetup(ownerId, PHONE);

    const handled = await handlePostConnectSetupReply(ownerId, tap("teams_yes"));

    expect(handled).toBe(false);
    expect(getPendingSetup(ownerId)).toBe("ask_briefing"); // unchanged
  });

  it("on a Yes to the briefing question: saves proactive=true, sends the customize follow-up, and asks about Teams next", async () => {
    const ownerId = newOwnerId();
    await startPostConnectSetup(ownerId, PHONE);
    vi.mocked(sendWhatsAppReplyButtons).mockClear();
    vi.mocked(sendWhatsAppMessage).mockClear();

    const handled = await handlePostConnectSetupReply(ownerId, tap("briefing_yes"));

    expect(handled).toBe(true);
    expect(getBriefingSettings(ownerId).proactive).toBe(true);
    expect(sendWhatsAppMessage).toHaveBeenCalledWith(PHONE, expect.stringContaining("news"));
    const [, , teamsButtons] = vi.mocked(sendWhatsAppReplyButtons).mock.calls[0];
    expect(teamsButtons.map((b) => b.id)).toEqual(["teams_yes", "teams_no"]);
    expect(getPendingSetup(ownerId)).toBe("ask_teams");
  });

  it("on a No to the briefing question: saves proactive=false and skips straight to asking about Teams", async () => {
    const ownerId = newOwnerId();
    await startPostConnectSetup(ownerId, PHONE);
    vi.mocked(sendWhatsAppMessage).mockClear();

    await handlePostConnectSetupReply(ownerId, tap("briefing_no"));

    expect(getBriefingSettings(ownerId).proactive).toBe(false);
    expect(sendWhatsAppMessage).not.toHaveBeenCalled(); // no customize follow-up
    expect(getPendingSetup(ownerId)).toBe("ask_teams");
  });

  it("on the Teams question: toggles the teams tool and asks about Schengen tracking next", async () => {
    const ownerId = newOwnerId();
    await startPostConnectSetup(ownerId, PHONE);
    await handlePostConnectSetupReply(ownerId, tap("briefing_no"));
    vi.mocked(sendWhatsAppReplyButtons).mockClear();

    const handled = await handlePostConnectSetupReply(ownerId, tap("teams_yes"));

    expect(handled).toBe(true);
    expect(getEnabledTools(ownerId).has("teams")).toBe(true);
    const [, , travelButtons] = vi.mocked(sendWhatsAppReplyButtons).mock.calls[0];
    expect(travelButtons.map((b) => b.id)).toEqual(["travel_yes", "travel_no"]);
    expect(getPendingSetup(ownerId)).toBe("ask_travel");
  });

  it("on the Schengen question: toggles the travel tool, clears pending setup, and sends the closing message", async () => {
    const ownerId = newOwnerId();
    await startPostConnectSetup(ownerId, PHONE);
    await handlePostConnectSetupReply(ownerId, tap("briefing_no"));
    await handlePostConnectSetupReply(ownerId, tap("teams_no"));
    vi.mocked(sendWhatsAppMessage).mockClear();

    const handled = await handlePostConnectSetupReply(ownerId, tap("travel_yes"));

    expect(handled).toBe(true);
    expect(getEnabledTools(ownerId).has("travel")).toBe(true);
    expect(getPendingSetup(ownerId)).toBeNull();
    expect(sendWhatsAppMessage).toHaveBeenCalledWith(PHONE, expect.stringContaining("All set"));
  });
});
