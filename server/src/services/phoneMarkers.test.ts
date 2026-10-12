import { describe, it, expect, vi } from "vitest";

vi.mock("./phoneActionFollowups.js", () => ({ handleFinishedPhoneAction: vi.fn(async () => {}) }));
process.env.MARLOWE_SHORTCUT_ICLOUD_URL = "https://www.icloud.com/shortcuts/test";
const { expandPhoneMarkers, phoneSuggestionsEnabled, hashCode } = await import("./phoneActions.js");
const store = await import("../db/store.js");

let n = 0;
function owner(seen = true) {
  const u = store.findOrCreateUserByEmail(`phone-markers-${Date.now()}-${++n}@example.com`);
  if (seen) store.recordShortcutSeen(u.id, 1, Date.now());
  return u.id;
}
const LINK = /https?:\/\/[^\s]+\/a\/([A-Za-z0-9_-]{22})/g;

describe("expandPhoneMarkers", () => {
  it("turns a valid marker into 'label: url' and stores a briefing action", () => {
    const id = owner();
    const out = expandPhoneMarkers(id, 'Early flight tomorrow.\n[[phone|Tap for a 05:15 alarm|[{"type":"alarm","time":"05:15"}]]]', "briefing");
    expect(out).toMatch(/^Early flight tomorrow\.\nTap for a 05:15 alarm: https?:\/\/\S+\/a\/[A-Za-z0-9_-]{22}$/);
    const code = [...out.matchAll(LINK)][0][1];
    expect(store.getPhoneActionByCodeHash(hashCode(code))).toMatchObject({ source: "briefing", label: "Tap for a 05:15 alarm" });
  });

  it("drops invalid JSON, unknown steps and markers past the third", () => {
    const id = owner();
    const ok = '[[phone|A|[{"type":"get_battery"}]]]';
    const text = `x [[phone|Bad|[{"type":}]]] y [[phone|Nope|[{"type":"launch"}]]] ${ok} ${ok} ${ok} ${ok}`;
    const out = expandPhoneMarkers(id, text, "briefing");
    expect(out).not.toContain("[[phone");
    expect([...out.matchAll(LINK)]).toHaveLength(3);
    expect(out.startsWith("x y A:")).toBe(true);
  });

  it("strips markers without making links when the Shortcut never ran", () => {
    const id = owner(false);
    expect(phoneSuggestionsEnabled(id)).toBe(false);
    expect(expandPhoneMarkers(id, 'Hi [[phone|A|[{"type":"get_battery"}]]]', "digest")).toBe("Hi");
  });
});
