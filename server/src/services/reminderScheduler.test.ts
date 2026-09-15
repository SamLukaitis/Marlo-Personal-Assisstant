import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../providers/whatsapp.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../providers/whatsapp.js")>();
  return {
    ...actual, // keeps the real WhatsAppSendError class — outbound.ts's `instanceof` check needs it
    sendWhatsAppMessage: vi.fn(),
    sendWhatsAppTemplate: vi.fn(),
    isWhatsAppConfigured: vi.fn().mockReturnValue(true),
  };
});

const { sendWhatsAppMessage, sendWhatsAppTemplate, isWhatsAppConfigured } = await import("../providers/whatsapp.js");
const {
  findOrCreateUserByEmail,
  addPhoneNumberForUser,
  recordInboundMessage,
  createReminder,
  listActiveRemindersForOwner,
  searchReminders,
} = await import("../db/store.js");
const { runReminderCheckForOwner } = await import("./reminderScheduler.js");

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

// All test files share one SQLite database for the whole `vitest run` (see test/setup.ts), and
// user_phone_numbers.phone is UNIQUE — so phone numbers need a prefix no other test file uses,
// not just uniqueness within this file. This file reuses "44700004", freed by the retired
// memoryReminders.test.ts (see importantEmailAlerts.test.ts's prefix registry comment).
function freshPhone(): string {
  counter += 1;
  return `44700004${String(counter).padStart(4, "0")}`;
}

// Registers a number and marks it as having just messaged us — sendProactiveMessage
// (services/outbound.ts) treats a number with no recorded inbound message as outside the
// customer-service window and reaches for a template instead of a free-form send, so tests that
// want to exercise the free-form send path (what these tests were written to check) need this.
function registerActivePhone(ownerId: number): string {
  const phone = freshPhone();
  addPhoneNumberForUser(ownerId, phone);
  recordInboundMessage(phone);
  return phone;
}

beforeEach(() => {
  vi.mocked(sendWhatsAppMessage).mockReset();
  vi.mocked(sendWhatsAppTemplate).mockReset();
  vi.mocked(isWhatsAppConfigured).mockReturnValue(true);
});

// Tests call runReminderCheckForOwner(user.id) directly rather than the exported
// reminderTickGuarded/startReminderScheduler (which loop over listAllUserIds) — the whole test
// run shares one SQLite database (see test/setup.ts), so a full tick would also process every
// user created by every other test file.
describe("runReminderCheckForOwner", () => {
  it("sends a due 'once' reminder and marks it done", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("reminder-once"));
    const phoneNumber = registerActivePhone(user.id);
    createReminder(user.id, { message: "Visa renewal is due", mode: "once", nextFireAt: Date.now() - 60_000 });

    await runReminderCheckForOwner(user.id);

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    const [phone, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(phone).toBe(phoneNumber);
    expect(text).toContain("Visa renewal is due");
    expect(listActiveRemindersForOwner(user.id)).toHaveLength(0);
  });

  it("does nothing when there are no due reminders", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("reminder-none"));
    registerActivePhone(user.id);

    await runReminderCheckForOwner(user.id);

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it("leaves a reminder due for retry if the send fails", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("reminder-fail"));
    registerActivePhone(user.id);
    createReminder(user.id, { message: "Important deadline", mode: "once", nextFireAt: Date.now() - 60_000 });
    vi.mocked(sendWhatsAppMessage).mockRejectedValueOnce(new Error("network error"));

    await runReminderCheckForOwner(user.id);

    expect(listActiveRemindersForOwner(user.id)).toHaveLength(1);
  });

  it("does nothing when WhatsApp isn't configured", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("reminder-unconfigured"));
    registerActivePhone(user.id);
    createReminder(user.id, { message: "Some reminder", mode: "once", nextFireAt: Date.now() - 60_000 });
    vi.mocked(isWhatsAppConfigured).mockReturnValue(false);

    await runReminderCheckForOwner(user.id);

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(listActiveRemindersForOwner(user.id)).toHaveLength(1);
  });

  it("does nothing when the user has no registered WhatsApp number", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("reminder-nophone"));
    createReminder(user.id, { message: "Some reminder", mode: "once", nextFireAt: Date.now() - 60_000 });

    await runReminderCheckForOwner(user.id);

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it("advances an 'interval' reminder to its next slot instead of finishing it", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("reminder-interval"));
    registerActivePhone(user.id);
    const now = Date.now();
    createReminder(user.id, {
      message: "Stretch",
      mode: "interval",
      nextFireAt: now - 1_000,
      intervalMs: 5 * 60_000,
      windowEndAt: now + 60 * 60_000,
    });

    await runReminderCheckForOwner(user.id);

    const [reminder] = listActiveRemindersForOwner(user.id);
    expect(reminder).toBeDefined();
    expect(reminder.nextFireAt).toBe(now - 1_000 + 5 * 60_000);
  });

  it("finishes an 'interval' reminder once the next slot would fall past the window end", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("reminder-interval-end"));
    registerActivePhone(user.id);
    const now = Date.now();
    createReminder(user.id, {
      message: "Stretch",
      mode: "interval",
      nextFireAt: now - 1_000,
      intervalMs: 5 * 60_000,
      windowEndAt: now + 1_000, // next slot (now - 1000 + 5min) is well past this
    });

    await runReminderCheckForOwner(user.id);

    expect(listActiveRemindersForOwner(user.id)).toHaveLength(0);
  });

  it("keeps advancing an 'until_reply' reminder indefinitely until cancelled", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("reminder-until-reply"));
    registerActivePhone(user.id);
    const now = Date.now();
    createReminder(user.id, { message: "Take your medicine", mode: "until_reply", nextFireAt: now - 1_000, intervalMs: 60_000 });

    await runReminderCheckForOwner(user.id);

    const [reminder] = listActiveRemindersForOwner(user.id);
    expect(reminder.status).toBe("active");
    expect(reminder.nextFireAt).toBe(now - 1_000 + 60_000);
  });

  describe("give-up notice", () => {
    it("gives up on an 'until_reply' reminder after 24h and notifies once", async () => {
      const user = findOrCreateUserByEmail(uniqueEmail("reminder-giveup"));
      const phoneNumber = registerActivePhone(user.id);

      // createReminder always stamps created_at = Date.now() — travel back 25h so the row is
      // actually created stale, then return to the real clock to run the check against it.
      // next_fire_at is set to a real future instant (26h past the faked "now") so this test
      // isolates the give-up path from the ordinary due-reminder send path.
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() - 25 * 60 * 60 * 1000);
      createReminder(user.id, {
        message: "Text Henry about the invoice",
        mode: "until_reply",
        nextFireAt: Date.now() + 26 * 60 * 60 * 1000,
        intervalMs: 60_000,
      });
      vi.useRealTimers();

      await runReminderCheckForOwner(user.id);

      expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
      const [phone, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
      expect(phone).toBe(phoneNumber);
      expect(text).toContain("Text Henry about the invoice");
      const [stillActive] = searchReminders(user.id, "Henry").filter((r) => r.status === "active");
      expect(stillActive).toBeUndefined();
    });
  });
});
