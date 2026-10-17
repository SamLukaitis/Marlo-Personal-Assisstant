import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { handleOnboarding } from "./onboarding.js";
import { openFamilySessionForPhone, type FamilySession } from "./familyDb.js";
import { getFamilyZone, parseLocal, setFamilyZone } from "./familyTime.js";
import { addEvent, findClashes, getFamilyJoinCode, listEventsBetween, setMemberName, type NewEvent } from "./store.js";
import { buildCalendarFeed, calendarFeedUrl } from "./calendarFeed.js";
import { issueCalendarToken } from "./registry.js";
import { joyceRoutes } from "./routes.js";

let n = 0;
/** A new family with one named member; returns their session and phone. */
function family(name = "Ana", phone?: string): { session: FamilySession; phone: string } {
  n += 1;
  const p = phone ?? `4477009${String(n).padStart(5, "0")}`;
  handleOnboarding(p, "hi");
  const outcome = handleOnboarding(p, "new");
  if (!outcome.done) throw new Error("no family");
  setMemberName(outcome.session, name);
  return { session: openFamilySessionForPhone(p)!, phone: p };
}

/** A second member joined to `owner`'s family. */
function join(ownerSession: FamilySession, name: string): FamilySession {
  n += 1;
  const p = `4477008${String(n).padStart(5, "0")}`;
  const code = getCode(ownerSession);
  handleOnboarding(p, "hi");
  handleOnboarding(p, code);
  const s = openFamilySessionForPhone(p)!;
  setMemberName(s, name);
  return openFamilySessionForPhone(p)!;
}

const getCode = (s: FamilySession) => getFamilyJoinCode(s)!;

const event = (overrides: Partial<NewEvent>): NewEvent => ({
  title: "Dentist",
  allDay: false,
  startsAt: Date.UTC(2026, 10, 3, 15),
  endsAt: Date.UTC(2026, 10, 3, 16),
  aboutMemberId: null,
  ...overrides,
});

describe("the family timezone", () => {
  it("is guessed from a UK number as Europe/London, and marked as a guess", () => {
    const { session, phone } = family();
    expect(getFamilyZone(session, phone)).toEqual({ zone: "Europe/London", guessed: true });
    // Stored, so it doesn't depend on who's asking next time.
    expect(getFamilyZone(session)).toEqual({ zone: "Europe/London", guessed: true });
  });

  it("only accepts city timezones, never UTC or GMT", () => {
    const { session } = family();
    for (const bad of ["UTC", "GMT", "Etc/GMT+1", "Nowhere/Special", ""]) {
      expect(setFamilyZone(session, bad)).toBe(false);
    }
    expect(setFamilyZone(session, "America/New_York")).toBe(true);
    expect(getFamilyZone(session)).toEqual({ zone: "America/New_York", guessed: false });
  });

  it("reads local times in the family's zone, including summer time", () => {
    const summer = parseLocal("2026-07-01T09:00", "Europe/London");
    const winter = parseLocal("2026-01-15T09:00", "Europe/London");
    expect(summer).toEqual({ allDay: false, utcMs: Date.UTC(2026, 6, 1, 8) });
    expect(winter).toEqual({ allDay: false, utcMs: Date.UTC(2026, 0, 15, 9) });
    expect(parseLocal("2026-07-01", "Europe/London")).toEqual({
      allDay: true,
      date: "2026-07-01",
      utcMs: Date.UTC(2026, 5, 30, 23),
    });
    // Always local: a UTC timestamp is refused rather than silently reinterpreted.
    expect(parseLocal("2026-07-01T09:00Z", "Europe/London")).toBeNull();
    expect(parseLocal("2026-02-30", "Europe/London")).toBeNull();
  });
});

describe("the family calendar", () => {
  it("finds events in a range, including all-day ones spanning it", () => {
    const { session } = family();
    addEvent(session, event({ title: "Dentist" }));
    addEvent(
      session,
      event({
        title: "Half term",
        allDay: true,
        startDate: "2026-10-26",
        endDate: "2026-10-30",
        startsAt: Date.UTC(2026, 9, 26),
        endsAt: Date.UTC(2026, 9, 31),
      })
    );
    const oct28 = listEventsBetween(session, Date.UTC(2026, 9, 28), Date.UTC(2026, 9, 29));
    expect(oct28.map((e) => e.title)).toEqual(["Half term"]);
    const nov3 = listEventsBetween(session, Date.UTC(2026, 10, 3), Date.UTC(2026, 10, 4));
    expect(nov3.map((e) => e.title)).toEqual(["Dentist"]);
  });

  it("reports clashes for the same person or the whole family, not for someone else", () => {
    const owner = family("Priya");
    const sam = join(owner.session, "Sam");
    addEvent(owner.session, event({ title: "Priya's dentist", aboutMemberId: owner.session.actor.id }));

    const samAtSameTime = findClashes(owner.session, Date.UTC(2026, 10, 3, 15, 30), Date.UTC(2026, 10, 3, 16, 30), { memberId: sam.actor.id, name: "Sam" });
    expect(samAtSameTime).toEqual([]);
    const priyaAtSameTime = findClashes(owner.session, Date.UTC(2026, 10, 3, 15, 30), Date.UTC(2026, 10, 3, 16, 30), { memberId: owner.session.actor.id, name: "Priya" });
    expect(priyaAtSameTime.map((e) => e.title)).toEqual(["Priya's dentist"]);
    const everyoneAtSameTime = findClashes(owner.session, Date.UTC(2026, 10, 3, 15, 30), Date.UTC(2026, 10, 3, 16, 30), { memberId: null, name: null });
    expect(everyoneAtSameTime.map((e) => e.title)).toEqual(["Priya's dentist"]);
    // Back to back isn't a clash.
    expect(findClashes(owner.session, Date.UTC(2026, 10, 3, 16), Date.UTC(2026, 10, 3, 17), { memberId: null, name: null })).toEqual([]);
  });
});

describe("events for someone who isn't a member", () => {
  it("keeps the name, shows it, and checks clashes against the same name", () => {
    const { session } = family("Nia");
    addEvent(session, event({ title: "Dentist", aboutMemberId: null, aboutLabel: "Leo" }));
    const [stored] = listEventsBetween(session, Date.UTC(2026, 10, 3), Date.UTC(2026, 10, 4));
    expect(stored.aboutName).toBe("Leo");
    const overlap = [Date.UTC(2026, 10, 3, 15, 30), Date.UTC(2026, 10, 3, 16, 30)] as const;
    expect(findClashes(session, ...overlap, { memberId: null, name: "leo" }).map((e) => e.title)).toEqual(["Dentist"]);
    expect(findClashes(session, ...overlap, { memberId: null, name: "Maya" })).toEqual([]);
    expect(buildCalendarFeed(session)).toContain("SUMMARY:Leo: Dentist");
  });
});

describe("the calendar subscription feed", () => {
  it("is a valid iCalendar file with the family's events", () => {
    const { session } = family("Leo");
    addEvent(session, event({ title: "Dentist, check-up", aboutMemberId: session.actor.id, notes: "Bring card" }));
    addEvent(
      session,
      event({ title: "Half term", allDay: true, startDate: "2026-10-26", endDate: "2026-10-30", startsAt: 0, endsAt: 1 })
    );
    const ics = buildCalendarFeed(session);
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain("SUMMARY:Leo: Dentist\\, check-up");
    expect(ics).toContain("DTSTART:20261103T150000Z");
    expect(ics).toContain("DTEND:20261103T160000Z");
    // All-day end is the day after the last day.
    expect(ics).toContain("DTSTART;VALUE=DATE:20261026");
    expect(ics).toContain("DTEND;VALUE=DATE:20261031");
    expect(ics).toContain("DESCRIPTION:Bring card\\nAdded by Leo");
    for (const line of ics.split("\r\n")) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    // Nothing internal leaks into a file that gets shared around.
    expect(ics).not.toContain(session.familyId);
  });

  it("is served at the family's secret link, and an old link stops working on reset", async () => {
    const { session, phone } = family("Mo");
    addEvent(session, event({ title: "Swimming" }));
    const app = express().use(joyceRoutes);

    const first = issueCalendarToken(phone)!;
    const ok = await request(app).get(`/joyce/calendar/${first}.ics`);
    expect(ok.status).toBe(200);
    expect(ok.headers["content-type"]).toContain("text/calendar");
    expect(ok.text).toContain("SUMMARY:Swimming");
    expect(calendarFeedUrl(first)).toMatch(new RegExp(`/joyce/calendar/${first}\\.ics$`));

    const second = issueCalendarToken(phone)!;
    expect((await request(app).get(`/joyce/calendar/${first}.ics`)).status).toBe(404);
    expect((await request(app).get(`/joyce/calendar/${second}.ics`)).status).toBe(200);
    expect((await request(app).get(`/joyce/calendar/not-a-real-link-at-all-xx.ics`)).status).toBe(404);
  });
});
