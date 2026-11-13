import { describe, it, expect } from "vitest";
import { normalizeEventTimes, describeEventTimeForUser } from "./calendarTime.js";

const create = { requireStart: true };
const update = { requireStart: false };

describe("normalizeEventTimes", () => {
  // The bug: the model passes the clock time the user said, with no zone. Google rejected that
  // ("Missing time zone definition for start time") and Outlook read it as UTC.
  it("reads a plain clock time as the user's own local time", () => {
    expect(
      normalizeEventTimes({ start: "2026-11-14T15:00:00", end: "2026-11-14T16:00:00" }, "America/Argentina/Mendoza", create)
    ).toEqual({
      start: "2026-11-14T15:00:00",
      startTimeZone: "America/Argentina/Mendoza",
      end: "2026-11-14T16:00:00",
      endTimeZone: "America/Argentina/Mendoza",
    });
  });

  it("accepts a time without seconds", () => {
    const out = normalizeEventTimes({ start: "2026-11-14T15:00", end: "2026-11-14T16:30" }, "Europe/London", create);
    expect(out).toMatchObject({ start: "2026-11-14T15:00:00", end: "2026-11-14T16:30:00" });
  });

  it("uses the event's own timezones for somewhere else (a flight)", () => {
    expect(
      normalizeEventTimes(
        { start: "2026-09-19T17:29:00", end: "2026-09-19T20:35:00", startTimeZone: "America/Bogota", endTimeZone: "America/Lima" },
        "Europe/London",
        create
      )
    ).toEqual({
      start: "2026-09-19T17:29:00",
      startTimeZone: "America/Bogota",
      end: "2026-09-19T20:35:00",
      endTimeZone: "America/Lima",
    });
  });

  it("leaves a time that already carries Z or an offset alone", () => {
    expect(normalizeEventTimes({ start: "2026-07-23T14:00:00Z", end: "2026-07-23T15:00:00Z" }, "Europe/London", create)).toEqual({
      start: "2026-07-23T14:00:00Z",
      end: "2026-07-23T15:00:00Z",
    });
    expect(
      normalizeEventTimes({ start: "2026-07-23T14:00:00+02:00", end: "2026-07-23T15:00:00+02:00" }, null, create)
    ).toEqual({ start: "2026-07-23T14:00:00+02:00", end: "2026-07-23T15:00:00+02:00" });
  });

  it("makes a plain date an all-day event, with the end made exclusive", () => {
    expect(normalizeEventTimes({ start: "2026-12-19" }, "Europe/London", create)).toEqual({
      allDay: true,
      start: "2026-12-19",
      end: "2026-12-20",
    });
    expect(normalizeEventTimes({ start: "2026-12-19", end: "2026-12-22" }, null, create)).toEqual({
      allDay: true,
      start: "2026-12-19",
      end: "2026-12-23",
    });
  });

  it("defaults a missing end to an hour after the start", () => {
    expect(normalizeEventTimes({ start: "2026-11-14T23:30:00" }, "Europe/London", create)).toEqual({
      start: "2026-11-14T23:30:00",
      startTimeZone: "Europe/London",
      end: "2026-11-15T00:30:00",
      endTimeZone: "Europe/London",
    });
  });

  it("says so, rather than guessing, when the user's timezone isn't known", () => {
    const out = normalizeEventTimes({ start: "2026-11-14T15:00:00", end: "2026-11-14T16:00:00" }, null, create);
    expect(out).toHaveProperty("error");
    expect((out as { error: string }).error).toMatch(/timezone/);
  });

  it("rejects an end that isn't after the start, a bad timezone, and unparseable times", () => {
    expect(normalizeEventTimes({ start: "2026-11-14T15:00:00", end: "2026-11-14T03:00:00" }, "Europe/London", create)).toHaveProperty("error");
    expect(
      normalizeEventTimes({ start: "2026-11-14T15:00:00", end: "2026-11-14T16:00:00", startTimeZone: "Bogota" }, "Europe/London", create)
    ).toHaveProperty("error");
    expect(normalizeEventTimes({ start: "next Tuesday 3pm", end: "2026-11-14T16:00:00" }, "Europe/London", create)).toHaveProperty("error");
    expect(normalizeEventTimes({ start: "2026-11-14", end: "2026-11-14T16:00:00" }, "Europe/London", create)).toHaveProperty("error");
    expect(normalizeEventTimes({}, "Europe/London", create)).toHaveProperty("error");
  });

  it("compares start and end as instants across timezones", () => {
    // Departs 23:00 in Madrid, lands 22:30 the same evening in Lisbon... which is 23:30 Madrid time.
    const out = normalizeEventTimes(
      { start: "2026-11-14T23:00:00", end: "2026-11-14T22:30:00", startTimeZone: "Europe/Madrid", endTimeZone: "Europe/Lisbon" },
      "Europe/London",
      create
    );
    expect(out).not.toHaveProperty("error");
  });

  it("on an update, only touches what was passed", () => {
    expect(normalizeEventTimes({}, "Europe/London", update)).toEqual({});
    expect(normalizeEventTimes({ start: "2026-11-14T15:00:00" }, "Europe/London", update)).toEqual({
      start: "2026-11-14T15:00:00",
      startTimeZone: "Europe/London",
    });
    expect(normalizeEventTimes({ end: "2026-11-14T18:00:00" }, "Europe/London", update)).toEqual({
      end: "2026-11-14T18:00:00",
      endTimeZone: "Europe/London",
    });
  });
});

describe("describeEventTimeForUser", () => {
  it("states a saved event on the user's own clock", () => {
    expect(describeEventTimeForUser("2026-11-14T18:00:00Z", "2026-11-14T19:00:00Z", false, "America/Argentina/Mendoza")).toBe(
      "Sat 14 Nov 2026, 15:00–16:00 (America/Argentina/Mendoza time)"
    );
    expect(describeEventTimeForUser("2026-11-14T15:00:00-03:00", "2026-11-14T16:00:00-03:00", false, "Europe/London")).toBe(
      "Sat 14 Nov 2026, 18:00–19:00 (Europe/London time)"
    );
  });

  it("states an all-day event by its days, end inclusive", () => {
    expect(describeEventTimeForUser("2026-12-19", "2026-12-20", true, "Europe/London")).toBe("all day, Sat 19 Dec 2026");
    expect(describeEventTimeForUser("2026-12-19", "2026-12-23", true, null)).toBe("all day, Sat 19 Dec 2026 to Tue 22 Dec 2026");
  });
});
