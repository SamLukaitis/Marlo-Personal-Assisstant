import { afterEach, describe, expect, it } from "vitest";
import { createFamily, joinFamilyByCode } from "./registry.js";
import { openFamilySessionForNewMember, openFamilySessionForPhone } from "./familyDb.js";
import { setMemberName } from "./store.js";
import { setFamilyHooks } from "./hooks.js";
import { deleteMemberTrip, saveMemberTrip, updateMemberTrip } from "./trips.js";
import { TRIP_TOOLS, checkAvailability, runTripTool, whoIsAway } from "./tripTools.js";

let counter = 0;
function twoMembers() {
  counter += 1;
  const a = `4479666${String(counter).padStart(4, "0")}1`;
  const b = `4479666${String(counter).padStart(4, "0")}2`;
  const created = createFamily(a);
  setMemberName(openFamilySessionForNewMember(created.family, a), "Ana");
  expect(joinFamilyByCode(b, created.joinCode).ok).toBe(true);
  setMemberName(openFamilySessionForPhone(b)!, "Ben");
  return { a, b, asA: () => openFamilySessionForPhone(a)!, asB: () => openFamilySessionForPhone(b)! };
}

afterEach(() => setFamilyHooks({}));

describe("the trip tools", () => {
  it("take dates only: no family or member argument", () => {
    for (const t of TRIP_TOOLS) {
      const props = Object.keys((t.input_schema as { properties?: object }).properties ?? {});
      expect(props.sort()).toEqual(["from", "to"]);
    }
  });

  it("refuse dates that aren't dates, run backwards, or span too long", async () => {
    const { asA } = twoMembers();
    for (const name of ["who_is_away", "check_availability"]) {
      expect(await runTripTool(asA(), name, { from: "next week", to: "later" })).toMatch(/YYYY-MM-DD/);
      expect(await runTripTool(asA(), name, { from: "2099-08-20", to: "2099-08-10" })).toMatch(/before/);
      expect(await runTripTool(asA(), name, { from: "2099-01-01", to: "2099-06-01" })).toMatch(/more than 31 days/);
    }
  });
});

describe("who_is_away", () => {
  it("lists shared trips that overlap, with the country only if one was stored, and names everyone else", () => {
    const { asA, asB } = twoMembers();
    saveMemberTrip(asA(), { startDate: "2099-03-10", endDate: "2099-03-17", country: null });
    const said = whoIsAway(asB(), "2099-03-15", "2099-03-20");
    expect(said).toContain("Ana is away 10 Mar–17 Mar.");
    expect(said).toContain("Nothing is shared for Ben.");
    expect(whoIsAway(asB(), "2099-04-01", "2099-04-05")).toContain("Nothing is shared for Ana.");
  });

  it("never says nobody is away: it says nothing is shared", () => {
    const { asB } = twoMembers();
    const said = whoIsAway(asB(), "2099-03-01", "2099-03-31");
    expect(said).toContain("Nothing is shared for Ana.");
    expect(said).not.toMatch(/nobody|no one/i);
  });

  it("only ever changes or removes a trip the acting member's own Marlo shared", () => {
    const { asA, asB } = twoMembers();
    const id = saveMemberTrip(asA(), { startDate: "2099-03-10", endDate: "2099-03-17", country: "Portugal" });
    expect(updateMemberTrip(asB(), id, { startDate: "2099-04-01", endDate: "2099-04-02", country: null })).toBe(false);
    expect(deleteMemberTrip(asB(), id)).toBe(false);
    expect(whoIsAway(asB(), "2099-03-01", "2099-03-31")).toContain("Ana is away 10 Mar–17 Mar (Portugal).");
  });
});

describe("check_availability", () => {
  it("says it isn't sure about everyone when nothing is registered to answer", async () => {
    const { asA } = twoMembers();
    const said = await checkAvailability(asA(), "2099-08-14", "2099-08-21");
    expect(said).toContain("I'm not sure about Ana.");
    expect(said).toContain("I'm not sure about Ben.");
  });

  it("reports what each Marlo says, and not sure when one throws", async () => {
    const { a, b, asA } = twoMembers();
    setFamilyHooks({
      resolveAvailability: async (phone) => {
        if (phone === a) return { status: "free_except", busyDates: ["2099-08-16", "2099-08-17"] };
        if (phone === b) throw new Error("calendar down");
        return { status: "not_sure" };
      },
    });
    const said = await checkAvailability(asA(), "2099-08-14", "2099-08-21");
    expect(said).toContain("Ana: free except 16 Aug, 17 Aug.");
    expect(said).toContain("I'm not sure about Ben.");
  });
});
