// server/src/services/alerts.test.ts
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

const mockHubListNewMessages = vi.fn();
vi.mock("./hub.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./hub.js")>();
  return { ...actual, hubListNewMessages: (...args: unknown[]) => mockHubListNewMessages(...args) };
});

const { sendWhatsAppMessage, isWhatsAppConfigured } = await import("../providers/whatsapp.js");
const { findOrCreateUserByEmail, addPhoneNumberForUser, recordInboundMessage, hasAlerted } = await import(
  "../db/store.js"
);
const { checkForNewImportantMessages } = await import("./alerts.js");

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

// See importantEmailAlerts.test.ts's own comment on phone number prefixes shared across test
// files — this file uses "44700006".
function freshPhone(): string {
  counter += 1;
  return `44700006${String(counter).padStart(4, "0")}`;
}

function registerActivePhone(ownerId: number): string {
  const phone = freshPhone();
  addPhoneNumberForUser(ownerId, phone);
  recordInboundMessage(phone);
  return phone;
}

function fakeMessage(
  overrides: Partial<{ id: string; accountId: number; subject: string; snippet: string; from: string; unread: boolean }>
) {
  return {
    id: "msg-1",
    accountId: 1,
    accountEmail: "test@example.com",
    provider: "google" as const,
    subject: "Subject",
    from: "jane@example.com",
    snippet: "snippet",
    receivedAt: new Date().toISOString(),
    unread: true,
    ...overrides,
  };
}

async function baseline(ownerId: number) {
  mockHubListNewMessages.mockResolvedValueOnce([]);
  await checkForNewImportantMessages(ownerId);
}

beforeEach(() => {
  vi.mocked(sendWhatsAppMessage).mockReset();
  vi.mocked(isWhatsAppConfigured).mockReset().mockReturnValue(true);
  mockHubListNewMessages.mockReset();
});

describe("checkForNewImportantMessages", () => {
  it("baselines the existing inbox on first run without notifying", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("alerts-baseline"));
    mockHubListNewMessages.mockResolvedValueOnce([fakeMessage({ id: "old-1" })]);

    await checkForNewImportantMessages(user.id);

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(hasAlerted(user.id, "1:old-1")).toBe(true);
  });

  // The actual bug fix: a user who opens a real person's email the moment it arrives (entirely
  // normal) must not lose the alert. hasAlerted's per-message ledger is the real "already
  // handled" check, independent of read status — unread was a redundant, strictly worse
  // substitute that silently and permanently dropped a message read before this scan ever saw it.
  it("notifies for a real person's message regardless of whether it's already been read", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("alerts-read-status"));
    const phone = registerActivePhone(user.id);
    await baseline(user.id);

    mockHubListNewMessages.mockResolvedValueOnce([
      fakeMessage({ id: "already-read", unread: false, from: "jane@example.com", subject: "Already read" }),
    ]);

    await checkForNewImportantMessages(user.id);

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    const [sentTo, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(sentTo).toBe(phone);
    expect(text).toContain("Already read");
  });

  it("ignores automated-sender mail regardless of read status", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("alerts-automated"));
    registerActivePhone(user.id);
    await baseline(user.id);

    mockHubListNewMessages.mockResolvedValueOnce([
      fakeMessage({ id: "automated-1", from: "no-reply@delta.com" }),
    ]);

    await checkForNewImportantMessages(user.id);

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it("does not re-notify for the same message on a later tick", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("alerts-dedup"));
    registerActivePhone(user.id);
    await baseline(user.id);

    mockHubListNewMessages.mockResolvedValue([fakeMessage({ id: "msg-2" })]);

    await checkForNewImportantMessages(user.id);
    await checkForNewImportantMessages(user.id);

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
  });
});
