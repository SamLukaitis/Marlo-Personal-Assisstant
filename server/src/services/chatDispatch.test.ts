import { describe, it, expect, vi } from "vitest";

vi.mock("./messageBatching.js", () => ({
  queueForAssistant: vi.fn(),
  looksComplete: vi.fn(),
}));

const { findOrCreateUserByEmail, addPhoneNumberForUser, getWhatsAppHistory } = await import("../db/store.js");
const { getUserTimezone } = await import("./userTimezone.js");
const { handleLocation } = await import("./chatDispatch.js");

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

// All test files share one SQLite database for the whole `vitest run` (see test/setup.ts), and
// user_phone_numbers.phone is UNIQUE — this file uses "44700008", the next unclaimed prefix (see
// importantEmailAlerts.test.ts's prefix registry comment).
function freshPhone(): string {
  counter += 1;
  return `44700008${String(counter).padStart(4, "0")}`;
}

describe("handleLocation", () => {
  it("resolves and stores the user's timezone from the shared coordinates, with no travel tool needed", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("location-tz"));
    const phone = freshPhone();
    addPhoneNumberForUser(user.id, phone);

    await handleLocation(user.id, phone, 51.5074, -0.1278, "wamid.1"); // central London

    expect(getUserTimezone(user.id)).toBe("Europe/London");
  });

  it("overwrites a previously known timezone — the most recent shared location wins", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("location-tz-overwrite"));
    const phone = freshPhone();
    addPhoneNumberForUser(user.id, phone);

    await handleLocation(user.id, phone, 51.5074, -0.1278, "wamid.1"); // London
    await handleLocation(user.id, phone, 40.7128, -74.006, "wamid.2"); // New York

    expect(getUserTimezone(user.id)).toBe("America/New_York");
  });

  it("still records the location in chat history alongside setting the timezone", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("location-history"));
    const phone = freshPhone();
    addPhoneNumberForUser(user.id, phone);

    await handleLocation(user.id, phone, 51.5074, -0.1278, "wamid.1", "Home");

    const [last] = getWhatsAppHistory(phone, 1);
    expect(last.content).toContain("51.5074");
    expect(last.content).toContain("Home");
  });
});
