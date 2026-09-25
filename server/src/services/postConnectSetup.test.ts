import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NewsTopic } from "../providers/news.js";

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
// The real check calls a model for anything outside its fixed list; stubbed to that list alone.
const mockWantsToContinue = vi.fn();
vi.mock("./setupIntent.js", async (importActual) => {
  const actual = await importActual<typeof import("./setupIntent.js")>();
  mockWantsToContinue.mockImplementation(async (_ownerId: number, body: string) => actual.isObviousContinue(body));
  return { ...actual, wantsToContinueSetup: (...args: unknown[]) => mockWantsToContinue(...args) };
});
const mockScanAndCurate = vi.fn();
vi.mock("./importantEmailAlerts.js", () => ({
  scanAndCurateImportantEmailsForOnboarding: (...args: unknown[]) => mockScanAndCurate(...args),
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
const { findOrCreateUserByEmail, getPendingSetup, getEnabledTools, getSetting, setSetting, upsertAccount } =
  await import("../db/store.js");
const { getBriefingSettings, saveBriefingSettings } = await import("./briefing.js");
const { userLocalClock } = await import("./userTimezone.js");
const { incrementSuppressedOnboardingAlerts, takeSuppressedOnboardingAlertCount, isOnboardingSuppressionActive } =
  await import("./onboardingAlertSuppression.js");

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
  mockScanAndCurate.mockClear().mockResolvedValue(null);
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

  // The unread count was dropped: it was capped at the 20 most recent emails (so a busy inbox
  // always read "20"), and a scan that checked and found nothing is the more useful thing to say.
  it("says nothing is urgent when the 24h scan checked and found nothing, and never gives an unread count", async () => {
    const ownerId = newOwnerId();
    vi.mocked(hubListMessages).mockResolvedValue([
      { unread: true, subject: "A" } as never,
      { unread: true, subject: "B" } as never,
    ]);
    mockScanAndCurate.mockResolvedValue({ lines: [], moreCount: 0 });

    await startPostConnectSetup(ownerId, PHONE);

    const [, confirmText] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(confirmText).toBe(
      "*Connected!* ✅ I can see your inbox and your calendar. Nothing urgent in your inbox from the last 24 hours — I'll message you the moment something important comes in."
    );
  });

  it("adds today's calendar after the nothing-urgent line", async () => {
    const ownerId = newOwnerId();
    vi.mocked(hubListEvents).mockResolvedValue([
      { title: "Team standup", start: "2026-09-15T09:00:00.000Z" } as never,
    ]);
    mockScanAndCurate.mockResolvedValue({ lines: [], moreCount: 0 });

    await startPostConnectSetup(ownerId, PHONE);

    const [, confirmText] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(confirmText).toContain("Nothing urgent in your inbox from the last 24 hours — I'll message you the moment something important comes in.");
    expect(confirmText).toContain("You've also got *Team standup* on today's calendar.");
  });

  // The curated important-email scan is bounded to the 24 hours before connecting (see
  // importantEmailAlerts.ts's isWithinOnboardingLookback) — from this test's point of view (the
  // scan itself is mocked) that just means a real, curated finding still replaces the plain
  // unread count entirely, per the user's own feedback: "instead of something like 20 unread
  // emails it should say the most important emails".
  it("leads with the curated important-email preview instead of a plain unread count, when one is found", async () => {
    const ownerId = newOwnerId();
    vi.mocked(hubListMessages).mockResolvedValue([
      { unread: true, subject: "A" } as never,
      { unread: true, subject: "B" } as never,
    ]);
    mockScanAndCurate.mockResolvedValue({
      lines: ["🔐 New sign-in detected.", "✈️ Gate moved to B12."],
      moreCount: 7,
    });

    await startPostConnectSetup(ownerId, PHONE);

    expect(mockScanAndCurate).toHaveBeenCalledWith(ownerId);
    const [, confirmText] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(confirmText).toContain("🔐 New sign-in detected.");
    expect(confirmText).toContain("✈️ Gate moved to B12.");
    expect(confirmText).toContain("7 more");
    expect(confirmText).not.toContain("2 unread emails");
  });

  it("still mentions the next calendar event alongside a curated preview", async () => {
    const ownerId = newOwnerId();
    vi.mocked(hubListEvents).mockResolvedValue([{ title: "Team standup", start: "2026-09-15T09:00:00.000Z" } as never]);
    mockScanAndCurate.mockResolvedValue({ lines: ["🔐 New sign-in detected."], moreCount: 0 });

    await startPostConnectSetup(ownerId, PHONE);

    const [, confirmText] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(confirmText).toContain("🔐 New sign-in detected.");
    expect(confirmText).toContain("Team standup");
  });

  it("omits the '...and N more' line when the preview covers everything found", async () => {
    const ownerId = newOwnerId();
    mockScanAndCurate.mockResolvedValue({ lines: ["🔐 New sign-in detected."], moreCount: 0 });

    await startPostConnectSetup(ownerId, PHONE);

    const [, confirmText] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(confirmText).not.toContain("more");
  });

  // null means the scan couldn't run (listing or classification failed) — claiming "nothing
  // urgent" then would be a guess, so only the calendar (if any) is mentioned.
  it("makes no inbox claim when the scan couldn't check", async () => {
    const ownerId = newOwnerId();
    vi.mocked(hubListMessages).mockResolvedValue([{ unread: true, subject: "A" } as never]);
    vi.mocked(hubListEvents).mockResolvedValue([
      { title: "Team standup", start: "2026-09-15T09:00:00.000Z" } as never,
    ]);
    mockScanAndCurate.mockResolvedValue(null);

    await startPostConnectSetup(ownerId, PHONE);

    const [, confirmText] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(confirmText).toBe(
      "*Connected!* ✅ I can see your inbox and your calendar. I can already see *Team standup* on today's calendar."
    );
  });

  it("still sends 'Connected!' even if the curated scan itself throws", async () => {
    const ownerId = newOwnerId();
    mockScanAndCurate.mockRejectedValue(new Error("classification API down"));

    await startPostConnectSetup(ownerId, PHONE);

    expect(sendWhatsAppMessage).toHaveBeenCalledWith(PHONE, expect.stringContaining("Connected"));
  });

  // Regression test: the pre-connect registration flow (whatsappRegistration.ts) already asks
  // "what should I call you?" once. If a name was already captured and persisted to user_name
  // before this chain starts, asking again is a redundant, annoying repeat of a question the user
  // already answered — and was the root cause of a real bug (a frustrated re-answer like "I
  // already said Sam" getting stored as the permanent display name).
  it("skips the name question and goes straight to the first-task question when a name is already known", async () => {
    const ownerId = newOwnerId();
    setSetting(ownerId, "user_name", "Sam");

    await startPostConnectSetup(ownerId, PHONE);

    expect(sendWhatsAppMessage).not.toHaveBeenCalledWith(PHONE, expect.stringContaining("what should I call you"));
    expect(getPendingSetup(ownerId)).toBe("ask_first_task");
  });

  // Regression test for the real bug behind onboardingAlertSuppression.ts's grace period: the
  // chain finishes in well under a minute in this test (as it does for a real fast-tapping user),
  // clearing pending_setup — suppression must still be active right after, on connection-recency
  // alone, or the scanners' next scheduler tick floods the backlog exactly as before this fix.
  it("keeps onboarding alert suppression active even after the whole chain finishes almost instantly", async () => {
    const ownerId = newOwnerId();

    await startPostConnectSetup(ownerId, PHONE);
    await handleNameReply(ownerId, text("Sam"));
    await handleFirstTaskReply(ownerId, text("skip"));
    await handlePostConnectSetupReply(ownerId, tap("briefing_no"));

    expect(getPendingSetup(ownerId)).toBeNull(); // chain really did finish
    expect(isOnboardingSuppressionActive(ownerId)).toBe(true); // but suppression outlives it
  });
});

// Task 8: a mailbox linked long after the account was created (via the assistant's connect_email
// tool) must not re-run the parts of the fresh-signup chain that no longer apply — see
// startPostConnectSetup's linkedExistingAccount comment. askName/askFirstTask are always skipped;
// askBriefing is skipped only when the user already has briefing settings on file, since its Yes/No
// handler unconditionally overwrites `topics` via saveBriefingSettings (review finding #1 — the
// guard was originally too broad and dropped the briefing offer, Teams question, and closing
// feedback prompt for every linked-later user, not just the ones with something to protect).
describe("startPostConnectSetup — linkedExistingAccount", () => {
  it("always skips name/first-task, regardless of prior briefing settings", async () => {
    const ownerId = newOwnerId();

    await startPostConnectSetup(ownerId, PHONE, true);

    expect(sendWhatsAppMessage).toHaveBeenCalledWith(PHONE, expect.stringContaining("Connected"));
    expect(sendWhatsAppMessage).not.toHaveBeenCalledWith(PHONE, expect.stringContaining("what should I call you"));
    expect(sendWhatsAppMessage).not.toHaveBeenCalledWith(PHONE, expect.stringContaining("finish setting up"));
    expect(getPendingSetup(ownerId)).not.toBe("ask_name");
    expect(getPendingSetup(ownerId)).not.toBe("ask_first_task");
  });

  it("still asks the briefing question when the user has no briefing settings on file yet", async () => {
    const ownerId = newOwnerId();
    expect(getBriefingSettings(ownerId)).toBeTruthy(); // sanity: defaults exist, but nothing was ever saved

    await startPostConnectSetup(ownerId, PHONE, true);

    expect(sendWhatsAppReplyButtons).toHaveBeenCalledTimes(1);
    const [, , buttons] = vi.mocked(sendWhatsAppReplyButtons).mock.calls[0];
    expect(buttons.map((b) => b.id)).toEqual(["briefing_yes", "briefing_no"]);
    expect(getPendingSetup(ownerId)).toBe("ask_briefing");
  });

  it("skips the briefing question (straight to Teams/finish) once settings already exist, and does not touch topics", async () => {
    const ownerId = newOwnerId();
    saveBriefingSettings(ownerId, {
      ...getBriefingSettings(ownerId),
      proactive: true,
      includeWeather: true,
      weatherLocation: "Lisbon",
      sendTime: "07:30",
      topics: ["technology"] as NewsTopic[],
    });

    await startPostConnectSetup(ownerId, PHONE, true);

    expect(sendWhatsAppReplyButtons).not.toHaveBeenCalled(); // no Microsoft account -> askTeamsOrFinish closes immediately
    expect(getPendingSetup(ownerId)).toBeNull();
    const settings = getBriefingSettings(ownerId);
    expect(settings.proactive).toBe(true);
    expect(settings.weatherLocation).toBe("Lisbon");
    expect(settings.sendTime).toBe("07:30");
    expect(settings.topics).toEqual(["technology"]); // the field actually at risk — left untouched
  });

  it("skipping the briefing question still reaches the Teams question for a Microsoft-linked owner", async () => {
    const ownerId = newOwnerId();
    upsertAccount(ownerId, {
      provider: "microsoft",
      email: uniqueEmail("post-connect-setup-linked-ms"),
      accessToken: "t",
      refreshToken: "r",
      expiryDate: null,
    });
    saveBriefingSettings(ownerId, { ...getBriefingSettings(ownerId), topics: ["technology"] as NewsTopic[] });

    await startPostConnectSetup(ownerId, PHONE, true);

    const [, , buttons] = vi.mocked(sendWhatsAppReplyButtons).mock.calls[0];
    expect(buttons.map((b) => b.id)).toEqual(["teams_yes", "teams_no"]);
    expect(getPendingSetup(ownerId)).toBe("ask_teams");
  });

  // Review finding #5: proves the hazard the guard above exists for, rather than just asserting
  // fields that were never actually at risk (saveBriefingSettings spreads `...current` first, so
  // only `topics` is genuinely clobbered by a Yes tap — everything else survives either way).
  it("proves the hazard: the (unguarded) fresh-signup chain overwrites topics on a Yes tap, regardless of what was already saved", async () => {
    const ownerId = newOwnerId();
    saveBriefingSettings(ownerId, { ...getBriefingSettings(ownerId), topics: ["technology"] as NewsTopic[] });

    await startPostConnectSetup(ownerId, PHONE); // linkedExistingAccount omitted — chain always runs
    await handleNameReply(ownerId, text("skip"));
    await handleFirstTaskReply(ownerId, text("skip"));
    await handlePostConnectSetupReply(ownerId, tap("briefing_yes"));

    expect(getBriefingSettings(ownerId).topics).not.toEqual(["technology"]);
  });

  it("still sends the connected confirmation and first-value fact, same as a fresh signup", async () => {
    const ownerId = newOwnerId();
    mockScanAndCurate.mockResolvedValue({ lines: ["🧾 Invoice due Friday."], moreCount: 0 });

    await startPostConnectSetup(ownerId, PHONE, true);

    const [, confirmText] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(confirmText).toContain("Invoice due Friday");
  });

  it("defaults to the fresh-signup chain when the flag is omitted (unchanged behavior)", async () => {
    const ownerId = newOwnerId();

    await startPostConnectSetup(ownerId, PHONE);

    expect(getPendingSetup(ownerId)).toBe("ask_name");
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

  // Regression test for the real bug: asked this question a second time (having already
  // answered it during pre-connect registration), a user can reasonably reply with a sentence
  // like this instead of just their name. That whole sentence must never become the permanent
  // display name — it previously did, and leaked into every personalized proactive message.
  // It now goes to the assistant rather than being dropped (see the "isn't a name is answered"
  // describe below), so the chain advances once that answer lands instead of immediately — but
  // the sentence still must not be saved as a name, which is what this test has always guarded.
  it("on a sentence-shaped reply (not a real name): saves no name, advances once it's answered", async () => {
    const ownerId = newOwnerId();
    await startPostConnectSetup(ownerId, PHONE);
    vi.mocked(handleText).mockClear();

    const handled = await handleNameReply(ownerId, text("I already said Sam"));

    expect(handled).toBe(true);
    expect(getSetting(ownerId, "user_name")).toBeNull();

    await vi.mocked(handleText).mock.calls[0][6]!();

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

  it("treats a natural 'carry on' phrasing the intent check recognizes as a skip, not a request", async () => {
    const ownerId = newOwnerId();
    await pastName(ownerId);
    mockWantsToContinue.mockResolvedValueOnce(true);

    const handled = await handleFirstTaskReply(ownerId, text("Sounds good, go ahead with the rest"));

    expect(handled).toBe(true);
    expect(mockWantsToContinue).toHaveBeenCalledWith(ownerId, "Sounds good, go ahead with the rest");
    expect(handleText).not.toHaveBeenCalled();
    expect(getPendingSetup(ownerId)).toBe("ask_briefing");
  });

  // handleText only queues the message; the assistant answers after a debounce. The briefing
  // question must wait for that answer (see postConnectSetup.firstTask.integration.test.ts).
  it("on a real request: forwards it to ordinary chat handling, and asks the briefing question only once it's answered", async () => {
    const ownerId = newOwnerId();
    await pastName(ownerId);

    const handled = await handleFirstTaskReply(ownerId, text("reply to John's email for me"));

    expect(handled).toBe(true);
    expect(handleText).toHaveBeenCalledWith(
      ownerId,
      PHONE,
      "reply to John's email for me",
      expect.any(String),
      undefined,
      undefined,
      expect.any(Function)
    );
    expect(getPendingSetup(ownerId)).toBe("ask_first_task");
    expect(sendWhatsAppReplyButtons).not.toHaveBeenCalled();

    const afterReply = vi.mocked(handleText).mock.calls[0][6]!;
    await afterReply();

    expect(getPendingSetup(ownerId)).toBe("ask_briefing");
    expect(sendWhatsAppReplyButtons).toHaveBeenCalledTimes(1);
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
    expect(getSetting(ownerId, "last_proactive_send_date")).toBe(userLocalClock(ownerId).dateKey);
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

  // The chain used to end on a statement, leaving someone who had just tapped through setup with
  // no obvious next move — so the closing message is followed by an open question, as its own
  // message. pending_setup is already cleared by then, so their answer reaches the assistant.
  it("follows the closing message with an open question, as a separate message", async () => {
    const ownerId = newOwnerId();
    await pastFirstTask(ownerId);

    await handlePostConnectSetupReply(ownerId, tap("briefing_no"));

    const texts = vi.mocked(sendWhatsAppMessage).mock.calls.map(([, text]) => text);
    const closingIndex = texts.findIndex((text) => text.includes("All set"));
    expect(closingIndex).toBeGreaterThanOrEqual(0);
    expect(texts[closingIndex + 1]).toMatch(/anything you need help with|any questions/i);
    expect(getPendingSetup(ownerId)).toBeNull();
  });

  // The closing message deliberately does NOT report a suppressed-alert backlog itself anymore —
  // see the comment on sendClosingMessage. By the time this runs, the backlog usually hasn't even
  // been discovered yet (the chain above typically finishes in well under a minute; the scanners
  // run on scheduler.ts's own 5-minute tick, unrelated to this moment) — an earlier version of
  // this fix reported it here and that mismatch was itself a bug. scheduler.ts's
  // flushOnboardingAlertSummaryIfDue reports it later instead, as its own message.
  it("never mentions a suppressed-alert backlog in the closing message, even if one exists at this moment", async () => {
    const ownerId = newOwnerId();
    await pastFirstTask(ownerId);
    incrementSuppressedOnboardingAlerts(ownerId, 3);

    await handlePostConnectSetupReply(ownerId, tap("briefing_no"));

    const closingCall = vi.mocked(sendWhatsAppMessage).mock.calls.find(([, text]) => text.includes("All set"));
    // Matches backlog-reporting phrasing specifically, not the bare word "already" — the closing
    // message's own feedback line ("any request I can't meet already gets flagged") is about
    // feature requests, not mail, and must not trip this.
    expect(closingCall?.[1]).not.toMatch(/inbox|unread|already (found|seen|spotted|noticed)/i);
    expect(takeSuppressedOnboardingAlertCount(ownerId)).toBe(3); // left untouched for the scheduler to report
  });
});

// The name step used to discard anything that wasn't a plausible name: someone who answered the
// very first question with a question of their own ("what can you actually do?") got no answer at
// all, just the next scripted question. ask_first_task already forwards free text to the real
// assistant — this step now does the same rather than swallowing it.
describe("handleNameReply — a reply that isn't a name is answered, not dropped", () => {
  it("forwards a question to ordinary chat handling and advances only once it's answered", async () => {
    const ownerId = newOwnerId();
    await startPostConnectSetup(ownerId, PHONE);
    vi.mocked(handleText).mockClear();
    vi.mocked(sendWhatsAppMessage).mockClear();

    const handled = await handleNameReply(ownerId, text("what can you actually do?"));

    expect(handled).toBe(true);
    expect(getSetting(ownerId, "user_name")).toBeNull();
    expect(handleText).toHaveBeenCalledWith(
      ownerId,
      PHONE,
      "what can you actually do?",
      expect.any(String),
      undefined,
      undefined,
      expect.any(Function)
    );
    expect(getPendingSetup(ownerId)).toBe("ask_name");

    const afterReply = vi.mocked(handleText).mock.calls[0][6]!;
    await afterReply();

    expect(getPendingSetup(ownerId)).toBe("ask_first_task");
  });

  it("still never forwards — or saves — a plain name", async () => {
    const ownerId = newOwnerId();
    await startPostConnectSetup(ownerId, PHONE);
    vi.mocked(handleText).mockClear();

    await handleNameReply(ownerId, text("Margaret"));

    expect(handleText).not.toHaveBeenCalled();
    expect(getSetting(ownerId, "user_name")).toBe("Margaret");
    expect(getPendingSetup(ownerId)).toBe("ask_first_task");
  });

  it("does not forward a second message while the first is still being answered", async () => {
    const ownerId = newOwnerId();
    await startPostConnectSetup(ownerId, PHONE);
    vi.mocked(handleText).mockClear();

    await handleNameReply(ownerId, text("what can you actually do?"));
    const handledSecond = await handleNameReply(ownerId, text("hello?"));

    expect(handledSecond).toBe(false);
    expect(handleText).toHaveBeenCalledTimes(1);
  });
});

// Two taps on the same button are two webhook messages with their own ids, so whatsappRoutes'
// alreadyProcessed (which only dedupes Meta's retries of one message) doesn't stop the second.
// Both used to run the whole branch: the briefing saved twice, and two closing messages sent.
describe("handlePostConnectSetupReply — a double tap is handled once", () => {
  async function atBriefing(ownerId: number) {
    await startPostConnectSetup(ownerId, PHONE);
    await handleNameReply(ownerId, text("Sam"));
    await handleFirstTaskReply(ownerId, text("skip"));
    vi.mocked(sendWhatsAppMessage).mockClear();
    vi.mocked(sendWhatsAppReplyButtons).mockClear();
  }

  it("ignores the second tap on the briefing question", async () => {
    const ownerId = newOwnerId();
    await atBriefing(ownerId);

    const [first, second] = await Promise.all([
      handlePostConnectSetupReply(ownerId, tap("briefing_yes")),
      handlePostConnectSetupReply(ownerId, tap("briefing_yes")),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    // The closing message pair ("All set!" + "Anything you need help with right now...") plus the
    // briefing-default announcement — sent once, not twice.
    const closings = vi
      .mocked(sendWhatsAppMessage)
      .mock.calls.filter(([, body]) => body.includes("All set!"));
    expect(closings).toHaveLength(1);
  });

  it("ignores a late tap on a question the chain has already moved past", async () => {
    const ownerId = newOwnerId();
    await atBriefing(ownerId);
    await handlePostConnectSetupReply(ownerId, tap("briefing_no"));
    vi.mocked(sendWhatsAppMessage).mockClear();

    const handled = await handlePostConnectSetupReply(ownerId, tap("briefing_yes"));

    expect(handled).toBe(false);
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });
});
