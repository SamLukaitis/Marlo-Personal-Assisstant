import { describe, it, expect } from "vitest";
import {
  extractFlightNumbers,
  extractReferenceCodes,
  extractDates,
  containsDenial,
  dateAppearsInReply,
  gradeReply,
} from "./grading.js";

describe("extractFlightNumbers", () => {
  it("finds a flight-number-shaped token", () => {
    expect(extractFlightNumbers("Update on your flight DL1234 to Berlin")).toEqual(["DL1234"]);
  });

  it("ignores tokens shorter than a real flight number", () => {
    expect(extractFlightNumbers("AA1 is mentioned right here")).toEqual([]);
  });

  it("returns an empty array when none are present", () => {
    expect(extractFlightNumbers("Your Amazon order has shipped")).toEqual([]);
  });
});

describe("extractReferenceCodes", () => {
  it("finds a reference-code-shaped token (letters + digits mixed)", () => {
    expect(extractReferenceCodes("Your trip is confirmed, ref K4X9QP, departing soon.")).toEqual(["K4X9QP"]);
  });

  it("ignores plain all-letter words", () => {
    expect(extractReferenceCodes("PLEASE confirm ASAP")).toEqual([]);
  });

  it("ignores plain all-digit numbers", () => {
    expect(extractReferenceCodes("order 123456 shipped")).toEqual([]);
  });
});

describe("extractDates", () => {
  it("finds an ISO date", () => {
    expect(extractDates("Departing 2026-09-12 from JFK")).toEqual(["2026-09-12"]);
  });

  it("normalizes 'Month D, YYYY' prose to ISO", () => {
    expect(extractDates("Departing September 12, 2026 from JFK")).toEqual(["2026-09-12"]);
  });

  it("normalizes 'D Month YYYY' prose to ISO", () => {
    expect(extractDates("Departing 12 September 2026 from JFK")).toEqual(["2026-09-12"]);
  });

  it("normalizes an abbreviated month name", () => {
    expect(extractDates("Departing Sep 12, 2026 from JFK")).toEqual(["2026-09-12"]);
  });

  it("returns an empty array when there is no date", () => {
    expect(extractDates("Departing soon from JFK")).toEqual([]);
  });
});

describe("dateAppearsInReply", () => {
  it("matches the exact ISO date", () => {
    expect(dateAppearsInReply("2026-09-05", "on 2026-09-05 you have an appointment")).toBe(true);
  });

  it("matches a full prose date with an ordinal suffix", () => {
    expect(dateAppearsInReply("2026-10-03", "check-in on October 3rd, 2026")).toBe(true);
  });

  it("matches a month + day with the year omitted", () => {
    expect(dateAppearsInReply("2026-09-05", "Sep 5, 9:00-9:30 AM — Dentist appointment")).toBe(true);
  });

  it("matches the informal 'Sept' abbreviation", () => {
    expect(dateAppearsInReply("2026-09-05", "Dentist appointment on Sept 5, 9:00-9:30am")).toBe(true);
  });

  it("matches 'Weekday, Month D' with no year", () => {
    expect(dateAppearsInReply("2026-09-05", "Saturday, September 5 at 9:00 AM")).toBe(true);
  });

  it("does not match when the year is present but wrong", () => {
    expect(dateAppearsInReply("2026-09-05", "September 5, 2027 at 9:00 AM")).toBe(false);
  });

  it("does not match an unrelated date", () => {
    expect(dateAppearsInReply("2026-09-05", "October 3rd, 2026")).toBe(false);
  });
});

describe("containsDenial", () => {
  it("detects a denial phrase", () => {
    expect(containsDenial("I couldn't find any booking matching that.")).toBe(true);
  });

  it("detects another denial phrasing", () => {
    expect(containsDenial("There's no record of that reservation on your calendar.")).toBe(true);
  });

  it("does not flag a normal factual answer that happens to contain 'no'", () => {
    expect(containsDenial("No rush — your flight DL1234 departs 2026-09-12 as planned.")).toBe(false);
  });

  it("does not flag an unrelated reply", () => {
    expect(containsDenial("Sure, I've added that to your calendar.")).toBe(false);
  });

  it("does not flag a harmless 'there's no' aside next to a correctly stated fact", () => {
    expect(
      containsDenial(
        "Delta emailed a change: flight DL4471 has been rescheduled to depart on 2026-09-12. There's no matching booking record saved yet for it."
      )
    ).toBe(false);
  });
});

describe("gradeReply", () => {
  const groundTruth = { flightNumbers: ["DL1234"], referenceCodes: ["K4X9QP"], dates: ["2026-09-12"] };

  it("passes when every expected identifier is present and nothing else is invented", () => {
    const reply = "Your flight DL1234 (ref K4X9QP) departs 2026-09-12.";
    const result = gradeReply(groundTruth, reply);
    expect(result.pass).toBe(true);
    expect(result.missingFacts).toEqual([]);
    expect(result.deniedFacts).toBe(false);
    expect(result.inventedIdentifiers).toEqual([]);
  });

  it("fails and lists missing facts when an expected identifier is absent", () => {
    const reply = "Your flight DL1234 departs soon.";
    const result = gradeReply(groundTruth, reply);
    expect(result.pass).toBe(false);
    expect(result.missingFacts).toEqual(["K4X9QP", "2026-09-12"]);
  });

  it("fails when the reply denies the fact exists, even if it also lists identifiers elsewhere", () => {
    const reply = "I don't see any booking with that reference on file.";
    const result = gradeReply(groundTruth, reply);
    expect(result.pass).toBe(false);
    expect(result.deniedFacts).toBe(true);
  });

  it("fails and flags an invented identifier that doesn't match ground truth", () => {
    const reply = "Your flight AA9999 (ref K4X9QP) departs 2026-09-12.";
    const result = gradeReply(groundTruth, reply);
    expect(result.pass).toBe(false);
    expect(result.inventedIdentifiers).toEqual(["AA9999"]);
  });

  it("passes when the expected date is present in prose form rather than ISO", () => {
    const reply = "Your flight DL1234 (ref K4X9QP) departs September 12, 2026.";
    const result = gradeReply(groundTruth, reply);
    expect(result.pass).toBe(true);
  });

  it("passes with no missing facts when ground truth has no identifiers to check", () => {
    const result = gradeReply({}, "Sure, here's the weather for London.");
    expect(result.pass).toBe(true);
  });
});
