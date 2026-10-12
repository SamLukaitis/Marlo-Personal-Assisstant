import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./phoneActionFollowups.js", () => ({ handleFinishedPhoneAction: vi.fn(async () => {}) }));

process.env.MARLOWE_SHORTCUT_ICLOUD_URL = "https://www.icloud.com/shortcuts/test";
const { handleFinishedPhoneAction } = await import("./phoneActionFollowups.js");
const pa = await import("./phoneActions.js");
const { findOrCreateUserByEmail, getPhoneActionByCodeHash, getShortcutStatus } = await import("../db/store.js");

let n = 0;
const user = () => findOrCreateUserByEmail(`phone-svc-${Date.now()}-${++n}@example.com`);
const T0 = 1_700_000_000_000;

function make(ownerId: number, steps = [{ type: "alarm", time: "05:15" }, { type: "get_battery" }] as const) {
  return pa.createPhoneAction(ownerId, [...steps] as never, { source: "chat", label: "Test", ttlMs: pa.CHAT_TTL_MS, now: T0 });
}

beforeEach(() => vi.mocked(handleFinishedPhoneAction).mockClear());

describe("createPhoneAction", () => {
  it("stores only the hash and returns the page url + summary", () => {
    const u = user();
    const { code, url, summary } = make(u.id);
    expect(code).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(url).toMatch(new RegExp(`/a/${code}$`));
    expect(summary).toEqual(["set an alarm for 05:15", "send Marlowe your battery level"]);
    const row = getPhoneActionByCodeHash(pa.hashCode(code))!;
    expect(row.codeHash).not.toContain(code);
    expect(row.expiresAt).toBe(T0 + pa.CHAT_TTL_MS);
  });

  it("caps expiry at notAfter", () => {
    const u = user();
    const { code } = pa.createPhoneAction(u.id, [{ type: "get_battery" }], {
      source: "briefing", label: "x", ttlMs: pa.PROACTIVE_TTL_MS, notAfter: T0 + 1000, now: T0,
    });
    expect(getPhoneActionByCodeHash(pa.hashCode(code))!.expiresAt).toBe(T0 + 1000);
  });

  it("run url carries the fetch url as Shortcut input", () => {
    expect(pa.shortcutRunUrl("abc")).toBe(
      `shortcuts://run-shortcut?name=Marlowe&input=text&text=${encodeURIComponent(pa.actionFetchUrl("abc"))}`
    );
  });
});

describe("fetchPhoneAction", () => {
  it("hands over the steps once, records the Shortcut version, then says gone", () => {
    const u = user();
    const { code } = make(u.id);
    const first = pa.fetchPhoneAction(code, 1, T0 + 1);
    expect(first).toMatchObject({ kind: "steps", steps: [{ type: "alarm", time: "05:15" }, { type: "get_battery" }] });
    expect(getShortcutStatus(u.id)).toMatchObject({ version: 1, lastSeen: T0 + 1 });
    expect(pa.fetchPhoneAction(code, 1, T0 + 2)).toMatchObject({ kind: "gone", message: expect.stringMatching(/already used/) });
  });

  it("is gone when expired or unknown", () => {
    const u = user();
    const { code } = make(u.id);
    expect(pa.fetchPhoneAction(code, 1, T0 + pa.CHAT_TTL_MS + 1)).toMatchObject({ kind: "gone", message: expect.stringMatching(/expired/) });
    expect(pa.fetchPhoneAction("unknown-code", 1, T0)).toMatchObject({ kind: "gone" });
  });

  it("asks an old Shortcut to update without using up the code", () => {
    const u = user();
    const { code } = make(u.id);
    expect(pa.fetchPhoneAction(code, 0, T0 + 1)).toMatchObject({ kind: "update", installUrl: "https://www.icloud.com/shortcuts/test" });
    expect(pa.fetchPhoneAction(code, 1, T0 + 2)).toMatchObject({ kind: "steps" });
  });
});

describe("viewPhoneAction", () => {
  it("page view does not consume the code", () => {
    const u = user();
    const { code } = make(u.id);
    expect(pa.viewPhoneAction(code, T0 + 1)).toMatchObject({ state: "ready", label: "Test" });
    expect(pa.viewPhoneAction(code, T0 + 2)).toMatchObject({ state: "ready" });
    expect(pa.fetchPhoneAction(code, 1, T0 + 3)).toMatchObject({ kind: "steps" });
    expect(pa.viewPhoneAction(code, T0 + 4)).toMatchObject({ state: "gone" });
  });
});

describe("reportPhoneStep", () => {
  function fetched(ownerId: number) {
    const { code } = make(ownerId);
    pa.fetchPhoneAction(code, 1, T0);
    return code;
  }

  it("rejects reports before fetch, after the window, and with bad bodies", async () => {
    const u = user();
    const { code } = make(u.id);
    expect(await pa.reportPhoneStep(code, { index: 0, ok: true }, T0)).toBe("gone");
    const code2 = fetched(u.id);
    expect(await pa.reportPhoneStep(code2, { index: 5, ok: true }, T0 + 1)).toBe("bad_request");
    expect(await pa.reportPhoneStep(code2, { index: 0 }, T0 + 1)).toBe("bad_request");
    expect(await pa.reportPhoneStep(code2, { index: 0, ok: true }, T0 + pa.REPORT_WINDOW_MS + 1)).toBe("gone");
  });

  it("duplicate step report is ignored", async () => {
    const u = user();
    const code = fetched(u.id);
    await pa.reportPhoneStep(code, { index: 0, ok: true }, T0 + 1);
    await pa.reportPhoneStep(code, { index: 0, ok: true }, T0 + 2);
    expect(getPhoneActionByCodeHash(pa.hashCode(code))!.results).toHaveLength(1);
  });

  it("all steps reported ok finishes the run", async () => {
    const u = user();
    const code = fetched(u.id);
    await pa.reportPhoneStep(code, { index: 0, ok: true }, T0 + 1);
    await pa.reportPhoneStep(code, { index: 1, ok: true, value: 54 }, T0 + 2);
    const row = getPhoneActionByCodeHash(pa.hashCode(code))!;
    expect(row).toMatchObject({ status: "done", finishedAt: T0 + 2 });
    expect(handleFinishedPhoneAction).toHaveBeenCalledTimes(1);
    expect(await pa.reportPhoneStep(code, { done: true }, T0 + 3)).toBe("gone");
    expect(handleFinishedPhoneAction).toHaveBeenCalledTimes(1);
  });

  it("a failed step finishes the run as failed with the error", async () => {
    const u = user();
    const code = fetched(u.id);
    await pa.reportPhoneStep(code, { index: 0, ok: false, error: "x".repeat(400) }, T0 + 1);
    const row = getPhoneActionByCodeHash(pa.hashCode(code))!;
    expect(row.status).toBe("failed");
    expect(row.results[0].error).toHaveLength(300);
    expect(handleFinishedPhoneAction).toHaveBeenCalledTimes(1);
  });

  it("an explicit done finishes the run", async () => {
    const u = user();
    const code = fetched(u.id);
    expect(await pa.reportPhoneStep(code, { done: true }, T0 + 1)).toBe("ok");
    expect(getPhoneActionByCodeHash(pa.hashCode(code))!.status).toBe("done");
  });
});

describe("sweepStalledPhoneActions", () => {
  it("fails a run that went quiet at the next unreported step", async () => {
    const u = user();
    const { code } = make(u.id);
    pa.fetchPhoneAction(code, 1, T0);
    await pa.reportPhoneStep(code, { index: 0, ok: true }, T0 + 1);
    await pa.sweepStalledPhoneActions(T0 + pa.STALL_MS - 1);
    expect(getPhoneActionByCodeHash(pa.hashCode(code))!.status).toBe("fetched");
    await pa.sweepStalledPhoneActions(T0 + pa.STALL_MS + 1);
    const row = getPhoneActionByCodeHash(pa.hashCode(code))!;
    expect(row.status).toBe("failed");
    expect(row.results.at(-1)).toMatchObject({ index: 1, ok: false, error: expect.stringMatching(/stopped/) });
  });
});
