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

const { sendWhatsAppMessage, isWhatsAppConfigured } = await import("../providers/whatsapp.js");
const {
  incrementSuppressedOnboardingAlerts,
  takeSuppressedOnboardingAlertCount,
  markOnboardingConnected,
  isOnboardingSuppressionActive,
  flushOnboardingAlertSummaryIfDue,
} = await import("./onboardingAlertSuppression.js");
const { findOrCreateUserByEmail, setPendingSetup, addPhoneNumberForUser, recordInboundMessage } = await import(
  "../db/store.js"
);

let counter = 0;
function newOwnerId(): number {
  counter += 1;
  return findOrCreateUserByEmail(`onboarding-suppression-${Date.now()}-${counter}@example.com`).id;
}

// See importantEmailAlerts.test.ts's own comment on phone number prefixes shared across test
// files — this file uses "44700007".
function registerActivePhone(ownerId: number): string {
  counter += 1;
  const phone = `44700007${String(counter).padStart(4, "0")}`;
  addPhoneNumberForUser(ownerId, phone);
  recordInboundMessage(phone);
  return phone;
}

beforeEach(() => {
  vi.mocked(sendWhatsAppMessage).mockReset();
  vi.mocked(isWhatsAppConfigured).mockReset().mockReturnValue(true);
});

describe("onboarding alert suppression counter", () => {
  it("starts at zero for a fresh owner", () => {
    const ownerId = newOwnerId();
    expect(takeSuppressedOnboardingAlertCount(ownerId)).toBe(0);
  });

  it("accumulates increments from multiple scanners", () => {
    const ownerId = newOwnerId();
    incrementSuppressedOnboardingAlerts(ownerId, 2);
    incrementSuppressedOnboardingAlerts(ownerId); // default by=1
    incrementSuppressedOnboardingAlerts(ownerId, 3);

    expect(takeSuppressedOnboardingAlertCount(ownerId)).toBe(6);
  });

  it("resets to zero after being read", () => {
    const ownerId = newOwnerId();
    incrementSuppressedOnboardingAlerts(ownerId, 4);

    expect(takeSuppressedOnboardingAlertCount(ownerId)).toBe(4);
    expect(takeSuppressedOnboardingAlertCount(ownerId)).toBe(0);
  });

  it("ignores a non-positive increment", () => {
    const ownerId = newOwnerId();
    incrementSuppressedOnboardingAlerts(ownerId, 0);
    incrementSuppressedOnboardingAlerts(ownerId, -1);

    expect(takeSuppressedOnboardingAlertCount(ownerId)).toBe(0);
  });
});

describe("isOnboardingSuppressionActive", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is false for an owner who never connected and has no pending setup", () => {
    const ownerId = newOwnerId();
    expect(isOnboardingSuppressionActive(ownerId)).toBe(false);
  });

  it("is true while pending setup is non-null, regardless of connection time", () => {
    const ownerId = newOwnerId();
    setPendingSetup(ownerId, "ask_briefing");
    expect(isOnboardingSuppressionActive(ownerId)).toBe(true);
  });

  // The actual regression: onboarding's own question chain typically finishes in well under a
  // minute, clearing pending_setup — but scheduler.ts's checks run on a global 5-minute tick
  // unrelated to that moment, so suppression must survive on connection-recency alone.
  it("stays true for a while after markOnboardingConnected even once pending setup is cleared", () => {
    vi.useFakeTimers();
    const ownerId = newOwnerId();

    markOnboardingConnected(ownerId);
    vi.advanceTimersByTime(4 * 60 * 1000); // 4 minutes — comfortably inside one scheduler tick

    expect(isOnboardingSuppressionActive(ownerId)).toBe(true);
  });

  it("lapses once the connection grace period has elapsed", () => {
    vi.useFakeTimers();
    const ownerId = newOwnerId();

    markOnboardingConnected(ownerId);
    vi.advanceTimersByTime(11 * 60 * 1000); // past the 10-minute grace period

    expect(isOnboardingSuppressionActive(ownerId)).toBe(false);
  });
});

describe("flushOnboardingAlertSummaryIfDue", () => {
  it("does nothing while suppression is still active", async () => {
    const ownerId = newOwnerId();
    registerActivePhone(ownerId);
    setPendingSetup(ownerId, "ask_briefing");
    incrementSuppressedOnboardingAlerts(ownerId, 2);

    await flushOnboardingAlertSummaryIfDue(ownerId);

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(takeSuppressedOnboardingAlertCount(ownerId)).toBe(2); // left untouched
  });

  it("does nothing when suppression has lapsed but nothing was suppressed", async () => {
    const ownerId = newOwnerId();
    registerActivePhone(ownerId);

    await flushOnboardingAlertSummaryIfDue(ownerId);

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it("sends a one-line summary and resets the count once suppression has lapsed", async () => {
    const ownerId = newOwnerId();
    const phone = registerActivePhone(ownerId);
    incrementSuppressedOnboardingAlerts(ownerId, 3);

    await flushOnboardingAlertSummaryIfDue(ownerId);

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    const [sentTo, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(sentTo).toBe(phone);
    expect(text).toContain("3");
    expect(takeSuppressedOnboardingAlertCount(ownerId)).toBe(0);
  });

  it("is naturally idempotent — a later tick with nothing new to report stays silent", async () => {
    const ownerId = newOwnerId();
    registerActivePhone(ownerId);
    incrementSuppressedOnboardingAlerts(ownerId, 3);

    await flushOnboardingAlertSummaryIfDue(ownerId);
    await flushOnboardingAlertSummaryIfDue(ownerId);

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
  });

  it("does not send (or consume the count) when WhatsApp isn't configured", async () => {
    const ownerId = newOwnerId();
    registerActivePhone(ownerId);
    incrementSuppressedOnboardingAlerts(ownerId, 1);
    vi.mocked(isWhatsAppConfigured).mockReturnValue(false);

    await flushOnboardingAlertSummaryIfDue(ownerId);

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(takeSuppressedOnboardingAlertCount(ownerId)).toBe(1);
  });

  it("does not send (or consume the count) when the owner has no registered phone numbers", async () => {
    const ownerId = newOwnerId();
    incrementSuppressedOnboardingAlerts(ownerId, 1);

    await flushOnboardingAlertSummaryIfDue(ownerId);

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(takeSuppressedOnboardingAlertCount(ownerId)).toBe(1);
  });
});
