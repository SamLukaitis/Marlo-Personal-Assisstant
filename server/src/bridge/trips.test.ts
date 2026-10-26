import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/outbound.js", () => ({
  sendProactiveMessage: vi.fn(async () => {}),
  sendProactiveMessageWithButtons: vi.fn(async () => {}),
}));
vi.mock("../services/tripDerivation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/tripDerivation.js")>()),
  countryFor: vi.fn(async () => "Portugal"),
}));
vi.mock("../services/hub.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/hub.js")>()),
  hubListEventsBetween: vi.fn(),
}));

import {
  answerTripQuestion,
  linkToFamily,
  listShared,
  openTripQuestions,
  registerBridge,
  resolveAvailability,
  syncTripsForPhone,
  unlinkFromFamily,
  updateLinkSettings,
} from "./index.js";
import { sendProactiveMessageWithButtons } from "../services/outbound.js";
import { hubListEventsBetween } from "../services/hub.js";
import { appendWhatsAppMessage, findOrCreateUserByPhone, listFamilyTrips, saveEntity } from "../db/store.js";
import { createFamily, joinFamilyByCode, requestLeave } from "../joyce/registry.js";
import { openFamilySessionForNewMember, openFamilySessionForPhone } from "../joyce/familyDb.js";
import { handlePendingLeave } from "../joyce/leaving.js";
import { setFamilyHooks } from "../joyce/hooks.js";
import { setMemberName } from "../joyce/store.js";
import { whoIsAway, checkAvailability } from "../joyce/tripTools.js";
import type { BookingData } from "../services/entityValidation.js";
import type { CalendarEvent } from "../providers/types.js";

const asks = vi.mocked(sendProactiveMessageWithButtons);
const events = vi.mocked(hubListEventsBetween);

let counter = 0;
function person(name: string, joinCode?: string) {
  counter += 1;
  const phone = `44795550${String(counter).padStart(4, "0")}`;
  const ownerId = findOrCreateUserByPhone(phone).id;
  appendWhatsAppMessage(ownerId, phone, "user", "hi");
  if (joinCode) {
    expect(joinFamilyByCode(phone, joinCode).ok).toBe(true);
    setMemberName(openFamilySessionForPhone(phone)!, name);
    return { phone, ownerId, joinCode };
  }
  const created = createFamily(phone);
  setMemberName(openFamilySessionForNewMember(created.family, phone), name);
  return { phone, ownerId, joinCode: created.joinCode };
}

function hotel(ownerId: number, startDate: string, endDate: string) {
  return saveEntity<BookingData>(ownerId, {
    type: "booking",
    data: { kind: "hotel", name: "Hotel Eva, Faro", reference: "PNR999", startDate, endDate },
  });
}
function flight(ownerId: number, startDate: string) {
  return saveEntity<BookingData>(ownerId, {
    type: "booking",
    data: { kind: "flight", name: "FR1234 LIS→FAO", reference: "PNR999", startDate, endDate: null },
  });
}

// Two people in one family; Ana is the one with the bookings, Ben asks Joyce.
function family() {
  const ana = person("Ana");
  const ben = person("Ben", ana.joinCode);
  const asBen = () => openFamilySessionForPhone(ben.phone)!;
  return { ana, ben, asBen };
}

// Linking starts a background trip sync; let it finish so the test's own sync isn't skipped as a duplicate.
async function link(ana: { ownerId: number; phone: string }, settings: Parameters<typeof linkToFamily>[2] = {}) {
  linkToFamily(ana.ownerId, ana.phone, settings);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  asks.mockClear();
  events.mockReset();
  registerBridge();
});
afterEach(() => setFamilyHooks({}));

describe("deciding to share a trip", () => {
  it("asks once, shares nothing until they answer, then shares dates only", async () => {
    const { ana, asBen } = family();
    await link(ana);
    hotel(ana.ownerId, "2099-03-10", "2099-03-17");
    await syncTripsForPhone(ana.ownerId, ana.phone);
    await syncTripsForPhone(ana.ownerId, ana.phone);

    expect(asks).toHaveBeenCalledTimes(1);
    const buttons = asks.mock.calls[0][2];
    expect(buttons.map((b) => b.title)).toEqual(["Share dates", "Dates + country", "Don't share"]);
    expect(whoIsAway(asBen(), "2099-03-01", "2099-03-31")).toContain("Nothing is shared for Ana");

    const [open] = openTripQuestions(ana.ownerId, ana.phone);
    const answer = answerTripQuestion(ana.ownerId, ana.phone, open.tripKey, "dates");
    expect(answer).toMatchObject({ ok: true, shared: true, country: null });

    const said = whoIsAway(asBen(), "2099-03-01", "2099-03-31");
    expect(said).toContain("Ana is away 10 Mar–17 Mar.");
    expect(said).not.toMatch(/Portugal|Faro|Eva|PNR999|FR1234/);
    expect(listShared(ana.ownerId, ana.phone).map((s) => [s.category, s.label])).toEqual([["trip", "10 Mar – 17 Mar"]]);
  });

  it("includes the country only when they choose it", async () => {
    const { ana, asBen } = family();
    await link(ana);
    hotel(ana.ownerId, "2099-03-10", "2099-03-17");
    await syncTripsForPhone(ana.ownerId, ana.phone);
    const [open] = openTripQuestions(ana.ownerId, ana.phone);
    answerTripQuestion(ana.ownerId, ana.phone, open.tripKey, "country");
    expect(whoIsAway(asBen(), "2099-03-01", "2099-03-31")).toContain("Ana is away 10 Mar–17 Mar (Portugal).");
  });

  it("a declined trip stays declined and looks the same as nothing shared", async () => {
    const { ana, asBen } = family();
    await link(ana);
    hotel(ana.ownerId, "2099-03-10", "2099-03-17");
    await syncTripsForPhone(ana.ownerId, ana.phone);
    const [open] = openTripQuestions(ana.ownerId, ana.phone);
    expect(answerTripQuestion(ana.ownerId, ana.phone, open.tripKey, "no")).toMatchObject({ ok: true, shared: false });
    await syncTripsForPhone(ana.ownerId, ana.phone);
    expect(asks).toHaveBeenCalledTimes(1);
    expect(whoIsAway(asBen(), "2099-03-01", "2099-03-31")).toContain("Nothing is shared for Ana");
    expect(answerTripQuestion(ana.ownerId, ana.phone, open.tripKey, "dates")).toEqual({ ok: false, reason: "answered" });
  });

  it("asks again when the dates move, and refuses an answer to the old question", async () => {
    const { ana } = family();
    await link(ana);
    const stay = hotel(ana.ownerId, "2099-03-10", "2099-03-17");
    await syncTripsForPhone(ana.ownerId, ana.phone);
    const [first] = openTripQuestions(ana.ownerId, ana.phone);
    const oldQuestion = { startDate: first.startDate, endDate: first.endDate };

    flight(ana.ownerId, "2099-03-18");
    await syncTripsForPhone(ana.ownerId, ana.phone);
    expect(asks).toHaveBeenCalledTimes(2);
    const [second] = openTripQuestions(ana.ownerId, ana.phone);
    expect(second.tripKey).toBe(String(stay.id));
    expect(second.endDate).toBe("2099-03-18");
    expect(answerTripQuestion(ana.ownerId, ana.phone, second.tripKey, "dates", oldQuestion)).toEqual({
      ok: false,
      reason: "stale",
    });
  });

  it("does not treat a lone one-way flight as a trip", async () => {
    const { ana } = family();
    await link(ana);
    flight(ana.ownerId, "2099-03-10");
    await syncTripsForPhone(ana.ownerId, ana.phone);
    expect(asks).not.toHaveBeenCalled();
    expect(listFamilyTrips(ana.ownerId, ana.phone)).toEqual([]);
  });

  it("asks nothing and shares nothing with trips off, or before linking", async () => {
    const { ana } = family();
    hotel(ana.ownerId, "2099-03-10", "2099-03-17");
    await syncTripsForPhone(ana.ownerId, ana.phone);
    await link(ana, { tripsMode: "off" });
    await syncTripsForPhone(ana.ownerId, ana.phone);
    expect(asks).not.toHaveBeenCalled();
  });
});

describe("automatic sharing and the country switch", () => {
  it("shares at once without the country, adds it when switched on and takes it off again", async () => {
    const { ana, asBen } = family();
    await link(ana, { tripsMode: "auto" });
    hotel(ana.ownerId, "2099-03-10", "2099-03-17");
    await syncTripsForPhone(ana.ownerId, ana.phone);
    expect(asks).not.toHaveBeenCalled();
    expect(whoIsAway(asBen(), "2099-03-01", "2099-03-31")).toContain("Ana is away 10 Mar–17 Mar.");

    updateLinkSettings(ana.ownerId, ana.phone, { tripsCountry: true });
    expect(whoIsAway(asBen(), "2099-03-01", "2099-03-31")).toContain("(Portugal)");

    updateLinkSettings(ana.ownerId, ana.phone, { tripsCountry: false });
    expect(whoIsAway(asBen(), "2099-03-01", "2099-03-31")).not.toContain("Portugal");
    expect(whoIsAway(asBen(), "2099-03-01", "2099-03-31")).toContain("Ana is away 10 Mar–17 Mar.");
  });

  it("switching trips off takes back what was shared", async () => {
    const { ana, asBen } = family();
    await link(ana, { tripsMode: "auto" });
    hotel(ana.ownerId, "2099-03-10", "2099-03-17");
    await syncTripsForPhone(ana.ownerId, ana.phone);
    updateLinkSettings(ana.ownerId, ana.phone, { tripsMode: "off" });
    expect(whoIsAway(asBen(), "2099-03-01", "2099-03-31")).toContain("Nothing is shared for Ana");
    expect(listShared(ana.ownerId, ana.phone)).toEqual([]);
    expect(listFamilyTrips(ana.ownerId, ana.phone)).toEqual([]);
  });

  it("a cancelled booking takes the trip down", async () => {
    const { ana, asBen } = family();
    await link(ana, { tripsMode: "auto" });
    const stay = hotel(ana.ownerId, "2099-03-10", "2099-03-17");
    await syncTripsForPhone(ana.ownerId, ana.phone);
    const { deleteEntity } = await import("../db/store.js");
    deleteEntity(ana.ownerId, stay.id);
    await syncTripsForPhone(ana.ownerId, ana.phone);
    expect(whoIsAway(asBen(), "2099-03-01", "2099-03-31")).toContain("Nothing is shared for Ana");
  });
});

describe("when the link ends", () => {
  it("unlinking removes trips, even when notes are kept", async () => {
    const { ana, asBen } = family();
    await link(ana, { tripsMode: "auto" });
    hotel(ana.ownerId, "2099-03-10", "2099-03-17");
    await syncTripsForPhone(ana.ownerId, ana.phone);
    unlinkFromFamily(ana.ownerId, ana.phone, false);
    expect(whoIsAway(asBen(), "2099-03-01", "2099-03-31")).toContain("Nothing is shared for Ana");
  });

  it("leaving the family removes trips from the family's file", async () => {
    const { ana, ben } = family();
    await link(ana, { tripsMode: "auto" });
    hotel(ana.ownerId, "2099-03-10", "2099-03-17");
    await syncTripsForPhone(ana.ownerId, ana.phone);
    requestLeave(ana.phone);
    handlePendingLeave(ana.phone, "confirm cancel");
    expect(whoIsAway(openFamilySessionForPhone(ben.phone)!, "2099-03-01", "2099-03-31")).not.toContain("is away");
  });
});

describe("availability", () => {
  const meeting = (start: string, end: string): CalendarEvent => ({
    id: "e",
    accountId: 1,
    accountEmail: "a@example.com",
    provider: "google",
    title: "Secret clinic appointment",
    start,
    end,
  });

  async function linked() {
    const f = family();
    await link(f.ana);
    return f;
  }

  it("is free when nothing clashes", async () => {
    const { ana } = await linked();
    events.mockResolvedValue({ events: [], complete: true });
    expect(await resolveAvailability(ana.phone, "2099-08-14", "2099-08-21", "Europe/London")).toEqual({ status: "free" });
  });

  it("is free except the days that clash, and never says why", async () => {
    const { ana, asBen } = await linked();
    events.mockResolvedValue({
      events: [meeting("2099-08-16T10:00:00+01:00", "2099-08-16T11:00:00+01:00")],
      complete: true,
    });
    expect(await resolveAvailability(ana.phone, "2099-08-14", "2099-08-21", "Europe/London")).toEqual({
      status: "free_except",
      busyDates: ["2099-08-16"],
    });
    const said = await checkAvailability(asBen(), "2099-08-14", "2099-08-21");
    expect(said).toContain("Ana: free except 16 Aug.");
    expect(said).not.toContain("Secret clinic");
  });

  it("is busy when every day clashes", async () => {
    const { ana } = await linked();
    events.mockResolvedValue({ events: [meeting("2099-08-14", "2099-08-16")], complete: true });
    expect(await resolveAvailability(ana.phone, "2099-08-14", "2099-08-15", "Europe/London")).toEqual({ status: "busy" });
  });

  it("counts trip days as clashes even when the trip was declined", async () => {
    const { ana } = await linked();
    hotel(ana.ownerId, "2099-08-18", "2099-08-19");
    await syncTripsForPhone(ana.ownerId, ana.phone);
    const [open] = openTripQuestions(ana.ownerId, ana.phone);
    answerTripQuestion(ana.ownerId, ana.phone, open.tripKey, "no");
    events.mockResolvedValue({ events: [], complete: true });
    expect(await resolveAvailability(ana.phone, "2099-08-14", "2099-08-21", "Europe/London")).toEqual({
      status: "free_except",
      busyDates: ["2099-08-18", "2099-08-19"],
    });
  });

  it("is not sure when the calendar couldn't be read, availability is off, or the link isn't there", async () => {
    const { ana, ben } = await linked();
    events.mockResolvedValue({ events: [], complete: false });
    expect(await resolveAvailability(ana.phone, "2099-08-14", "2099-08-21", "UTC")).toEqual({ status: "not_sure" });

    events.mockResolvedValue({ events: [], complete: true });
    updateLinkSettings(ana.ownerId, ana.phone, { availabilityOn: false });
    expect(await resolveAvailability(ana.phone, "2099-08-14", "2099-08-21", "UTC")).toEqual({ status: "not_sure" });
    expect(await resolveAvailability(ben.phone, "2099-08-14", "2099-08-21", "UTC")).toEqual({ status: "not_sure" });
    expect(await resolveAvailability("447000000000", "2099-08-14", "2099-08-21", "UTC")).toEqual({ status: "not_sure" });
  });

  it("reads the same to Joyce whether someone has no Marlo, has it off, or the read failed", async () => {
    const { ana, asBen } = await linked();
    events.mockResolvedValue({ events: [], complete: false });
    const failed = await checkAvailability(asBen(), "2099-08-14", "2099-08-21");
    events.mockResolvedValue({ events: [], complete: true });
    updateLinkSettings(ana.ownerId, ana.phone, { availabilityOn: false });
    const off = await checkAvailability(asBen(), "2099-08-14", "2099-08-21");
    unlinkFromFamily(ana.ownerId, ana.phone, false);
    const none = await checkAvailability(asBen(), "2099-08-14", "2099-08-21");
    expect(off).toBe(failed);
    expect(none).toBe(failed);
    expect(failed).toContain("I'm not sure about Ana.");
  });
});
