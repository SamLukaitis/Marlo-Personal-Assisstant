import { describe, it, expect } from "vitest";
import { findOrCreateUserByEmail, setSetting } from "../db/store.js";
import {
  importantEmailAlertsEnabled,
  realPersonAlertsEnabled,
  setImportantEmailAlertsEnabled,
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
});
