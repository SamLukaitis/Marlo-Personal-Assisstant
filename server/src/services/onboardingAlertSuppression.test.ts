import { describe, it, expect } from "vitest";
import { incrementSuppressedOnboardingAlerts, takeSuppressedOnboardingAlertCount } from "./onboardingAlertSuppression.js";
import { findOrCreateUserByEmail } from "../db/store.js";

let counter = 0;
function newOwnerId(): number {
  counter += 1;
  return findOrCreateUserByEmail(`onboarding-suppression-${Date.now()}-${counter}@example.com`).id;
}

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
