import { describe, it, expect, vi } from "vitest";

vi.mock("./phoneActionFollowups.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  handleFinishedPhoneAction: vi.fn(async () => {}),
}));
process.env.MARLOWE_SHORTCUT_ICLOUD_URL = "https://www.icloud.com/shortcuts/test";
const { scrubUnknownActionLinks, createPhoneAction, fetchPhoneAction, actionPageUrl, CHAT_TTL_MS, phonePromptSection } = await import(
  "./phoneActions.js"
);
const store = await import("../db/store.js");

let n = 0;
const owner = () => store.findOrCreateUserByEmail(`phone-scrub-${Date.now()}-${++n}@example.com`).id;
const alarm = [{ type: "alarm", time: "07:30" }] as never;

describe("scrubUnknownActionLinks", () => {
  it("keeps a real, unused link Marlowe just created", () => {
    const { url } = createPhoneAction(owner(), alarm, { source: "chat", label: "x", ttlMs: CHAT_TTL_MS });
    expect(scrubUnknownActionLinks(`Tap to set it:\n${url}`)).toBe(`Tap to set it:\n${url}`);
  });

  it("replaces a link the model made up (no such code)", () => {
    const fake = actionPageUrl("QqLm2wOpD6c3TfXlVzFaBe");
    const out = scrubUnknownActionLinks(`Alarm set:\n${fake}`);
    expect(out).not.toContain(fake);
    expect(out).toMatch(/ask me again/);
  });

  it("replaces an old link that was already used", () => {
    const { code, url } = createPhoneAction(owner(), alarm, { source: "chat", label: "x", ttlMs: CHAT_TTL_MS });
    fetchPhoneAction(code, 1);
    expect(scrubUnknownActionLinks(url)).not.toContain(url);
  });

  it("leaves text without Marlowe links byte-identical", () => {
    const text = "No links here, just https://example.com/a/QqLm2wOpD6c3TfXlVzFaBe  and spaces ";
    expect(scrubUnknownActionLinks(text)).toBe(text);
  });
});

describe("phonePromptSection — after a failure", () => {
  it("still tells the model to use the tool and never to write a link itself", () => {
    const id = owner();
    store.recordShortcutSeen(id, 1, Date.now());
    store.setShortcutKnownProblems(id, [{ type: "alarm", detail: "set an alarm for 08:00", error: "stopped", at: Date.now() }]);
    const text = phonePromptSection(id);
    expect(text).not.toMatch(/don't repeat/);
    expect(text).toMatch(/still call make_phone_action/);
    expect(text).toMatch(/never write a .*link yourself/i);
  });
});
