import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../providers/whatsapp.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../providers/whatsapp.js")>();
  return {
    ...actual, // keeps the real WhatsAppSendError class — outbound.ts's `instanceof` check needs it
    sendWhatsAppMessage: vi.fn(),
    sendWhatsAppTemplate: vi.fn(),
    isWhatsAppConfigured: vi.fn().mockReturnValue(true),
  };
});

const { sendWhatsAppMessage } = await import("../providers/whatsapp.js");
const {
  findOrCreateUserByEmail,
  addPhoneNumberForUser,
  recordInboundMessage,
  saveEntity,
  getEntity,
  getAttentionItem,
  listAttentionItems,
} = await import("../db/store.js");
const { setUserTimezone } = await import("./userTimezone.js");
const { syncBookingReminders, flightNumberFrom, bookingSummary } = await import("./tripPrep.js");
const { submitAttentionItem, deliverDueAttentionItems } = await import("./attention.js");
const { DateTime } = await import("luxon");
import type { BookingData } from "./entityValidation.js";

const ZONE = "Europe/London";
const at = (iso: string) => DateTime.fromISO(iso, { zone: ZONE }).toJSDate();

let counter = 0;
const phones = new Map<number, string>();
// See reminderScheduler.test.ts for why the prefix must be file-unique across the whole test run
// (user_phone_numbers.phone is UNIQUE). This file keeps its historical "447000070".
function newUser() {
  counter += 1;
  const user = findOrCreateUserByEmail(`trip-prep-${Date.now()}-${counter}@example.com`);
  const phone = `447000070${String(counter).padStart(3, "0")}`;
  addPhoneNumberForUser(user.id, phone);
  recordInboundMessage(phone);
  setUserTimezone(user.id, ZONE);
  phones.set(user.id, phone);
  return user.id;
}

function booking(overrides: Partial<BookingData>): BookingData {
  return { kind: "flight", name: "FR1234 LIS→FAO", reference: null, startDate: "2026-10-05", endDate: null, ...overrides };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at("2026-10-01T12:00"));
  vi.mocked(sendWhatsAppMessage).mockReset().mockResolvedValue("wamid");
});

afterEach(() => vi.useRealTimers());

describe("flightNumberFrom", () => {
  it("pulls the flight number out of a booking name", () => {
    expect(flightNumberFrom("FR1234 LIS→FAO")).toBe("FR1234");
    expect(flightNumberFrom("BA 432 to Lisbon")).toBe("BA432");
    expect(flightNumberFrom("Hotel Eva, Faro")).toBeNull();
  });
});

describe("bookingSummary", () => {
  it("bolds the name, date and reference", () => {
    expect(bookingSummary(booking({ reference: "X7KQ2P" }))).toBe("Your flight *FR1234 LIS→FAO* on *5 Oct*, ref *X7KQ2P*.");
    expect(
      bookingSummary(booking({ kind: "hotel", name: "Hotel Eva, Faro", startDate: "2026-10-12", endDate: "2026-10-15" }))
    ).toBe("Your stay at *Hotel Eva, Faro* from *12 Oct* to *15 Oct*.");
  });
});

describe("syncBookingReminders", () => {
  it("turns a future booking into a silent, already-acknowledged reminder", async () => {
    const ownerId = newUser();
    const entity = saveEntity<BookingData>(ownerId, { type: "booking", data: booking({}) });

    await syncBookingReminders(ownerId);

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    const row = getAttentionItem(ownerId, "flight:FR1234:2026-10-05");
    expect(row?.tier).toBe("scheduled");
    expect(row?.acknowledgedAt).not.toBeNull();
    expect(row?.surfaceAt).toBe(at("2026-10-04T09:00").getTime());
    expect(getEntity<BookingData>(ownerId, entity.id)?.data.tripPrepNotifiedAt).toBeTypeOf("number");
  });

  it("is idempotent across ticks", async () => {
    const ownerId = newUser();
    saveEntity<BookingData>(ownerId, { type: "booking", data: booking({}) });
    await syncBookingReminders(ownerId);
    await syncBookingReminders(ownerId);
    expect(listAttentionItems(ownerId)).toHaveLength(1);
  });

  it("merges with the same booking already learned from email", async () => {
    const ownerId = newUser();
    await submitAttentionItem(ownerId, {
      source: "email",
      category: "reservation_confirmed",
      details: { summary: "Your *Hotel Eva* stay, ref *EVA12345*.", kind: "hotel", eventStart: "2026-10-12", reference: "EVA12345" },
      fallbackKey: "msg:1:eva",
    });
    saveEntity<BookingData>(ownerId, {
      type: "booking",
      data: booking({ kind: "hotel", name: "Hotel Eva, Faro", reference: "EVA12345", startDate: "2026-10-12" }),
    });

    await syncBookingReminders(ownerId);

    expect(listAttentionItems(ownerId)).toHaveLength(1);
    expect(getAttentionItem(ownerId, "ref:EVA12345")?.details.summary).toBe("Your *Hotel Eva* stay, ref *EVA12345*.");
  });

  it("ignores bookings in the past, using the user's own date", async () => {
    const ownerId = newUser();
    saveEntity<BookingData>(ownerId, { type: "booking", data: booking({ startDate: "2026-09-30" }) });
    await syncBookingReminders(ownerId);
    expect(listAttentionItems(ownerId)).toHaveLength(0);
  });

  it("sends the reminder when it falls due", async () => {
    const ownerId = newUser();
    saveEntity<BookingData>(ownerId, { type: "booking", data: booking({ reference: "X7KQ2P" }) });
    await syncBookingReminders(ownerId);
    vi.setSystemTime(at("2026-10-04T09:05"));
    recordInboundMessage(phones.get(ownerId)!); // inside the 24h window, so a plain message is sent
    await deliverDueAttentionItems(ownerId);
    expect(vi.mocked(sendWhatsAppMessage).mock.calls[0][1]).toBe(
      "✈️ Reminder: Your flight *FR1234 LIS→FAO* on *5 Oct*, ref *X7KQ2P*. Online check-in should be open now."
    );
  });
});
