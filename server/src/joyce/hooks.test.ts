import { afterEach, describe, expect, it, vi } from "vitest";
import { fireFamilyJoined, setFamilyHooks } from "./hooks.js";
import { handleOnboarding } from "./onboarding.js";
import { handlePendingLeave } from "./leaving.js";
import { createFamily, joinFamilyByCode, requestLeave } from "./registry.js";
import { openFamilySessionForNewMember, openFamilySessionForPhone } from "./familyDb.js";
import { deleteMarloweNote, saveNote, setMemberName } from "./store.js";

afterEach(() => setFamilyHooks({}));

function memberOf(phone: string, name: string) {
  const { family, joinCode } = createFamily(phone);
  setMemberName(openFamilySessionForNewMember(family, phone), name);
  return { session: openFamilySessionForPhone(phone)!, joinCode };
}

describe("family hooks", () => {
  it("never lets a failing hook break the caller", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    setFamilyHooks({
      onFamilyJoined: () => {
        throw new Error("boom");
      },
    });
    expect(() => fireFamilyJoined("15553000001")).not.toThrow();
    spy.mockRestore();
  });

  it("fires onFamilyJoined when someone starts a family", () => {
    const joined = vi.fn();
    setFamilyHooks({ onFamilyJoined: joined });
    const phone = "15553000002";
    handleOnboarding(phone, "hi");
    handleOnboarding(phone, "new");
    expect(joined).toHaveBeenCalledExactlyOnceWith(phone);
  });

  it("fires onFamilyJoined when someone joins with a code, and not on a wrong code", () => {
    const { joinCode } = memberOf("15553000003", "Ana");
    const joined = vi.fn();
    setFamilyHooks({ onFamilyJoined: joined });
    const phone = "15553000004";
    handleOnboarding(phone, "hi");
    handleOnboarding(phone, "join");
    handleOnboarding(phone, "JOY-ZZZZ-ZZZZ");
    expect(joined).not.toHaveBeenCalled();
    handleOnboarding(phone, joinCode);
    expect(joined).toHaveBeenCalledExactlyOnceWith(phone);
  });

  it("fires onFamilyLeft once a leave is confirmed, and not when it isn't", () => {
    memberOf("15553000005", "Bea");
    const left = vi.fn();
    setFamilyHooks({ onFamilyLeft: left });
    requestLeave("15553000005");
    handlePendingLeave("15553000005", "nope");
    expect(left).not.toHaveBeenCalled();
    requestLeave("15553000005");
    handlePendingLeave("15553000005", "confirm cancel");
    expect(left).toHaveBeenCalledExactlyOnceWith("15553000005");
  });
});

describe("notes handed over by Marlo", () => {
  it("can be taken back by the member who handed them over, and nothing else can", () => {
    const { session: ana, joinCode } = memberOf("15553000010", "Cy");
    expect(joinFamilyByCode("15553000011", joinCode).ok).toBe(true);
    const other = openFamilySessionForPhone("15553000011")!;

    const handed = saveNote(ana, "Builder", "01632 960000", "marlowe");
    const typed = saveNote(ana, "Wifi", "mango", undefined);
    const othersHanded = saveNote(other, "Plumber", "01632 960001", "marlowe");

    expect(deleteMarloweNote(ana, typed)).toBe(false);
    expect(deleteMarloweNote(ana, othersHanded)).toBe(false);
    expect(deleteMarloweNote(ana, handed)).toBe(true);
    expect(deleteMarloweNote(ana, handed)).toBe(false);
  });
});
