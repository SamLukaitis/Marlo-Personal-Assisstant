import { describe, it, expect } from "vitest";
import {
  getPendingRegistration,
  upsertPendingRegistration,
  setPendingRegistrationToken,
  peekPendingRegistrationByToken,
  consumePendingRegistrationToken,
  completePendingRegistration,
  deletePendingRegistration,
} from "../db/store.js";

// A fresh phone per test avoids cross-test interference (setup.ts gives each test *file* run a
// shared temp DB, not a per-test one, since store.ts's DB connection is a module-level singleton).
let counter = 0;
function freshPhone(): string {
  counter += 1;
  return `44700000${String(counter).padStart(4, "0")}`;
}

describe("pending WhatsApp registrations", () => {
  it("creates then advances a row through upsertPendingRegistration", () => {
    const phone = freshPhone();
    expect(getPendingRegistration(phone)).toBeNull();

    const created = upsertPendingRegistration(phone, { step: "awaiting_name" });
    expect(created.step).toBe("awaiting_name");
    expect(created.name).toBeNull();

    const named = upsertPendingRegistration(phone, { step: "awaiting_email", name: "Margaret" });
    expect(named.step).toBe("awaiting_email");
    expect(named.name).toBe("Margaret");
    // Patch is partial — fields not mentioned stay as they were.
    expect(named.typedEmail).toBeNull();
  });

  it("issues a token that can be peeked without consuming it", () => {
    const phone = freshPhone();
    upsertPendingRegistration(phone, { step: "awaiting_email", typedEmail: "margaret@example.com" });
    const token = setPendingRegistrationToken(phone);

    const peeked = peekPendingRegistrationByToken(token);
    expect(peeked?.phone).toBe(phone);
    expect(peeked?.typedEmail).toBe("margaret@example.com");

    // Peeking again still works — it must not consume the token.
    expect(peekPendingRegistrationByToken(token)?.phone).toBe(phone);
  });

  it("consumes a token exactly once", () => {
    const phone = freshPhone();
    upsertPendingRegistration(phone, { step: "awaiting_email" });
    const token = setPendingRegistrationToken(phone);

    const first = consumePendingRegistrationToken(token);
    expect(first?.phone).toBe(phone);

    const second = consumePendingRegistrationToken(token);
    expect(second).toBeNull();

    // And peeking after consumption also fails — the hash was cleared, not just "marked used".
    expect(peekPendingRegistrationByToken(token)).toBeNull();
  });

  it("rejects an unknown token", () => {
    expect(consumePendingRegistrationToken("not-a-real-token")).toBeNull();
    expect(peekPendingRegistrationByToken("not-a-real-token")).toBeNull();
  });

  it("rejects an expired token", () => {
    const phone = freshPhone();
    upsertPendingRegistration(phone, { step: "awaiting_email" });
    // Negative TTL == already expired the instant it's issued — avoids waiting on a real clock.
    const token = setPendingRegistrationToken(phone, -1000);

    expect(peekPendingRegistrationByToken(token)).toBeNull();
    expect(consumePendingRegistrationToken(token)).toBeNull();
  });

  it("marks a registration completed and supports a hard reset", () => {
    const phone = freshPhone();
    upsertPendingRegistration(phone, { step: "awaiting_briefing_time" });
    completePendingRegistration(phone);
    expect(getPendingRegistration(phone)?.step).toBe("completed");

    deletePendingRegistration(phone);
    expect(getPendingRegistration(phone)).toBeNull();
  });
});
