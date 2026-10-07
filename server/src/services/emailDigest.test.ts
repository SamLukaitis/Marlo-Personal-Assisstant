import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../providers/whatsapp.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../providers/whatsapp.js")>();
  return {
    ...actual,
    sendWhatsAppMessage: vi.fn(),
    sendWhatsAppTemplate: vi.fn(),
    sendChoiceMessage: vi.fn(),
    isWhatsAppConfigured: vi.fn().mockReturnValue(true),
  };
});

const { sendWhatsAppMessage, sendWhatsAppTemplate, sendChoiceMessage, isWhatsAppConfigured } = await import(
  "../providers/whatsapp.js"
);
const {
  findOrCreateUserByEmail,
  addPhoneNumberForUser,
  recordInboundMessage,
  getWhatsAppHistory,
  setSetting,
  consumePendingAction,
} = await import("../db/store.js");
const { queueForEmailDigest, flushEmailDigestIfDue, queuedEmailDigestCount } = await import("./emailDigest.js");
const { setEmailDigestTime, setRealPersonAlertMode, setRealPersonAlertsEnabled } = await import(
  "./emailAlertSettings.js"
);
const { setUserTimezone } = await import("./userTimezone.js");
const { DateTime } = await import("luxon");

// Every test user is put in this zone (their phone numbers would otherwise imply one), and
// setLocalTime reads the clock in it, so nothing here depends on the machine running the tests.
const TEST_ZONE = "Europe/London";

let counter = 0;
function newUser(prefix: string) {
  counter += 1;
  return findOrCreateUserByEmail(`${prefix}-${Date.now()}-${counter}@example.com`);
}

// See importantEmailAlerts.test.ts's comment on phone prefixes shared across test files — this
// file uses "44700008".
// A user who has picked digest mode themselves, so their first digest carries no check-in question.
function registerActivePhone(ownerId: number): string {
  setRealPersonAlertMode(ownerId, "digest");
  return registerUndecidedPhone(ownerId);
}

// A user still on the default, who gets the first-digest question. `messagedRecently: false` means
// their 24h window with us is closed, so nothing but a template can reach them.
function registerUndecidedPhone(ownerId: number, opts: { messagedRecently?: boolean } = {}): string {
  counter += 1;
  const phone = `44700008${String(counter).padStart(4, "0")}`;
  addPhoneNumberForUser(ownerId, phone);
  setUserTimezone(ownerId, TEST_ZONE);
  if (opts.messagedRecently !== false) recordInboundMessage(phone);
  return phone;
}

function email(id: string, from: string, subject: string, accountId = 1) {
  return { id, accountId, from, subject };
}

function setLocalTime(hhmm: string, day = 10) {
  const [hour, minute] = hhmm.split(":").map(Number);
  vi.setSystemTime(DateTime.fromObject({ year: 2026, month: 9, day, hour, minute }, { zone: TEST_ZONE }).toJSDate());
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.mocked(sendWhatsAppMessage).mockReset();
  vi.mocked(sendWhatsAppTemplate).mockReset();
  vi.mocked(sendChoiceMessage).mockReset().mockResolvedValue([{ wamid: "wamid.CHOICE", text: "choice" }]);
  vi.mocked(isWhatsAppConfigured).mockReset().mockReturnValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("flushEmailDigestIfDue", () => {
  it("sends one summary line once the digest time has passed, then empties the queue", async () => {
    const user = newUser("digest-send");
    const phone = registerActivePhone(user.id);
    queueForEmailDigest(user.id, [
      email("m1", "Sarah Jones <sarah@example.com>", "Lunch on Sunday?"),
      email("m2", "Dr Patel <patel@example.com>", "Your results"),
    ]);

    setLocalTime("21:05");
    await flushEmailDigestIfDue(user.id);

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    const [sentTo, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(sentTo).toBe(phone);
    expect(text).toContain("Your 9pm email summary");
    expect(text).toContain("2 new emails");
    expect(text).toContain("Sarah Jones");
    expect(text).toContain("Lunch on Sunday?");
    expect(text).toContain("Dr Patel");
    expect(queuedEmailDigestCount(user.id)).toBe(0);
  });

  it("keeps the email ids in chat history only, so a later 'reply to Sarah' can act on them", async () => {
    const user = newUser("digest-history");
    const phone = registerActivePhone(user.id);
    queueForEmailDigest(user.id, [email("gmail-9", "Sarah <sarah@example.com>", "Lunch", 5)]);

    setLocalTime("21:05");
    await flushEmailDigestIfDue(user.id);

    const [, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(text).not.toContain("gmail-9");
    const last = getWhatsAppHistory(phone).at(-1)!;
    expect(last.content).toContain("message_id=gmail-9");
    expect(last.content).toContain("account_id=5");
  });

  it("waits until the digest time", async () => {
    const user = newUser("digest-early");
    registerActivePhone(user.id);
    queueForEmailDigest(user.id, [email("m1", "Sarah <sarah@example.com>", "Hi")]);

    setLocalTime("20:55");
    await flushEmailDigestIfDue(user.id);

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(queuedEmailDigestCount(user.id)).toBe(1);
  });

  it("honours a custom digest time", async () => {
    const user = newUser("digest-custom-time");
    registerActivePhone(user.id);
    setEmailDigestTime(user.id, "18:00");
    queueForEmailDigest(user.id, [email("m1", "Sarah <sarah@example.com>", "Hi")]);

    setLocalTime("18:01");
    await flushEmailDigestIfDue(user.id);

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    const [, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(text).toContain("6pm email summary");
    expect(text).not.toContain("9pm");
  });

  it("sends nothing on a day with no emails, and doesn't send a late arrival the same evening", async () => {
    const user = newUser("digest-empty");
    registerActivePhone(user.id);

    setLocalTime("21:00");
    await flushEmailDigestIfDue(user.id);
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();

    queueForEmailDigest(user.id, [email("late", "Sarah <sarah@example.com>", "Late one")]);
    setLocalTime("21:30");
    await flushEmailDigestIfDue(user.id);
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(queuedEmailDigestCount(user.id)).toBe(1);

    setLocalTime("21:00", 11);
    await flushEmailDigestIfDue(user.id);
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
  });

  it("sends at most once a day", async () => {
    const user = newUser("digest-once");
    registerActivePhone(user.id);
    queueForEmailDigest(user.id, [email("m1", "Sarah <sarah@example.com>", "Hi")]);

    setLocalTime("21:00");
    await flushEmailDigestIfDue(user.id);
    queueForEmailDigest(user.id, [email("m2", "Tom <tom@example.com>", "Later")]);
    setLocalTime("22:00");
    await flushEmailDigestIfDue(user.id);

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
  });

  it("names the first few and counts the rest", async () => {
    const user = newUser("digest-overflow");
    registerActivePhone(user.id);
    queueForEmailDigest(
      user.id,
      Array.from({ length: 8 }, (_, i) => email(`m${i}`, `Person${i} <p${i}@example.com>`, `Subject ${i}`))
    );

    setLocalTime("21:05");
    await flushEmailDigestIfDue(user.id);

    const [, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(text).toContain("8 new emails");
    expect(text).toContain("Person0");
    expect(text).toContain("Person4");
    expect(text).not.toContain("Person5");
    expect(text).toContain("3 more");
  });

  it("keeps the queue and retries when WhatsApp isn't configured or there is no number", async () => {
    const user = newUser("digest-undeliverable");
    queueForEmailDigest(user.id, [email("m1", "Sarah <sarah@example.com>", "Hi")]);

    setLocalTime("21:05");
    await flushEmailDigestIfDue(user.id);
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(queuedEmailDigestCount(user.id)).toBe(1);

    registerActivePhone(user.id);
    vi.mocked(isWhatsAppConfigured).mockReturnValue(false);
    await flushEmailDigestIfDue(user.id);
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(queuedEmailDigestCount(user.id)).toBe(1);
  });

  it("runs on the user's own clock when their timezone is known", async () => {
    const user = newUser("digest-timezone");
    registerActivePhone(user.id);
    setUserTimezone(user.id, "Europe/London");
    queueForEmailDigest(user.id, [email("m1", "Sarah <sarah@example.com>", "Hi")]);

    // 20:30 UTC on 10 Sep is 21:30 in London (BST) but only 16:30 in New York.
    vi.setSystemTime(new Date("2026-09-10T19:30:00Z"));
    await flushEmailDigestIfDue(user.id);
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();

    vi.setSystemTime(new Date("2026-09-10T20:30:00Z"));
    await flushEmailDigestIfDue(user.id);
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);

    const other = newUser("digest-timezone-ny");
    registerActivePhone(other.id);
    setUserTimezone(other.id, "America/New_York");
    queueForEmailDigest(other.id, [email("m1", "Sarah <sarah@example.com>", "Hi")]);
    await flushEmailDigestIfDue(other.id);
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
  });

  it("counts the day by the user's clock, not the server's", async () => {
    const user = newUser("digest-timezone-day");
    registerActivePhone(user.id);
    setUserTimezone(user.id, "Europe/London");

    vi.setSystemTime(new Date("2026-09-10T20:30:00Z"));
    queueForEmailDigest(user.id, [email("m1", "Sarah <sarah@example.com>", "Hi")]);
    await flushEmailDigestIfDue(user.id);
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);

    // 23:30 UTC is 00:30 the next day in London — a new day, but before 21:00, so nothing yet.
    vi.setSystemTime(new Date("2026-09-10T23:30:00Z"));
    queueForEmailDigest(user.id, [email("m2", "Tom <tom@example.com>", "Hi")]);
    await flushEmailDigestIfDue(user.id);
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-09-11T20:30:00Z"));
    await flushEmailDigestIfDue(user.id);
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(2);
  });

  it("the first digest asks whether to keep it with three buttons, says it's a trial, and only ever asks once", async () => {
    const user = newUser("digest-intro");
    const phone = registerUndecidedPhone(user.id);
    queueForEmailDigest(user.id, [email("m1", "Sarah <sarah@example.com>", "Hi")]);

    setLocalTime("21:05");
    await flushEmailDigestIfDue(user.id);

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(sendChoiceMessage).toHaveBeenCalledTimes(1);
    const [sentTo, body, buttons] = vi.mocked(sendChoiceMessage).mock.calls[0];
    expect(sentTo).toBe(phone);
    expect(body).toContain("Sarah");
    expect(body).toContain("trying something new");
    expect(body).toContain("9pm");
    expect(body).toContain("flights");
    // The buttons carry the answer, so the text doesn't tell them to type one.
    expect(body).not.toContain("Reply");
    expect(buttons.map((b) => b.title)).toEqual(["Keep daily summary", "Ping me instantly", "Different time"]);
    expect(buttons.every((b) => b.title.length <= 20)).toBe(true);
    expect(buttons.map((b) => b.id.split(":")[2])).toEqual(["keep", "instant", "time"]);
    // The instruction for acting on a typed answer lives in chat history only, not in the sent text.
    expect(body).not.toContain("set_email_alerts");
    expect(getWhatsAppHistory(phone).at(-1)!.content).toContain("set_email_alerts");

    queueForEmailDigest(user.id, [email("m2", "Tom <tom@example.com>", "Later")]);
    setLocalTime("21:05", 11);
    await flushEmailDigestIfDue(user.id);
    expect(sendChoiceMessage).toHaveBeenCalledTimes(1);
    const [, second] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(second).not.toContain("trying something new");
  });

  // A template can't carry buttons, so someone we can't message freely gets the question in words.
  it("outside the 24h window there are no buttons, so it asks for a typed reply instead", async () => {
    const user = newUser("digest-intro-template");
    registerUndecidedPhone(user.id, { messagedRecently: false });
    queueForEmailDigest(user.id, [email("m1", "Sarah <sarah@example.com>", "Hi")]);

    setLocalTime("21:05");
    await flushEmailDigestIfDue(user.id);

    expect(sendChoiceMessage).not.toHaveBeenCalled();
    expect(sendWhatsAppTemplate).toHaveBeenCalledTimes(1);
    const [, template, text] = vi.mocked(sendWhatsAppTemplate).mock.calls[0];
    expect(template).toBe("marlowe_alert");
    expect(text).toContain("trying something new");
    expect(text).toContain("keep it");
    expect(text).toContain("instant");
  });

  it("keeps the whole check-in question inside a template even with long names and subjects", async () => {
    const user = newUser("digest-intro-long");
    registerUndecidedPhone(user.id, { messagedRecently: false });
    setSetting(user.id, "user_name", "Bartholomew-Alexander");
    queueForEmailDigest(
      user.id,
      Array.from({ length: 12 }, (_, i) =>
        email(`m${i}`, `${"Very Long Sender Name ".repeat(6)}${i} <p${i}@example.com>`, "Subject ".repeat(30))
      )
    );

    setLocalTime("21:05");
    await flushEmailDigestIfDue(user.id);

    const [, , text] = vi.mocked(sendWhatsAppTemplate).mock.calls[0];
    expect(text.length).toBeLessThanOrEqual(1000);
    expect(text).toMatch(/every email as it arrives\.$/);
  });

  it("doesn't ask a user who already chose the digest themselves", async () => {
    const user = newUser("digest-intro-chosen");
    registerActivePhone(user.id);
    queueForEmailDigest(user.id, [email("m1", "Sarah <sarah@example.com>", "Hi")]);

    setLocalTime("21:05");
    await flushEmailDigestIfDue(user.id);
    expect(sendChoiceMessage).not.toHaveBeenCalled();
    const [, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(text).not.toContain("trying something new");
  });

  it("asks again on the next digest if the first one couldn't be delivered", async () => {
    const user = newUser("digest-intro-retry");
    registerUndecidedPhone(user.id);
    queueForEmailDigest(user.id, [email("m1", "Sarah <sarah@example.com>", "Hi")]);

    setLocalTime("21:05");
    vi.mocked(sendChoiceMessage).mockRejectedValueOnce(new Error("network"));
    await flushEmailDigestIfDue(user.id);
    await flushEmailDigestIfDue(user.id);
    expect(sendChoiceMessage).toHaveBeenCalledTimes(2);
    expect(queuedEmailDigestCount(user.id)).toBe(0);
  });

  it("the buttons' pending question is open until answered, and lasts more than a day", async () => {
    const user = newUser("digest-intro-ttl");
    registerUndecidedPhone(user.id);
    queueForEmailDigest(user.id, [email("m1", "Sarah <sarah@example.com>", "Hi")]);

    setLocalTime("21:05");
    await flushEmailDigestIfDue(user.id);
    const [, , buttons] = vi.mocked(sendChoiceMessage).mock.calls[0];
    const actionId = buttons[0].id.split(":")[1];
    vi.setSystemTime(new Date(2026, 8, 12, 21, 5)); // two days later
    expect(consumePendingAction(actionId, user.id)?.mode).toBe("email_digest");
  });

  it("drops the queue instead of sending it if the user turned people's emails off", async () => {
    const user = newUser("digest-turned-off");
    registerActivePhone(user.id);
    queueForEmailDigest(user.id, [email("m1", "Sarah <sarah@example.com>", "Hi")]);
    setRealPersonAlertsEnabled(user.id, false);

    setLocalTime("21:05");
    await flushEmailDigestIfDue(user.id);

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(sendChoiceMessage).not.toHaveBeenCalled();
    expect(queuedEmailDigestCount(user.id)).toBe(0);
  });

  it("treats a last-sent date later than the user's own date as already sent", async () => {
    const user = newUser("digest-date-ahead");
    registerActivePhone(user.id);
    queueForEmailDigest(user.id, [email("m1", "Sarah <sarah@example.com>", "Hi")]);
    setSetting(user.id, "last_email_digest_date", "2026-09-11");

    setLocalTime("21:05", 10);
    await flushEmailDigestIfDue(user.id);
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(queuedEmailDigestCount(user.id)).toBe(1);
  });

  it("tolerates a corrupted queue", async () => {
    const user = newUser("digest-corrupt");
    registerActivePhone(user.id);
    setSetting(user.id, "email_digest_queue", "not json");

    setLocalTime("21:05");
    await expect(flushEmailDigestIfDue(user.id)).resolves.toBeUndefined();
    expect(queuedEmailDigestCount(user.id)).toBe(0);
  });
});
