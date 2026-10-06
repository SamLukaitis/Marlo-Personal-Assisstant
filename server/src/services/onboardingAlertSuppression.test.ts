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
const { markOnboardingConnected, isOnboardingSuppressionActive } = await import("./onboardingAlertSuppression.js");
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

