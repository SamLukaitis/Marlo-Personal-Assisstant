import { describe, it, expect } from "vitest";
import {
  findOrCreateUserByEmail,
  setPendingSetup,
  clearPendingSetup,
  getOnboardingStepEvents,
} from "./store.js";

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

describe("onboarding_step_events", () => {
  it("logs a 'reached' event every time a step becomes pending", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("step-events-reached"));

    setPendingSetup(user.id, "ask_name");
    setPendingSetup(user.id, "ask_first_task");

    const events = getOnboardingStepEvents(user.id);
    expect(events.map((e) => ({ step: e.step, event: e.event }))).toEqual([
      { step: "ask_name", event: "reached" },
      { step: "ask_first_task", event: "reached" },
    ]);
  });

  it("logs a 'completed' event when the chain finishes", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("step-events-completed"));
    setPendingSetup(user.id, "ask_teams");

    clearPendingSetup(user.id);

    const events = getOnboardingStepEvents(user.id);
    expect(events[events.length - 1]).toMatchObject({ step: "ask_teams", event: "completed" });
  });

  it("keeps events scoped to their own owner", () => {
    const a = findOrCreateUserByEmail(uniqueEmail("step-events-owner-a"));
    const b = findOrCreateUserByEmail(uniqueEmail("step-events-owner-b"));

    setPendingSetup(a.id, "ask_name");
    setPendingSetup(b.id, "ask_briefing");

    expect(getOnboardingStepEvents(a.id).map((e) => e.step)).toEqual(["ask_name"]);
    expect(getOnboardingStepEvents(b.id).map((e) => e.step)).toEqual(["ask_briefing"]);
  });

  it("returns events ordered oldest first, each with a createdAt timestamp", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("step-events-order"));
    setPendingSetup(user.id, "ask_name");
    setPendingSetup(user.id, "ask_briefing");

    const events = getOnboardingStepEvents(user.id);
    expect(events).toHaveLength(2);
    expect(events[0].createdAt).toBeLessThanOrEqual(events[1].createdAt);
    expect(typeof events[0].createdAt).toBe("number");
  });
});
