import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../providers/whatsapp.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../providers/whatsapp.js")>();
  return {
    ...actual, // keeps the real WhatsAppSendError class — outbound.ts's `instanceof` check needs it
    sendWhatsAppMessage: vi.fn(),
    sendWhatsAppTemplate: vi.fn(),
    isWhatsAppConfigured: vi.fn().mockReturnValue(true),
  };
});

const { sendWhatsAppMessage, sendWhatsAppTemplate, isWhatsAppConfigured } = await import("../providers/whatsapp.js");
const { findOrCreateUserByEmail, addPhoneNumberForUser, recordInboundMessage, saveEntity, getEntity } = await import(
  "../db/store.js"
);
const { checkTripPrepNudges, isTripPrepDue } = await import("./tripPrep.js");
import type { BookingData } from "./entityValidation.js";

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

// See reminderScheduler.test.ts for why the prefix must be file-unique across the whole test run
// (user_phone_numbers.phone is UNIQUE). "44700007" is unclaimed as of this file's creation.
function registerActivePhone(ownerId: number): string {
  counter += 1;
  const phone = `447000070${String(counter).padStart(3, "0")}`;
  addPhoneNumberForUser(ownerId, phone);
  recordInboundMessage(phone);
  return phone;
}

function todayKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function dateKeyPlusDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function booking(overrides: Partial<BookingData>): BookingData {
  return {
    kind: "flight",
    name: "FR1234 LIS→FAO",
    reference: null,
    startDate: dateKeyPlusDays(1),
    endDate: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(sendWhatsAppMessage).mockReset();
  vi.mocked(sendWhatsAppTemplate).mockReset();
  vi.mocked(isWhatsAppConfigured).mockReturnValue(true);
});

describe("isTripPrepDue", () => {
  const today = todayKey();
  const tomorrow = dateKeyPlusDays(1);

  it("flight is due the day before departure", () => {
    expect(isTripPrepDue(booking({ kind: "flight", startDate: tomorrow }), today, tomorrow)).toBe(true);
  });

  it("flight catches up same-day if not yet notified", () => {
    expect(isTripPrepDue(booking({ kind: "flight", startDate: today }), today, tomorrow)).toBe(true);
  });

  it("flight is not due more than a day out", () => {
    expect(isTripPrepDue(booking({ kind: "flight", startDate: dateKeyPlusDays(2) }), today, tomorrow)).toBe(false);
  });

  it("flight already notified is never due again", () => {
    expect(
      isTripPrepDue(booking({ kind: "flight", startDate: tomorrow, tripPrepNotifiedAt: Date.now() }), today, tomorrow)
    ).toBe(false);
  });

  it("hotel is due on check-in day", () => {
    expect(isTripPrepDue(booking({ kind: "hotel", startDate: today }), today, tomorrow)).toBe(true);
  });

  it("hotel is not due the day before check-in", () => {
    expect(isTripPrepDue(booking({ kind: "hotel", startDate: tomorrow }), today, tomorrow)).toBe(false);
  });
});

describe("checkTripPrepNudges", () => {
  it("sends a flight nudge and stamps the booking so it doesn't fire twice", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("tripprep-flight"));
    const phone = registerActivePhone(user.id);
    const entity = saveEntity<BookingData>(user.id, {
      type: "booking",
      data: booking({ kind: "flight", startDate: dateKeyPlusDays(1) }),
    });

    await checkTripPrepNudges(user.id);

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    const [sentPhone, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(sentPhone).toBe(phone);
    expect(text).toContain("FR1234 LIS→FAO");

    const updated = getEntity<BookingData>(user.id, entity.id)!;
    expect(updated.data.tripPrepNotifiedAt).toBeTypeOf("number");

    await checkTripPrepNudges(user.id);
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1); // no second send
  });

  it("sends a hotel nudge on check-in day", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("tripprep-hotel"));
    registerActivePhone(user.id);
    saveEntity<BookingData>(user.id, {
      type: "booking",
      data: booking({ kind: "hotel", name: "Hotel Eva, Faro", startDate: todayKey(), endDate: dateKeyPlusDays(3) }),
    });

    await checkTripPrepNudges(user.id);

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    const [, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(text).toContain("Hotel Eva, Faro");
  });

  it("does nothing when no booking is due", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("tripprep-none"));
    registerActivePhone(user.id);
    saveEntity<BookingData>(user.id, {
      type: "booking",
      data: booking({ kind: "flight", startDate: dateKeyPlusDays(5) }),
    });

    await checkTripPrepNudges(user.id);

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it("on retry after a partial failure, only resends to the number that missed it", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("tripprep-partial"));
    const first = registerActivePhone(user.id);
    const second = registerActivePhone(user.id);
    const entity = saveEntity<BookingData>(user.id, {
      type: "booking",
      data: booking({ kind: "flight", startDate: dateKeyPlusDays(1) }),
    });
    vi.mocked(sendWhatsAppMessage).mockImplementation(async (to: string) => {
      if (to === second) throw new Error("network error");
    });

    await checkTripPrepNudges(user.id);
    expect(getEntity<BookingData>(user.id, entity.id)!.data.tripPrepNotifiedAt).toBeUndefined();

    vi.mocked(sendWhatsAppMessage).mockReset().mockResolvedValue(undefined);
    await checkTripPrepNudges(user.id);

    expect(vi.mocked(sendWhatsAppMessage).mock.calls.map((c) => c[0])).toEqual([second]);
    expect(first).not.toBe(second);
    expect(getEntity<BookingData>(user.id, entity.id)!.data.tripPrepNotifiedAt).toBeDefined();
  });

  it("does not stamp the booking if the send fails, so it retries next tick", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("tripprep-fail"));
    registerActivePhone(user.id);
    const entity = saveEntity<BookingData>(user.id, {
      type: "booking",
      data: booking({ kind: "flight", startDate: dateKeyPlusDays(1) }),
    });
    vi.mocked(sendWhatsAppMessage).mockRejectedValueOnce(new Error("network error"));

    await checkTripPrepNudges(user.id);

    const updated = getEntity<BookingData>(user.id, entity.id)!;
    expect(updated.data.tripPrepNotifiedAt).toBeUndefined();
  });

  it("does nothing when WhatsApp isn't configured", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("tripprep-unconfigured"));
    registerActivePhone(user.id);
    saveEntity<BookingData>(user.id, {
      type: "booking",
      data: booking({ kind: "flight", startDate: dateKeyPlusDays(1) }),
    });
    vi.mocked(isWhatsAppConfigured).mockReturnValue(false);

    await checkTripPrepNudges(user.id);

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it("does nothing when the user has no registered WhatsApp number", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("tripprep-nophone"));
    saveEntity<BookingData>(user.id, {
      type: "booking",
      data: booking({ kind: "flight", startDate: dateKeyPlusDays(1) }),
    });

    await checkTripPrepNudges(user.id);

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });
});
