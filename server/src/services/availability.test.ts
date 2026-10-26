import { describe, expect, it } from "vitest";
import { computeAvailability, daysBetween, rangeInstants } from "./availability.js";
import type { CalendarEvent } from "../providers/types.js";

const event = (start: string, end: string, allDay = false): CalendarEvent => ({
  id: "e",
  accountId: 1,
  accountEmail: "a@example.com",
  provider: "google",
  title: "Private",
  start,
  end,
  ...(allDay ? { allDay: true } : {}),
});

const ZONE = "Europe/London";

describe("daysBetween", () => {
  it("lists every day inclusive", () => {
    expect(daysBetween("2099-08-30", "2099-09-02")).toEqual(["2099-08-30", "2099-08-31", "2099-09-01", "2099-09-02"]);
    expect(daysBetween("2099-08-30", "2099-08-30")).toEqual(["2099-08-30"]);
  });
});

describe("computeAvailability", () => {
  it("is free with nothing on", () => {
    expect(computeAvailability([], [], "2099-08-14", "2099-08-21", ZONE)).toEqual({ status: "free" });
  });

  it("lists the days that clash", () => {
    const a = computeAvailability(
      [event("2099-08-16T10:00:00+01:00", "2099-08-16T10:30:00+01:00")],
      [],
      "2099-08-14",
      "2099-08-21",
      ZONE
    );
    expect(a).toEqual({ status: "free_except", busyDates: ["2099-08-16"] });
  });

  it("uses the family's zone to decide which day an event is on", () => {
    // 23:30 UTC on the 16th is 00:30 on the 17th in London in summer.
    const a = computeAvailability([event("2099-08-16T23:30:00Z", "2099-08-17T00:00:00Z")], [], "2099-08-16", "2099-08-17", ZONE);
    expect(a).toEqual({ status: "free_except", busyDates: ["2099-08-17"] });
  });

  it("spreads an event across the days it covers, and an all-day end is exclusive", () => {
    expect(
      computeAvailability([event("2099-08-14", "2099-08-16", true)], [], "2099-08-14", "2099-08-17", ZONE)
    ).toEqual({ status: "free_except", busyDates: ["2099-08-14", "2099-08-15"] });
    expect(
      computeAvailability([event("2099-08-14T22:00:00+01:00", "2099-08-15T09:00:00+01:00")], [], "2099-08-14", "2099-08-16", ZONE)
    ).toEqual({ status: "free_except", busyDates: ["2099-08-14", "2099-08-15"] });
  });

  it("an event ending at midnight does not touch the next day", () => {
    expect(
      computeAvailability([event("2099-08-14T20:00:00+01:00", "2099-08-15T00:00:00+01:00")], [], "2099-08-14", "2099-08-15", ZONE)
    ).toEqual({ status: "free_except", busyDates: ["2099-08-14"] });
  });

  it("counts trip days, and is busy when every day clashes", () => {
    expect(
      computeAvailability([], [{ startDate: "2099-08-14", endDate: "2099-08-15" }], "2099-08-14", "2099-08-15", ZONE)
    ).toEqual({ status: "busy" });
    expect(
      computeAvailability([], [{ startDate: "2099-08-10", endDate: "2099-08-14" }], "2099-08-14", "2099-08-16", ZONE)
    ).toEqual({ status: "free_except", busyDates: ["2099-08-14"] });
  });

  it("ignores events outside the range, and carries nothing but dates", () => {
    const a = computeAvailability([event("2099-09-01T10:00:00Z", "2099-09-01T11:00:00Z")], [], "2099-08-14", "2099-08-21", ZONE);
    expect(a).toEqual({ status: "free" });
    const b = computeAvailability([event("2099-08-16T10:00:00Z", "2099-08-16T11:00:00Z")], [], "2099-08-14", "2099-08-21", ZONE);
    expect(JSON.stringify(b)).not.toContain("Private");
  });
});

describe("rangeInstants", () => {
  it("runs from the start of the first day to the end of the last, in the zone", () => {
    const { start, end } = rangeInstants("2099-08-14", "2099-08-15", ZONE);
    expect(start.toISOString()).toBe("2099-08-13T23:00:00.000Z");
    expect(end.toISOString()).toBe("2099-08-15T23:00:00.000Z");
  });
});
