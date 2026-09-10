import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./briefing.js", () => ({
  getBriefingSettings: vi.fn(() => ({ proactive: false, sendTime: "00:00" })),
  getTodaysBriefing: vi.fn(),
}));

vi.mock("../db/store.js", () => ({
  getSetting: vi.fn((_ownerId: number, key: string) =>
    key === "important_email_alerts_enabled" ? "false" : undefined
  ),
  setSetting: vi.fn(),
  listPhoneNumbersForUser: vi.fn(() => []),
  listAllCheckinsAscending: vi.fn(() => []),
  listAllUserIds: vi.fn(() => [1]),
  getEnabledTools: vi.fn(() => new Set()),
  deleteExpiredPendingActions: vi.fn(),
  deleteExpiredSeenWamids: vi.fn(),
  pruneOldServerLogs: vi.fn(),
}));

vi.mock("../providers/whatsapp.js", () => ({
  isWhatsAppConfigured: vi.fn(() => false),
}));

vi.mock("./outbound.js", () => ({
  sendProactiveMessage: vi.fn(),
}));

vi.mock("./travelDays.js", () => ({
  countTravelDays: vi.fn(),
}));

vi.mock("./alerts.js", () => ({
  checkForNewImportantMessages: vi.fn(),
}));

vi.mock("./reconciliation.js", () => ({
  checkNewEmailsAgainstRecentDocuments: vi.fn(() => Promise.resolve()),
}));

vi.mock("./importantEmailAlerts.js", () => ({
  checkForImportantEmails: vi.fn(),
}));

// Resolved from inside a test once it wants tick() to finish its (otherwise indefinitely
// pending) call to checkDueMemoryReminders — this is what lets a test hold one tick "in flight"
// long enough to prove a second call is skipped rather than run concurrently.
let releaseMemoryReminderCheck: () => void = () => {};
vi.mock("./memoryReminders.js", () => ({
  checkDueMemoryReminders: vi.fn(
    () =>
      new Promise<void>((resolve) => {
        releaseMemoryReminderCheck = resolve;
      })
  ),
}));

const { listAllUserIds } = await import("../db/store.js");
const { checkDueMemoryReminders } = await import("./memoryReminders.js");
const { tickGuarded } = await import("./scheduler.js");

beforeEach(() => {
  vi.mocked(listAllUserIds).mockClear();
  vi.mocked(checkDueMemoryReminders).mockClear();
});

describe("tickGuarded", () => {
  it("skips a new cycle while the previous one is still in flight", async () => {
    const first = tickGuarded();
    await vi.waitFor(() => expect(checkDueMemoryReminders).toHaveBeenCalledTimes(1));

    // A second call arriving mid-cycle (e.g. the next setInterval firing before a slow pass
    // over every tenant finishes) must not start a second, overlapping pass.
    await tickGuarded();
    expect(listAllUserIds).toHaveBeenCalledTimes(1);

    releaseMemoryReminderCheck();
    await first;
  });

  it("runs a fresh cycle once the previous one has finished", async () => {
    const first = tickGuarded();
    await vi.waitFor(() => expect(checkDueMemoryReminders).toHaveBeenCalledTimes(1));
    releaseMemoryReminderCheck();
    await first;

    const second = tickGuarded();
    await vi.waitFor(() => expect(checkDueMemoryReminders).toHaveBeenCalledTimes(2));
    expect(listAllUserIds).toHaveBeenCalledTimes(2);

    releaseMemoryReminderCheck();
    await second;
  });
});
