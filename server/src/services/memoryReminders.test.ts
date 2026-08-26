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
});
