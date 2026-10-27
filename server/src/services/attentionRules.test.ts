import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import {
  parseEventStart,
  tierFor,
  eventKeyFor,
  surfaceAtFor,
  inQuietHours,
  nextAllowedTime,
  localDayStart,
  formatWhen,
  isConcrete,
  interruptText,
  reminderText,
  ackLine,
  briefLine,
} from "./attentionRules.js";

const ZONE = "Europe/London";
const at = (iso: string) => DateTime.fromISO(iso, { zone: ZONE }).toMillis();
const NOW = at("2026-10-01T12:00");

describe("parseEventStart", () => {
  it("reads a date-only value as the start of that local day, without a time", () => {
    expect(parseEventStart("2026-10-03", ZONE)).toEqual({ ms: at("2026-10-03T00:00"), hasTime: false });
  });
  it("keeps an explicit offset", () => {
    expect(parseEventStart("2026-10-03T08:40:00+01:00", ZONE)).toEqual({ ms: at("2026-10-03T08:40"), hasTime: true });
  });
  it("returns null for anything that isn't a date", () => {
    expect(parseEventStart("next Tuesday", ZONE)).toBeNull();
    expect(parseEventStart("", ZONE)).toBeNull();
    expect(parseEventStart(null, ZONE)).toBeNull();
  });
  it("works with no known timezone", () => {
    const parsed = parseEventStart("2026-10-03", null);
    expect(parsed?.hasTime).toBe(false);
    expect(Number.isFinite(parsed?.ms)).toBe(true);
  });
});

describe("tierFor", () => {
  const s = { summary: "x" };
  it("interrupts for flight changes and security alerts", () => {
    expect(tierFor("flight_change", s, NOW, ZONE)).toBe("interrupt");
    expect(tierFor("security_alert", s, NOW, ZONE)).toBe("interrupt");
  });
  it("interrupts for government mail only when it needs action", () => {
    expect(tierFor("government_mail", { ...s, needsAction: true }, NOW, ZONE)).toBe("interrupt");
    expect(tierFor("government_mail", s, NOW, ZONE)).toBe("brief");
  });
  it("schedules a bill due later, interrupts one due within 2 days or overdue", () => {
    expect(tierFor("invoice_due", { ...s, dueDate: "2026-10-10" }, NOW, ZONE)).toBe("scheduled");
    expect(tierFor("invoice_due", { ...s, dueDate: "2026-10-03" }, NOW, ZONE)).toBe("interrupt");
    expect(tierFor("invoice_due", { ...s, dueDate: "2026-09-20" }, NOW, ZONE)).toBe("interrupt");
  });
  it("interrupts for an undated bill that needs action, briefs one that doesn't", () => {
    expect(tierFor("invoice_due", { ...s, needsAction: true }, NOW, ZONE)).toBe("interrupt");
    expect(tierFor("invoice_due", s, NOW, ZONE)).toBe("brief");
  });
  it("schedules a future reservation, drops a past one, briefs an undated one", () => {
    expect(tierFor("reservation_confirmed", { ...s, eventStart: "2026-10-12" }, NOW, ZONE)).toBe("scheduled");
    expect(tierFor("reservation_confirmed", { ...s, eventStart: "2026-09-12" }, NOW, ZONE)).toBe("drop");
    expect(tierFor("reservation_confirmed", { ...s, eventStart: "sometime" }, NOW, ZONE)).toBe("brief");
  });
  it("still schedules a reservation later today", () => {
    expect(tierFor("reservation_confirmed", { ...s, eventStart: "2026-10-01" }, NOW, ZONE)).toBe("scheduled");
  });
  it("schedules a dated renewal, briefs an undated one, drops a past one", () => {
    expect(tierFor("subscription_renewal", { ...s, dueDate: "2026-10-20" }, NOW, ZONE)).toBe("scheduled");
    expect(tierFor("subscription_renewal", s, NOW, ZONE)).toBe("brief");
    expect(tierFor("subscription_renewal", { ...s, dueDate: "2026-09-01" }, NOW, ZONE)).toBe("drop");
  });
  it("drops routine deliveries, briefs ones that need action", () => {
    expect(tierFor("delivery_notification", s, NOW, ZONE)).toBe("drop");
    expect(tierFor("delivery_notification", { ...s, needsAction: true }, NOW, ZONE)).toBe("brief");
  });
  it("briefs refund updates and document matches; person emails interrupt", () => {
    expect(tierFor("refund_dispute", s, NOW, ZONE)).toBe("brief");
    expect(tierFor("document_match", s, NOW, ZONE)).toBe("brief");
    expect(tierFor("person_email", s, NOW, ZONE)).toBe("interrupt");
  });
});

describe("eventKeyFor", () => {
  it("prefers a normalised reference", () => {
    expect(eventKeyFor({ summary: "", reference: " abc 123 " }, "msg:1:x")).toBe("ref:ABC123");
  });
  it("ignores a reference too short to be distinctive", () => {
    expect(eventKeyFor({ summary: "", reference: "A1" }, "msg:1:x")).toBe("msg:1:x");
  });
  it("uses flight number + date when there is no reference", () => {
    expect(eventKeyFor({ summary: "", flightNumber: "ba 432", eventStart: "2026-10-03T08:40:00+01:00" }, "f")).toBe(
      "flight:BA432:2026-10-03"
    );
  });
  it("uses merchant + date as a last structured resort", () => {
    expect(eventKeyFor({ summary: "", merchant: "Netflix, Inc.", dueDate: "2026-10-03" }, "f")).toBe(
      "merchant:netflix-inc:2026-10-03"
    );
  });
  it("falls back when nothing identifies the event", () => {
    expect(eventKeyFor({ summary: "", merchant: "Netflix" }, "msg:1:x")).toBe("msg:1:x");
  });
});

describe("surfaceAtFor", () => {
  it("flight with a time: 24h before", () => {
    expect(
      surfaceAtFor("reservation_confirmed", { summary: "", kind: "flight", eventStart: "2026-10-03T08:40:00+01:00" }, ZONE)
    ).toBe(at("2026-10-02T08:40"));
  });
  it("flight date only: 09:00 the day before", () => {
    expect(surfaceAtFor("reservation_confirmed", { summary: "", kind: "flight", eventStart: "2026-10-03" }, ZONE)).toBe(
      at("2026-10-02T09:00")
    );
  });
  it("hotel: 09:00 on check-in day", () => {
    expect(
      surfaceAtFor("reservation_confirmed", { summary: "", kind: "hotel", eventStart: "2026-10-12T15:00:00+01:00" }, ZONE)
    ).toBe(at("2026-10-12T09:00"));
  });
  it("restaurant with a time: 3h before; without: 09:00 that day", () => {
    expect(
      surfaceAtFor("reservation_confirmed", { summary: "", kind: "restaurant", eventStart: "2026-10-05T20:00:00+01:00" }, ZONE)
    ).toBe(at("2026-10-05T17:00"));
    expect(surfaceAtFor("reservation_confirmed", { summary: "", kind: "restaurant", eventStart: "2026-10-05" }, ZONE)).toBe(
      at("2026-10-05T09:00")
    );
  });
  it("renewal: 09:00 three days before; bill: 09:00 two days before", () => {
    expect(surfaceAtFor("subscription_renewal", { summary: "", dueDate: "2026-10-20" }, ZONE)).toBe(at("2026-10-17T09:00"));
    expect(surfaceAtFor("invoice_due", { summary: "", dueDate: "2026-10-20" }, ZONE)).toBe(at("2026-10-18T09:00"));
  });
  it("returns null with no usable date", () => {
    expect(surfaceAtFor("reservation_confirmed", { summary: "", eventStart: "soon" }, ZONE)).toBeNull();
  });
});

describe("quiet hours", () => {
  it("is quiet from 22:00 to 07:00 local", () => {
    expect(inQuietHours(at("2026-10-01T22:00"), ZONE)).toBe(true);
    expect(inQuietHours(at("2026-10-02T03:00"), ZONE)).toBe(true);
    expect(inQuietHours(at("2026-10-02T06:59"), ZONE)).toBe(true);
    expect(inQuietHours(at("2026-10-02T07:00"), ZONE)).toBe(false);
    expect(inQuietHours(at("2026-10-01T21:59"), ZONE)).toBe(false);
  });
  it("defers to 07:00 the next morning, or to an early briefing time", () => {
    expect(nextAllowedTime(at("2026-10-01T23:30"), ZONE, null)).toBe(at("2026-10-02T07:00"));
    expect(nextAllowedTime(at("2026-10-02T02:00"), ZONE, null)).toBe(at("2026-10-02T07:00"));
    expect(nextAllowedTime(at("2026-10-02T02:00"), ZONE, "07:30")).toBe(at("2026-10-02T07:30"));
    expect(nextAllowedTime(at("2026-10-02T02:00"), ZONE, "10:00")).toBe(at("2026-10-02T07:00"));
  });
  it("returns the same time outside quiet hours", () => {
    expect(nextAllowedTime(at("2026-10-01T12:00"), ZONE, null)).toBe(at("2026-10-01T12:00"));
  });
  it("does not throw with no known timezone", () => {
    expect(() => inQuietHours(NOW, null)).not.toThrow();
    expect(Number.isFinite(nextAllowedTime(NOW, null, null))).toBe(true);
  });
  it("finds the local day start", () => {
    expect(localDayStart(at("2026-10-01T15:00"), ZONE)).toBe(at("2026-10-01T00:00"));
  });
});

describe("formatWhen", () => {
  it("says today / tomorrow with a time, else a short date", () => {
    expect(formatWhen(at("2026-10-01T17:00"), ZONE, NOW)).toBe("today at 17:00");
    expect(formatWhen(at("2026-10-02T09:00"), ZONE, NOW)).toBe("tomorrow at 09:00");
    expect(formatWhen(at("2026-10-17T09:00"), ZONE, NOW)).toBe("Sat 17 Oct");
  });
});

describe("isConcrete", () => {
  it("needs a bold specific", () => {
    expect(isConcrete("Your flight moved.")).toBe(false);
    expect(isConcrete("Your *BA 432* now leaves *09:55*.")).toBe(true);
  });
  it("rejects the banned vague phrases", () => {
    for (const text of [
      "An email about your *Hotel* came in. Worth a look?",
      "*3* emails — check your inbox",
      "*2* important-looking emails",
      "*Sarah* emailed, and 4 more",
      "*X* might need attention",
      "*2* more — just ask and I'll run through them",
    ]) {
      expect(isConcrete(text)).toBe(false);
    }
  });
});

describe("message builders", () => {
  const flight = {
    summary: "Your *BA 432* to Lisbon now leaves *09:55* (was 08:40).",
    kind: "flight" as const,
    eventStart: "2026-10-02T09:55:00+01:00",
  };
  it("interrupt text leads with the category emoji and notes a moved reminder", () => {
    const text = interruptText("flight_change", flight, true);
    expect(text).toBe(
      "✈️ Your *BA 432* to Lisbon now leaves *09:55* (was 08:40). Nothing to do — I've moved your reminder."
    );
    expect(isConcrete(text)).toBe(true);
  });
  it("person-email interrupt uses the mail emoji", () => {
    expect(interruptText("person_email", { summary: "*Sarah Kim* — wants to move Thursday's call; needs a reply" }, false)).toBe(
      "📬 *Sarah Kim* — wants to move Thursday's call; needs a reply"
    );
  });
  it("flight reminder says check-in is open", () => {
    const text = reminderText("reservation_confirmed", { ...flight, summary: "Your *BA 432* to Lisbon, ref *X7KQ2P*." }, ZONE, NOW);
    expect(text).toBe("✈️ Reminder: Your *BA 432* to Lisbon, ref *X7KQ2P*. Online check-in should be open now.");
  });
  it("renewal reminder names when it charges", () => {
    const text = reminderText(
      "subscription_renewal",
      { summary: "Your *Netflix* renews at *£17.99*.", dueDate: "2026-10-03" },
      ZONE,
      NOW
    );
    expect(text).toBe("🔁 Reminder: Your *Netflix* renews at *£17.99*. It charges Sat 3 Oct — tell me if you want to cancel.");
  });
  it("ack line says what was noted and when Marlo will bring it up", () => {
    expect(
      ackLine({ summary: "Your *Netflix* renewal, *£17.99* on *3 Oct*." }, at("2026-09-30T09:00"), ZONE, at("2026-09-28T08:00"))
    ).toBe("Noted: your *Netflix* renewal, *£17.99* on *3 Oct* — I'll remind you Wed 30 Sep.");
  });
  it("brief line is the summary", () => {
    expect(briefLine({ summary: "Your *Amazon* refund of *£24* was approved." })).toBe(
      "Your *Amazon* refund of *£24* was approved."
    );
  });
});
