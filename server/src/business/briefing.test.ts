import { describe, it, expect } from "vitest";
import { findOrCreateUserByEmail, setUserEdition } from "../db/store.js";
import { businessBriefingFacts } from "./briefing.js";
import { editionBriefingFacts } from "../editions/index.js";
import { insertLedgerEntry } from "./ledgerStore.js";
import { briefingFactBlock, isQuietDay, type BriefingDay } from "../services/briefing.js";

let n = 0;
const user = (edition: "general" | "business") => {
  const u = findOrCreateUserByEmail(`brief-${Date.now()}-${++n}@example.com`);
  setUserEdition(u.id, edition);
  return u.id;
};

describe("businessBriefingFacts", () => {
  it("on Mondays summarises last week; any day mentions items to check", () => {
    const id = user("business");
    insertLedgerEntry(id, {
      direction: "in",
      amountPence: 124000,
      occurredOn: "2026-10-07",
      counterparty: "Dave",
      businessUse: "business",
      status: "confirmed",
      source: "chat",
    });
    insertLedgerEntry(id, {
      direction: "out",
      amountPence: 4820,
      occurredOn: "2026-10-08",
      counterparty: "Screwfix",
      businessUse: "unsure",
      status: "needs_review",
      source: "chat",
    });
    const monday = businessBriefingFacts(id, "2026-10-12").join("\n");
    expect(monday).toContain("£1,240.00 in");
    expect(monday).toContain("1 entry needs a quick check");
    const tuesday = businessBriefingFacts(id, "2026-10-13").join("\n");
    expect(tuesday).not.toContain("£1,240.00");
    expect(tuesday).toContain("1 entry needs a quick check");
  });

  it("is empty for a quiet business user and for general users", () => {
    expect(businessBriefingFacts(user("business"), "2026-10-13")).toEqual([]);
    expect(editionBriefingFacts(user("general"), "2026-10-12")).toEqual([]);
  });
});

describe("briefing extra facts", () => {
  const day = (extraFacts?: string[]) =>
    ({
      localTime: "07:30",
      localWeekday: "Monday",
      location: "",
      weather: null,
      quotes: [],
      unread: { count: 0, shown: [] },
      todayEvents: [],
      upcomingEvents: [],
      flagged: [],
      news: [],
      extraFacts,
    }) as BriefingDay;

  it("are included in the fact block", () => {
    expect(briefingFactBlock(day(["Business money last week: £10.00 in, £0.00 out."]))).toContain("Business money last week");
  });

  it("stop the day counting as quiet", () => {
    expect(isQuietDay(day())).toBe(true);
    expect(isQuietDay(day(["1 entry needs a quick check"]))).toBe(false);
  });
});
