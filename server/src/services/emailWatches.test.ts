import { describe, it, expect } from "vitest";
import { findOrCreateUserByEmail } from "../db/store.js";
import {
  addEmailWatch,
  hasEmailWatches,
  keepEmailWatch,
  listEmailWatches,
  recordWatchAlert,
  removeEmailWatch,
  watchAlertSummary,
} from "./emailWatches.js";

let counter = 0;
function freshUser(prefix: string) {
  counter += 1;
  return findOrCreateUserByEmail(`${prefix}-${Date.now()}-${counter}@example.com`);
}

describe("email watches", () => {
  it("adds and removes a watch", () => {
    const user = freshUser("watch-add");
    expect(hasEmailWatches(user.id)).toBe(false);
    expect(addEmailWatch(user.id, { label: "  ", topic: "x" })).toBeNull();
    const watch = addEmailWatch(user.id, { label: "Jazz Fest tickets", topic: "Jazz Fest ticket sales" })!;
    expect(listEmailWatches(user.id)).toEqual([watch]);
    expect(hasEmailWatches(user.id)).toBe(true);
    expect(removeEmailWatch(user.id, watch.id)).toEqual(watch);
    expect(listEmailWatches(user.id)).toEqual([]);
  });

  it("asks to check in on every third alert, and keep resets the count", () => {
    const user = freshUser("watch-checkin");
    const watch = addEmailWatch(user.id, { label: "Jazz Fest tickets", topic: "Jazz Fest" })!;
    expect([1, 2, 3, 4, 5, 6].map(() => recordWatchAlert(user.id, watch.id))).toEqual([
      false, false, true, false, false, true,
    ]);
    keepEmailWatch(user.id, watch.id);
    expect([1, 2, 3].map(() => recordWatchAlert(user.id, watch.id))).toEqual([false, false, true]);
    expect(recordWatchAlert(user.id, "missing")).toBe(false);
  });

  it("writes the alert with a bold label and an optional check-in", () => {
    const watch = { id: "a", label: "Jazz Fest tickets", topic: "t", createdAt: 0, alertCount: 0 };
    expect(watchAlertSummary(watch, "Presale opens *Friday*", false)).toBe("*Jazz Fest tickets*: Presale opens *Friday*.");
    expect(watchAlertSummary(watch, "Presale opens *Friday*.", true)).toBe(
      "*Jazz Fest tickets*: Presale opens *Friday*. Still want me flagging Jazz Fest tickets emails?"
    );
  });
});
