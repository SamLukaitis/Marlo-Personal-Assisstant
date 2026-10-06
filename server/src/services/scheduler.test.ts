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

// Resolved from inside a test once it wants tick() to finish its (otherwise indefinitely
// pending) call to checkNewEmailsAgainstRecentDocuments — this is what lets a test hold one tick
// "in flight" long enough to prove a second call is skipped rather than run concurrently.
let releaseReconciliationCheck: () => void = () => {};
vi.mock("./reconciliation.js", () => ({
  checkNewEmailsAgainstRecentDocuments: vi.fn(
    () =>
      new Promise<void>((resolve) => {
        releaseReconciliationCheck = resolve;
      })
  ),
}));

vi.mock("./importantEmailAlerts.js", () => ({
  checkForImportantEmails: vi.fn(),
}));

vi.mock("./emailDigest.js", () => ({
  flushEmailDigestIfDue: vi.fn(() => Promise.resolve()),
}));

vi.mock("./attention.js", () => ({
  collectAttentionForBriefing: vi.fn(() => ({ noted: [], needsAttention: [], upcoming: [], ackIds: [], foldIds: [] })),
  commitAttentionBundle: vi.fn(),
  deliverDueAttentionItems: vi.fn(() => Promise.resolve()),
}));


const { listAllUserIds } = await import("../db/store.js");
const { checkNewEmailsAgainstRecentDocuments } = await import("./reconciliation.js");
const { deliverDueAttentionItems } = await import("./attention.js");
const { checkForNewImportantMessages } = await import("./alerts.js");
const { tickGuarded } = await import("./scheduler.js");

beforeEach(() => {
  vi.mocked(listAllUserIds).mockClear();
  vi.mocked(checkNewEmailsAgainstRecentDocuments).mockClear();
  vi.mocked(deliverDueAttentionItems).mockClear();
});

describe("tickGuarded", () => {
  it("delivers due attention items for every tenant after the mail scans", async () => {
    const first = tickGuarded();
    await vi.waitFor(() => expect(checkNewEmailsAgainstRecentDocuments).toHaveBeenCalledTimes(1));
    expect(deliverDueAttentionItems).not.toHaveBeenCalled();
    releaseReconciliationCheck();
    await first;
    expect(deliverDueAttentionItems).toHaveBeenCalledWith(1);
  });

  it("skips a new cycle while the previous one is still in flight", async () => {
    const first = tickGuarded();
    await vi.waitFor(() => expect(checkNewEmailsAgainstRecentDocuments).toHaveBeenCalledTimes(1));

    // A second call arriving mid-cycle (e.g. the next setInterval firing before a slow pass
    // over every tenant finishes) must not start a second, overlapping pass.
    await tickGuarded();
    expect(listAllUserIds).toHaveBeenCalledTimes(1);

    releaseReconciliationCheck();
    await first;
  });

  it("runs a fresh cycle once the previous one has finished", async () => {
    const first = tickGuarded();
    await vi.waitFor(() => expect(checkNewEmailsAgainstRecentDocuments).toHaveBeenCalledTimes(1));
    releaseReconciliationCheck();
    await first;

    const second = tickGuarded();
    await vi.waitFor(() => expect(checkNewEmailsAgainstRecentDocuments).toHaveBeenCalledTimes(2));
    expect(listAllUserIds).toHaveBeenCalledTimes(2);

    releaseReconciliationCheck();
    await second;
  });

  // Alert scans log nothing on a quiet tick, so without this line "is the scheduler even running,
  // and is this user's real-person toggle on" can't be answered from the logs.
  it("logs one summary line per tick with how many tenants it covered and how many have real-person alerts off", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const first = tickGuarded();
      await vi.waitFor(() => expect(checkNewEmailsAgainstRecentDocuments).toHaveBeenCalledTimes(1));
      releaseReconciliationCheck();
      await first;

      const lines = logSpy.mock.calls.map((c) => c.join(" ")).filter((l) => l.startsWith("scheduler: tick"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/1 user.*real-person alerts off for 0/);
    } finally {
      logSpy.mockRestore();
    }
  });


  // Real-person alerts are on by default now — a tenant who never touched the setting (the mocked
  // getSetting returns undefined for it) must still be checked.
  it("runs the real-person alert check for a tenant who never set it", async () => {
    vi.mocked(checkForNewImportantMessages).mockClear();
    const first = tickGuarded();
    await vi.waitFor(() => expect(checkNewEmailsAgainstRecentDocuments).toHaveBeenCalledTimes(1));
    releaseReconciliationCheck();
    await first;

    expect(checkForNewImportantMessages).toHaveBeenCalledWith(1);
  });
});
