import { describe, it, expect } from "vitest";
import { findOrCreateUserByEmail, setSetting } from "../db/store.js";
import {
  emailDigestTime,
  importantEmailAlertsEnabled,
  realPersonAlertMode,
  realPersonAlertsEnabled,
  realPersonAlertsEnabledSince,
  setEmailDigestTime,
  setImportantEmailAlertsEnabled,
  setRealPersonAlertMode,
  setRealPersonAlertsEnabled,
} from "./emailAlertSettings.js";

let counter = 0;
function newUser(prefix: string) {
  counter += 1;
  return findOrCreateUserByEmail(`${prefix}-${Date.now()}-${counter}@example.com`);
}

describe("email alert settings", () => {
  it("both kinds of email alert are on for a user who has never touched them", () => {
    const user = newUser("alerts-default");
    expect(realPersonAlertsEnabled(user.id)).toBe(true);
    expect(importantEmailAlertsEnabled(user.id)).toBe(true);
  });

  it("an explicit opt-out saved before the default flipped stays off", () => {
    const user = newUser("alerts-legacy-off");
    setSetting(user.id, "realtime_alerts_enabled", "false");
    expect(realPersonAlertsEnabled(user.id)).toBe(false);
  });

  it("the two switches are independent", () => {
    const user = newUser("alerts-independent");
    setRealPersonAlertsEnabled(user.id, false);
    expect(realPersonAlertsEnabled(user.id)).toBe(false);
    expect(importantEmailAlertsEnabled(user.id)).toBe(true);

    setImportantEmailAlertsEnabled(user.id, false);
    setRealPersonAlertsEnabled(user.id, true);
    expect(realPersonAlertsEnabled(user.id)).toBe(true);
    expect(importantEmailAlertsEnabled(user.id)).toBe(false);
  });

  it("real-person alerts are a 21:00 digest until the user opts into instant pings", () => {
    const user = newUser("alerts-mode-default");
    expect(realPersonAlertMode(user.id)).toBe("digest");
    expect(emailDigestTime(user.id)).toBe("21:00");
  });

  it("stores the mode and digest time, and the mode leaves the important-email switch alone", () => {
    const user = newUser("alerts-mode-set");
    setRealPersonAlertMode(user.id, "instant");
    setEmailDigestTime(user.id, "18:30");
    expect(realPersonAlertMode(user.id)).toBe("instant");
    expect(emailDigestTime(user.id)).toBe("18:30");
    expect(importantEmailAlertsEnabled(user.id)).toBe(true);

    setRealPersonAlertMode(user.id, "digest");
    expect(realPersonAlertMode(user.id)).toBe("digest");
  });

  it("rejects a digest time that isn't a 24h HH:MM", () => {
    const user = newUser("alerts-mode-badtime");
    expect(() => setEmailDigestTime(user.id, "9pm")).toThrow();
    expect(() => setEmailDigestTime(user.id, "24:00")).toThrow();
    expect(emailDigestTime(user.id)).toBe("21:00");
  });

  it("records when real-person alerts were switched on from off, not on a no-op re-enable", () => {
    const user = newUser("alerts-enabled-at");
    expect(realPersonAlertsEnabledSince(user.id)).toBe(0);

    setRealPersonAlertsEnabled(user.id, true); // already on by default — nothing to record
    expect(realPersonAlertsEnabledSince(user.id)).toBe(0);

    setRealPersonAlertsEnabled(user.id, false);
    const before = Date.now();
    setRealPersonAlertsEnabled(user.id, true);
    expect(realPersonAlertsEnabledSince(user.id)).toBeGreaterThanOrEqual(before);
  });
});
