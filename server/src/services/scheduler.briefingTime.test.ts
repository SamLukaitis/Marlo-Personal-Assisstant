import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../providers/whatsapp.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../providers/whatsapp.js")>();
  return {
    ...actual,
    sendWhatsAppMessage: vi.fn(),
    sendWhatsAppTemplate: vi.fn(),
    isWhatsAppConfigured: vi.fn().mockReturnValue(true),
  };
});

vi.mock("./briefing.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./briefing.js")>();
  return { ...actual, getTodaysBriefing: vi.fn(async () => ({ date: "x", content: "Good morning" })) };
});

const { sendWhatsAppMessage } = await import("../providers/whatsapp.js");
const { findOrCreateUserByEmail, addPhoneNumberForUser, recordInboundMessage, setSetting } = await import(
  "../db/store.js"
);
const { saveBriefingSettings } = await import("./briefing.js");
const { setUserTimezone } = await import("./userTimezone.js");
const { runDailyCheckForUser } = await import("./scheduler.js");

let counter = 0;
// See importantEmailAlerts.test.ts's comment on phone prefixes shared across test files — this
// file uses "44700009".
function newSubscriber(timezone?: string) {
  counter += 1;
  const user = findOrCreateUserByEmail(`briefing-time-${Date.now()}-${counter}@example.com`);
  const phone = `44700009${String(counter).padStart(4, "0")}`;
  addPhoneNumberForUser(user.id, phone);
  recordInboundMessage(phone);
  saveBriefingSettings(user.id, {
    enabled: true,
    includeNews: false,
    topics: [],
    includeMarkets: false,
    tickers: [],
    includeWeather: false,
    weatherLocation: "",
    proactive: true,
    sendTime: "07:30",
  });
  if (timezone) setUserTimezone(user.id, timezone);
  return { user, phone };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.mocked(sendWhatsAppMessage).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("morning briefing send time", () => {
  it("goes out at the send time on the user's own clock, not the server's", async () => {
    const { user } = newSubscriber("Australia/Sydney");

    // 20:00 UTC on 9 Sep is 06:00 on the 10th in Sydney: too early.
    vi.setSystemTime(new Date("2026-09-09T20:00:00Z"));
    await runDailyCheckForUser(user.id);
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();

    // 21:45 UTC is 07:45 in Sydney.
    vi.setSystemTime(new Date("2026-09-09T21:45:00Z"));
    await runDailyCheckForUser(user.id);
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
  });

  it("sends once per local day, and again the next local day", async () => {
    const { user } = newSubscriber("Australia/Sydney");

    vi.setSystemTime(new Date("2026-09-09T21:45:00Z"));
    await runDailyCheckForUser(user.id);
    // Still 10 Sep in Sydney, though it is now 11:00 UTC.
    vi.setSystemTime(new Date("2026-09-10T01:00:00Z"));
    await runDailyCheckForUser(user.id);
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);

    // 11 Sep in Sydney.
    vi.setSystemTime(new Date("2026-09-10T21:45:00Z"));
    await runDailyCheckForUser(user.id);
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(2);
  });

  // Hawaii on deploy day: the old stamp is the server's (UTC) date, already tomorrow for them.
  it("a last-sent date ahead of the user's own date counts as already sent", async () => {
    const { user } = newSubscriber("Pacific/Honolulu");
    setSetting(user.id, "last_proactive_send_date", "2026-09-10");

    // 18:00 UTC on the 9th is 08:00 on the 9th in Honolulu: the stamp is ahead, so nothing.
    vi.setSystemTime(new Date("2026-09-09T18:00:00Z"));
    await runDailyCheckForUser(user.id);
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();

    // 18:00 UTC on the 11th is 08:00 on the 11th in Honolulu: a new day, so it goes.
    vi.setSystemTime(new Date("2026-09-11T18:00:00Z"));
    await runDailyCheckForUser(user.id);
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
  });

  it("a user across the world gets it at their own 07:30", async () => {
    const { user } = newSubscriber("America/New_York");

    // 11:00 UTC is 07:00 in New York (EDT): too early. 11:45 UTC is 07:45.
    vi.setSystemTime(new Date("2026-09-10T11:00:00Z"));
    await runDailyCheckForUser(user.id);
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    vi.setSystemTime(new Date("2026-09-10T11:45:00Z"));
    await runDailyCheckForUser(user.id);
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
  });
});

describe("morning briefing carries attention items", () => {
  it("passes this morning's attention items to the briefing and marks them done once sent", async () => {
    const { user } = newSubscriber("Europe/London");
    vi.setSystemTime(new Date("2026-10-01T10:00:00Z"));
    const { submitAttentionItem, collectAttentionForBriefing } = await import("./attention.js");
    await submitAttentionItem(user.id, {
      source: "email",
      category: "refund_dispute",
      details: { summary: "Your *Amazon* refund of *£24* was approved." },
      fallbackKey: "msg:1:refund-bt",
    });
    const { getTodaysBriefing } = await import("./briefing.js");

    vi.setSystemTime(new Date("2026-10-02T06:45:00Z")); // 07:45 London
    await runDailyCheckForUser(user.id);

    const attention = vi.mocked(getTodaysBriefing).mock.calls.at(-1)?.[1];
    expect(attention?.needsAttention).toEqual(["Your *Amazon* refund of *£24* was approved."]);
    expect(collectAttentionForBriefing(user.id, Date.now()).needsAttention).toEqual([]);
  });
});
