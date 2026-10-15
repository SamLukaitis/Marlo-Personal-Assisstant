import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../providers/whatsapp.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../providers/whatsapp.js")>();
  return {
    ...actual,
    sendWhatsAppMessage: vi.fn(),
    sendWhatsAppTemplate: vi.fn(),
    isWhatsAppConfigured: vi.fn().mockReturnValue(true),
  };
});

// Plain factory, not importOriginal: loading the real phoneActions here pulls attention.ts in through
// the phoneActions -> followups -> assistant cycle before this mock is ready, so attention.ts would
// keep the real module. Defaults match an unconfigured install (suggestions off).
vi.mock("./phoneActions.js", () => ({
  phoneSuggestionsEnabled: vi.fn(() => false),
  createPhoneAction: vi.fn(),
  PROACTIVE_TTL_MS: 36 * 60 * 60 * 1000,
}));

const { sendWhatsAppMessage } = await import("../providers/whatsapp.js");
const { phoneSuggestionsEnabled, createPhoneAction } = await import("./phoneActions.js");
const { findOrCreateUserByEmail, addPhoneNumberForUser, recordInboundMessage, getAttentionItem, listAttentionItems } =
  await import("../db/store.js");
const { setUserTimezone } = await import("./userTimezone.js");
const { saveBriefingSettings } = await import("./briefing.js");
const {
  submitAttentionItem,
  deliverDueAttentionItems,
  collectAttentionForBriefing,
  collectAttentionForDigest,
  commitAttentionBundle,
} = await import("./attention.js");
const { DateTime } = await import("luxon");

const ZONE = "Europe/London";
const at = (iso: string) => DateTime.fromISO(iso, { zone: ZONE }).toJSDate();

let counter = 0;
const phones = new Map<number, string>();
// Phone prefix "44700011" — see importantEmailAlerts.test.ts on prefixes shared across files.
function newUser() {
  counter += 1;
  const user = findOrCreateUserByEmail(`attention-${Date.now()}-${counter}@example.com`);
  const phone = `44700011${String(counter).padStart(4, "0")}`;
  addPhoneNumberForUser(user.id, phone);
  recordInboundMessage(phone);
  setUserTimezone(user.id, ZONE);
  phones.set(user.id, phone);
  return user.id;
}

// Moving the fake clock days ahead closes the 24h WhatsApp window; a user who just messaged us gets
// free-form text (sendWhatsAppMessage) rather than a template.
function messagedJustNow(ownerId: number) {
  recordInboundMessage(phones.get(ownerId)!);
}

function sentTexts(): string[] {
  return vi.mocked(sendWhatsAppMessage).mock.calls.map(([, text]) => text as string);
}

const hotel = (ref = "HLT12345") => ({
  source: "email" as const,
  category: "reservation_confirmed",
  details: {
    summary: `Your *Hilton Lisbon* stay is confirmed for *12–15 Oct*, ref *${ref}*.`,
    kind: "hotel" as const,
    eventStart: "2026-10-12",
    reference: ref,
  },
  fallbackKey: `msg:1:${ref}`,
});

const govLetter = (i: number) => ({
  source: "email" as const,
  category: "government_mail",
  details: { summary: `*Council* letter ${i} needs a reply by *10 Oct*.`, needsAction: true },
  fallbackKey: `msg:1:gov${i}`,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at("2026-10-01T12:00"));
  vi.mocked(sendWhatsAppMessage).mockReset().mockResolvedValue("wamid");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("submitAttentionItem", () => {
  it("stays silent for a future booking and schedules its reminder", async () => {
    const ownerId = newUser();
    expect(await submitAttentionItem(ownerId, hotel())).toBe("scheduled");
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    const row = getAttentionItem(ownerId, "ref:HLT12345");
    expect(row?.tier).toBe("scheduled");
    expect(row?.surfaceAt).toBe(at("2026-10-12T09:00").getTime());
  });

  it("merges the same event from a second source into one row with no message", async () => {
    const ownerId = newUser();
    await submitAttentionItem(ownerId, hotel());
    expect(
      await submitAttentionItem(ownerId, {
        source: "reconciliation",
        category: "document_match",
        details: { summary: '*Hilton booking* — new email: "Your stay"', reference: "HLT12345" },
        fallbackKey: "msg:1:other",
      })
    ).toBe("merged");
    expect(listAttentionItems(ownerId)).toHaveLength(1);
    expect(getAttentionItem(ownerId, "ref:HLT12345")?.details.summary).toContain("Hilton Lisbon");
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it("submitting the identical item twice never sends twice", async () => {
    const ownerId = newUser();
    const alert = {
      source: "email" as const,
      category: "security_alert",
      details: { summary: "New sign-in to your *Google* account from *Paris*." },
      fallbackKey: "msg:1:sec",
    };
    expect(await submitAttentionItem(ownerId, alert)).toBe("sent");
    expect(await submitAttentionItem(ownerId, alert)).toBe("merged");
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
  });

  it("interrupts at once for a flight change and notes a moved reminder on a known booking", async () => {
    const ownerId = newUser();
    await submitAttentionItem(ownerId, {
      source: "email",
      category: "reservation_confirmed",
      details: {
        summary: "Your *BA 432* to Lisbon on *3 Oct*.",
        kind: "flight",
        flightNumber: "BA432",
        eventStart: "2026-10-03T08:40:00+01:00",
      },
      fallbackKey: "msg:1:a",
    });
    const outcome = await submitAttentionItem(ownerId, {
      source: "email",
      category: "flight_change",
      details: {
        summary: "Your *BA 432* to Lisbon now leaves *09:55* (was 08:40).",
        kind: "flight",
        flightNumber: "BA432",
        eventStart: "2026-10-03T09:55:00+01:00",
      },
      fallbackKey: "msg:1:b",
    });
    expect(outcome).toBe("sent");
    expect(sentTexts()).toEqual([
      "✈️ Your *BA 432* to Lisbon now leaves *09:55* (was 08:40). Nothing to do — I've moved your reminder.",
    ]);
    const row = getAttentionItem(ownerId, "flight:BA432:2026-10-03");
    expect(row?.tier).toBe("scheduled");
    expect(row?.status).toBe("pending");
    expect(row?.surfaceAt).toBe(at("2026-10-02T09:55").getTime());
  });

  it("drops a booking whose date has already passed", async () => {
    const ownerId = newUser();
    const past = hotel("OLD12345");
    past.details.eventStart = "2026-09-20";
    expect(await submitAttentionItem(ownerId, past)).toBe("dropped");
    expect(getAttentionItem(ownerId, "ref:OLD12345")?.status).toBe("dropped");
  });

  it("defers a non-flight interrupt during quiet hours, but sends a flight change", async () => {
    vi.setSystemTime(at("2026-10-01T23:30"));
    const ownerId = newUser();
    expect(
      await submitAttentionItem(ownerId, {
        source: "email",
        category: "government_mail",
        details: { summary: "*HMRC* needs your tax return by *31 Oct*.", needsAction: true },
        fallbackKey: "msg:1:gov",
      })
    ).toBe("deferred");
    expect(
      await submitAttentionItem(ownerId, {
        source: "email",
        category: "flight_change",
        details: { summary: "Your *EZY 8021* is *cancelled*." },
        fallbackKey: "msg:1:ezy",
      })
    ).toBe("sent");
    expect(sentTexts()).toHaveLength(1);
    expect(getAttentionItem(ownerId, "msg:1:gov")?.surfaceAt).toBe(at("2026-10-02T07:00").getTime());
  });

  it("downgrades a message that isn't concrete to the briefing instead of sending it", async () => {
    const ownerId = newUser();
    expect(
      await submitAttentionItem(ownerId, {
        source: "email",
        category: "security_alert",
        details: { summary: "Something happened on an account." },
        fallbackKey: "msg:1:vague",
      })
    ).toBe("queued");
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(getAttentionItem(ownerId, "msg:1:vague")?.tier).toBe("brief");
  });

  it("stores items even with no reachable number, and interrupts stay pending for later", async () => {
    const user = findOrCreateUserByEmail(`attention-nophone-${Date.now()}@example.com`);
    setUserTimezone(user.id, ZONE);
    expect(
      await submitAttentionItem(user.id, {
        source: "email",
        category: "security_alert",
        details: { summary: "New sign-in to your *Google* account." },
        fallbackKey: "msg:1:nophone",
      })
    ).toBe("failed");
    expect(getAttentionItem(user.id, "msg:1:nophone")?.status).toBe("pending");
  });
});

describe("deliverDueAttentionItems", () => {
  it("sends a scheduled reminder once it is due, exactly once", async () => {
    const ownerId = newUser();
    await submitAttentionItem(ownerId, hotel());
    vi.setSystemTime(at("2026-10-12T09:05"));
    messagedJustNow(ownerId);
    await deliverDueAttentionItems(ownerId);
    await deliverDueAttentionItems(ownerId);
    expect(sentTexts()).toEqual([
      "🏨 Reminder: Your *Hilton Lisbon* stay is confirmed for *12–15 Oct*, ref *HLT12345*. Check-in is today.",
    ]);
    expect(getAttentionItem(ownerId, "ref:HLT12345")?.status).toBe("sent");
  });

  it("holds the 5th capped message of the day instead of sending or dropping it", async () => {
    const ownerId = newUser();
    for (let i = 0; i < 5; i++) await submitAttentionItem(ownerId, govLetter(i));
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(4);
    expect(getAttentionItem(ownerId, "msg:1:gov4")?.status).toBe("held");
    // Exempt categories still go through.
    await submitAttentionItem(ownerId, {
      source: "email",
      category: "flight_change",
      details: { summary: "Your *BA 1* is *cancelled*." },
      fallbackKey: "msg:1:ba1",
    });
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(5);
  });

  it("a failed send stays pending, retries next tick, and doesn't use up the cap", async () => {
    const ownerId = newUser();
    await submitAttentionItem(ownerId, hotel());
    vi.setSystemTime(at("2026-10-12T09:05"));
    messagedJustNow(ownerId);
    vi.mocked(sendWhatsAppMessage).mockRejectedValueOnce(new Error("network"));
    await deliverDueAttentionItems(ownerId);
    expect(getAttentionItem(ownerId, "ref:HLT12345")?.status).toBe("pending");
    expect(getAttentionItem(ownerId, "ref:HLT12345")?.sentAt).toBeNull();
    await deliverDueAttentionItems(ownerId);
    expect(getAttentionItem(ownerId, "ref:HLT12345")?.status).toBe("sent");
  });

  it("sends a quiet-hours-deferred item at 07:00", async () => {
    vi.setSystemTime(at("2026-10-01T23:30"));
    const ownerId = newUser();
    await submitAttentionItem(ownerId, {
      source: "email",
      category: "government_mail",
      details: { summary: "*HMRC* needs your tax return by *31 Oct*.", needsAction: true },
      fallbackKey: "msg:1:gov",
    });
    vi.setSystemTime(at("2026-10-02T06:55"));
    await deliverDueAttentionItems(ownerId);
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    vi.setSystemTime(at("2026-10-02T07:02"));
    await deliverDueAttentionItems(ownerId);
    expect(sentTexts()).toEqual(["🏛️ *HMRC* needs your tax return by *31 Oct*."]);
  });
});

describe("collecting for the briefing and digest", () => {
  it("the briefing acknowledges new bookings once and lists brief/held items", async () => {
    const ownerId = newUser();
    await submitAttentionItem(ownerId, hotel());
    await submitAttentionItem(ownerId, {
      source: "email",
      category: "refund_dispute",
      details: { summary: "Your *Amazon* refund of *£24* was approved." },
      fallbackKey: "msg:1:refund",
    });
    const now = at("2026-10-02T07:30").getTime();
    const bundle = collectAttentionForBriefing(ownerId, now);
    expect(bundle.noted).toEqual([
      "Noted: your *Hilton Lisbon* stay is confirmed for *12–15 Oct*, ref *HLT12345* — I'll remind you Mon 12 Oct.",
    ]);
    expect(bundle.needsAttention).toEqual(["Your *Amazon* refund of *£24* was approved."]);
    commitAttentionBundle(ownerId, bundle, now);
    const again = collectAttentionForBriefing(ownerId, now);
    expect(again.noted).toEqual([]);
    expect(again.needsAttention).toEqual([]);
  });

  it("the briefing folds in reminders due within the next 2 hours so they don't ping separately", async () => {
    const ownerId = newUser();
    await submitAttentionItem(ownerId, hotel());
    const now = at("2026-10-12T07:30").getTime();
    const bundle = collectAttentionForBriefing(ownerId, now);
    expect(bundle.upcoming).toHaveLength(1);
    commitAttentionBundle(ownerId, bundle, now);
    vi.setSystemTime(at("2026-10-12T09:05"));
    await deliverDueAttentionItems(ownerId);
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(getAttentionItem(ownerId, "ref:HLT12345")?.status).toBe("folded");
  });

  it("the digest always carries held items, and brief items only when asked", async () => {
    const ownerId = newUser();
    for (let i = 0; i < 5; i++) await submitAttentionItem(ownerId, govLetter(i));
    await submitAttentionItem(ownerId, {
      source: "email",
      category: "refund_dispute",
      details: { summary: "Your *Amazon* refund of *£24* was approved." },
      fallbackKey: "msg:1:refund",
    });
    const now = at("2026-10-01T21:00").getTime();
    expect(collectAttentionForDigest(ownerId, now, false).needsAttention).toEqual([
      "*Council* letter 4 needs a reply by *10 Oct*.",
    ]);
    expect(collectAttentionForDigest(ownerId, now, true).needsAttention).toHaveLength(2);
  });
});

describe("early briefing absorbs quiet-hours deferrals", () => {
  it("defers to the briefing time when the proactive briefing is between 07:00 and 09:00", async () => {
    vi.setSystemTime(at("2026-10-01T23:30"));
    const ownerId = newUser();
    saveBriefingSettings(ownerId, {
      enabled: true,
      includeNews: false,
      topics: [],
      includeMarkets: false,
      tickers: [],
      includeWeather: false,
      weatherLocation: "",
      proactive: true,
      sendTime: "07:45",
    });
    await submitAttentionItem(ownerId, {
      source: "email",
      category: "government_mail",
      details: { summary: "*HMRC* needs your tax return by *31 Oct*.", needsAction: true },
      fallbackKey: "msg:1:gov",
    });
    expect(getAttentionItem(ownerId, "msg:1:gov")?.surfaceAt).toBe(at("2026-10-02T07:45").getTime());
  });
});

describe("final review fixes", () => {
  it("a second, different change to the same flight is sent too; an identical repeat is not", async () => {
    const ownerId = newUser();
    const change = (summary: string, id: string) => ({
      source: "email" as const,
      category: "flight_change",
      details: { summary, kind: "flight" as const, flightNumber: "BA432", eventStart: "2026-10-03" },
      fallbackKey: `msg:1:${id}`,
    });
    expect(await submitAttentionItem(ownerId, change("Your *BA 432* is delayed to *09:55*.", "c1"))).toBe("sent");
    expect(await submitAttentionItem(ownerId, change("Your *BA 432* is now *cancelled*.", "c2"))).toBe("sent");
    expect(await submitAttentionItem(ownerId, change("Your *BA 432* is now *cancelled*.", "c3"))).toBe("merged");
    expect(sentTexts()).toEqual(["✈️ Your *BA 432* is delayed to *09:55*.", "✈️ Your *BA 432* is now *cancelled*."]);
  });

  it("several items deferred overnight go out as one message in the morning", async () => {
    vi.setSystemTime(at("2026-10-01T23:30"));
    const ownerId = newUser();
    await submitAttentionItem(ownerId, {
      source: "email",
      category: "government_mail",
      details: { summary: "*HMRC* needs your tax return by *31 Oct*.", needsAction: true },
      fallbackKey: "msg:1:gov",
    });
    await submitAttentionItem(ownerId, {
      source: "email",
      category: "security_alert",
      details: { summary: "New sign-in to your *Google* account from *Paris*." },
      fallbackKey: "msg:1:sec",
    });
    vi.setSystemTime(at("2026-10-02T07:02"));
    await deliverDueAttentionItems(ownerId);
    expect(sentTexts()).toEqual([
      "🏛️ *HMRC* needs your tax return by *31 Oct*.\n\n🔐 New sign-in to your *Google* account from *Paris*.",
    ]);
    expect(getAttentionItem(ownerId, "msg:1:gov")?.status).toBe("sent");
    expect(getAttentionItem(ownerId, "msg:1:sec")?.status).toBe("sent");
    await deliverDueAttentionItems(ownerId);
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
  });

  it("an early briefing absorbs items deferred overnight instead of pinging separately", async () => {
    vi.setSystemTime(at("2026-10-01T23:30"));
    const ownerId = newUser();
    saveBriefingSettings(ownerId, {
      enabled: true,
      includeNews: false,
      topics: [],
      includeMarkets: false,
      tickers: [],
      includeWeather: false,
      weatherLocation: "",
      proactive: true,
      sendTime: "07:45",
    });
    await submitAttentionItem(ownerId, {
      source: "email",
      category: "government_mail",
      details: { summary: "*HMRC* needs your tax return by *31 Oct*.", needsAction: true },
      fallbackKey: "msg:1:gov",
    });
    const now = at("2026-10-02T07:45").getTime();
    vi.setSystemTime(now);
    const bundle = collectAttentionForBriefing(ownerId, now);
    expect(bundle.upcoming).toEqual(["🏛️ *HMRC* needs your tax return by *31 Oct*."]);
    commitAttentionBundle(ownerId, bundle, now);
    messagedJustNow(ownerId);
    await deliverDueAttentionItems(ownerId);
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });
});

describe("phone link failures", () => {
  it("a throwing createPhoneAction logs and still sends the reminder without the link", async () => {
    const ownerId = newUser();
    await submitAttentionItem(ownerId, {
      source: "email",
      category: "reservation_confirmed",
      details: {
        summary: `Your *Hilton Lisbon* stay is confirmed for *12–15 Oct*, ref *HLT12345*.`,
        kind: "hotel",
        merchant: "Hilton Lisbon",
        eventStart: "2026-10-12",
        reference: "HLT12345",
      },
      fallbackKey: "msg:1:HLT12345",
    });
    vi.setSystemTime(at("2026-10-12T09:05"));
    messagedJustNow(ownerId);
    vi.mocked(phoneSuggestionsEnabled).mockReturnValueOnce(true);
    vi.mocked(createPhoneAction).mockImplementationOnce(() => {
      throw new Error("db down");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await deliverDueAttentionItems(ownerId);
      expect(sentTexts()).toEqual([
        "🏨 Reminder: Your *Hilton Lisbon* stay is confirmed for *12–15 Oct*, ref *HLT12345*. Check-in is today.",
      ]);
      expect(getAttentionItem(ownerId, "ref:HLT12345")?.status).toBe("sent");
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("attention:"), expect.anything());
    } finally {
      errorSpy.mockRestore();
    }
  });
});
