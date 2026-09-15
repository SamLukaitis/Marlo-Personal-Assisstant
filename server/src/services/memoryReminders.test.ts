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
  addMemoryNote,
  listDueMemoryReminders,
  listMemoryRemindersToGiveUpOn,
  searchReminderNotes,
} = await import("../db/store.js");
const { checkDueMemoryReminders } = await import("./memoryReminders.js");

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

// All test files share one SQLite database for the whole `vitest run` (see test/setup.ts), and
// user_phone_numbers.phone is UNIQUE — so phone numbers need a prefix no other test file uses,
// not just uniqueness within this file. Existing files already claim "44700000" and "44700001"
// (see pendingRegistration.test.ts / whatsappRegistration.test.ts) — this file uses "44700004".
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

describe("checkDueMemoryReminders", () => {
  it("sends a WhatsApp message for a due reminder and marks it surfaced", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("reminder-due"));
    const phoneNumber = registerActivePhone(user.id);
    const past = new Date(Date.now() - 60_000).toISOString();
    addMemoryNote(user.id, "Visa renewal is due", past);

    await checkDueMemoryReminders(user.id);

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    const [phone, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(phone).toBe(phoneNumber);
    expect(text).toContain("Visa renewal is due");
    expect(listDueMemoryReminders(user.id, Date.now())).toHaveLength(0);
  });

  it("does nothing when there are no due reminders", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("reminder-none"));
    registerActivePhone(user.id);

    await checkDueMemoryReminders(user.id);

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it("does not mark a reminder surfaced if the send fails, so it retries next tick", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("reminder-fail"));
    registerActivePhone(user.id);
    const past = new Date(Date.now() - 60_000).toISOString();
    addMemoryNote(user.id, "Important deadline", past);
    vi.mocked(sendWhatsAppMessage).mockRejectedValueOnce(new Error("network error"));

    await checkDueMemoryReminders(user.id);

    expect(listDueMemoryReminders(user.id, Date.now())).toHaveLength(1);
  });

  it("on retry after a partial failure, only resends to the number that missed it", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("reminder-partial"));
    registerActivePhone(user.id);
    const second = registerActivePhone(user.id);
    addMemoryNote(user.id, "Call the bank", new Date(Date.now() - 60_000).toISOString());
    vi.mocked(sendWhatsAppMessage).mockImplementation(async (to: string) => {
      if (to === second) throw new Error("network error");
    });

    await checkDueMemoryReminders(user.id);
    expect(listDueMemoryReminders(user.id, Date.now())).toHaveLength(1);

    vi.mocked(sendWhatsAppMessage).mockReset().mockResolvedValue(undefined);
    await checkDueMemoryReminders(user.id);

    expect(vi.mocked(sendWhatsAppMessage).mock.calls.map((c) => c[0])).toEqual([second]);
    expect(listDueMemoryReminders(user.id, Date.now())).toHaveLength(0);
  });

  it("does nothing when WhatsApp isn't configured", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("reminder-unconfigured"));
    registerActivePhone(user.id);
    const past = new Date(Date.now() - 60_000).toISOString();
    addMemoryNote(user.id, "Some reminder", past);
    vi.mocked(isWhatsAppConfigured).mockReturnValue(false);

    await checkDueMemoryReminders(user.id);

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(listDueMemoryReminders(user.id, Date.now())).toHaveLength(1);
  });

  it("does nothing when the user has no registered WhatsApp number", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("reminder-nophone"));
    const past = new Date(Date.now() - 60_000).toISOString();
    addMemoryNote(user.id, "Some reminder", past);

    await checkDueMemoryReminders(user.id);

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  describe("give-up notice", () => {
    it("notifies the user and marks the reminder given up once it crosses the 24h window unsent", async () => {
      const user = findOrCreateUserByEmail(uniqueEmail("reminder-giveup"));
      const phoneNumber = registerActivePhone(user.id);
      const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      addMemoryNote(user.id, "Text Henry about the invoice", stale);

      await checkDueMemoryReminders(user.id);

      expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
      const [phone, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
      expect(phone).toBe(phoneNumber);
      expect(text).toContain("Text Henry about the invoice");
      expect(listMemoryRemindersToGiveUpOn(user.id, Date.now())).toHaveLength(0);
      const [note] = searchReminderNotes(user.id, "Henry");
      expect(note.gaveUpAt).not.toBeNull();
    });

    it("does not send a give-up notice for a reminder still inside the window", async () => {
      const user = findOrCreateUserByEmail(uniqueEmail("reminder-giveup-notyet"));
      registerActivePhone(user.id);
      const past = new Date(Date.now() - 60_000).toISOString();
      addMemoryNote(user.id, "Recently due reminder", past);

      await checkDueMemoryReminders(user.id);

      // Only the ordinary due-reminder send, not a second give-up notice.
      expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    });

    it("does not re-send a give-up notice on a later tick", async () => {
      const user = findOrCreateUserByEmail(uniqueEmail("reminder-giveup-once"));
      registerActivePhone(user.id);
      const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      addMemoryNote(user.id, "Stuck reminder", stale);

      await checkDueMemoryReminders(user.id);
      await checkDueMemoryReminders(user.id);

      expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    });

    it("still marks the reminder given up even if the give-up notice itself fails to send", async () => {
      const user = findOrCreateUserByEmail(uniqueEmail("reminder-giveup-notice-fails"));
      registerActivePhone(user.id);
      const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      addMemoryNote(user.id, "Unreachable reminder", stale);
      vi.mocked(sendWhatsAppMessage).mockRejectedValueOnce(new Error("network error"));

      await checkDueMemoryReminders(user.id);

      expect(listMemoryRemindersToGiveUpOn(user.id, Date.now())).toHaveLength(0);
    });
  });
});
