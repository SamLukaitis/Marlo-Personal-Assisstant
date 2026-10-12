import { describe, it, expect, vi } from "vitest";

vi.mock("../providers/whatsapp.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sendWhatsAppMessage: vi.fn(),
}));

process.env.MARLOWE_SHORTCUT_ICLOUD_URL = "https://www.icloud.com/shortcuts/test";
const { runTool, buildToolsForOwner, buildSystemPrompt } = await import("./assistant.js");
const { findOrCreateUserByEmail, recordShortcutSeen } = await import("../db/store.js");

let n = 0;
const user = () => findOrCreateUserByEmail(`phone-tool-${Date.now()}-${++n}@example.com`);

describe("make_phone_action", () => {
  it("is offered when configured", () => {
    expect(buildToolsForOwner(user().id).map((t) => t.name)).toContain("make_phone_action");
  });

  it("returns a link, summary and install_url on first use", async () => {
    const u = user();
    const result = (await runTool(u.id, "make_phone_action", { label: "Early flight", steps: [{ type: "alarm", time: "05:15" }] })) as Record<string, unknown>;
    expect(result.url).toMatch(/\/a\/[A-Za-z0-9_-]{22}$/);
    expect(result.summary).toEqual(["set an alarm for 05:15"]);
    expect(result.install_url).toBe("https://www.icloud.com/shortcuts/test");
  });

  it("leaves out install_url once the Shortcut has run", async () => {
    const u = user();
    recordShortcutSeen(u.id, 1, Date.now());
    const result = (await runTool(u.id, "make_phone_action", { label: "x", steps: [{ type: "get_battery" }] })) as Record<string, unknown>;
    expect(result.install_url).toBeUndefined();
  });

  it("returns the validator's error", async () => {
    const result = await runTool(user().id, "make_phone_action", { label: "x", steps: [{ type: "alarm", time: "late" }] });
    expect(result).toEqual({ error: "step 1: time must be HH:MM, 24-hour." });
  });

  it("adds the phone section to the system prompt", () => {
    expect(buildSystemPrompt(user().id)).toMatch(/make_phone_action/);
  });
});
