import { describe, it, expect } from "vitest";
import {
  findOrCreateUserByEmail,
  insertPhoneAction,
  getPhoneActionByCodeHash,
  updatePhoneAction,
  listStalledPhoneActions,
  listRecentFinishedPhoneActions,
  getShortcutStatus,
  recordShortcutSeen,
  setShortcutKnownProblems,
  deleteUserCompletely,
} from "./store.js";

let n = 0;
const user = () => findOrCreateUserByEmail(`phone-store-${Date.now()}-${++n}@example.com`);

function insert(ownerId: number, codeHash: string, now = 1_000) {
  return insertPhoneAction({
    ownerId, codeHash, source: "chat", phone: null, label: "Test",
    steps: [{ type: "get_battery" }], createdAt: now, expiresAt: now + 60_000,
  });
}

describe("phone_actions", () => {
  it("round-trips a row by code hash", () => {
    const u = user();
    const id = insert(u.id, `hash-${n}-a`);
    const row = getPhoneActionByCodeHash(`hash-${n}-a`)!;
    expect(row).toMatchObject({ id, ownerId: u.id, status: "offered", steps: [{ type: "get_battery" }], results: [], fetchedAt: null });
    expect(getPhoneActionByCodeHash("nope")).toBeNull();
  });

  it("updates status/results and lists stalled fetched rows", () => {
    const u = user();
    const id = insert(u.id, `hash-${n}-b`);
    updatePhoneAction(id, { status: "fetched", fetchedAt: 2_000, version: 1 });
    expect(listStalledPhoneActions(3_000).map((r) => r.id)).toContain(id);
    expect(listStalledPhoneActions(1_500).map((r) => r.id)).not.toContain(id);
    updatePhoneAction(id, { status: "done", finishedAt: 2_500, results: [{ index: 0, ok: true, value: 80, at: 2_400 }] });
    expect(listStalledPhoneActions(3_000).map((r) => r.id)).not.toContain(id);
    expect(listRecentFinishedPhoneActions(u.id, 2_000)[0]).toMatchObject({ id, results: [{ index: 0, ok: true, value: 80 }] });
  });
});

describe("phone_shortcut_status", () => {
  it("records first/last seen and known problems", () => {
    const u = user();
    expect(getShortcutStatus(u.id)).toBeNull();
    recordShortcutSeen(u.id, 1, 100);
    recordShortcutSeen(u.id, 2, 200);
    expect(getShortcutStatus(u.id)).toMatchObject({ version: 2, firstSeen: 100, lastSeen: 200, knownProblems: [] });
    setShortcutKnownProblems(u.id, [{ type: "focus", detail: "turn Work Focus on", error: "not found", at: 150 }]);
    expect(getShortcutStatus(u.id)!.knownProblems).toHaveLength(1);
  });

  it("deleteUserCompletely removes both tables' rows", () => {
    const u = user();
    insert(u.id, `hash-${n}-c`);
    recordShortcutSeen(u.id, 1, 100);
    deleteUserCompletely(u.id);
    expect(getPhoneActionByCodeHash(`hash-${n}-c`)).toBeNull();
    expect(getShortcutStatus(u.id)).toBeNull();
  });
});
