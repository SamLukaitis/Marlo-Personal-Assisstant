import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../providers/whatsapp.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isWhatsAppConfigured: () => true,
  sendWhatsAppMessage: vi.fn(async () => "wamid.x"),
}));
vi.mock("./outbound.js", () => ({
  sendProactiveMessage: vi.fn(async () => {}),
  isWithinCustomerServiceWindow: vi.fn(() => true),
}));
vi.mock("./messageBatching.js", () => ({ queueForAssistant: vi.fn() }));

process.env.MARLOWE_SHORTCUT_ICLOUD_URL = "https://www.icloud.com/shortcuts/test";
const { sendProactiveMessage, isWithinCustomerServiceWindow } = await import("./outbound.js");
const { queueForAssistant } = await import("./messageBatching.js");
const { handleFinishedPhoneAction, formatReportedValue, PROBLEM_TTL_MS } = await import("./phoneActionFollowups.js");
const { phonePromptSection } = await import("./phoneActions.js");
const store = await import("../db/store.js");

let n = 0;
const T0 = 1_700_000_000_000;
function owner() {
  const u = store.findOrCreateUserByEmail(`phone-follow-${Date.now()}-${++n}@example.com`);
  store.recordShortcutSeen(u.id, 1, T0);
  return u.id;
}
function row(ownerId: number, steps: store.PhoneStepJson[], results: store.PhoneStepResult[], status: "done" | "failed", phone: string | null = "+447700900001"): store.PhoneActionRow {
  return {
    id: 1, ownerId, codeHash: "h", source: "chat", phone, label: "Test", steps, status, results,
    version: 1, createdAt: T0, expiresAt: T0 + 1, fetchedAt: T0, finishedAt: T0 + 10,
  };
}

beforeEach(() => {
  vi.mocked(sendProactiveMessage).mockClear();
  vi.mocked(isWithinCustomerServiceWindow).mockReset();
  vi.mocked(isWithinCustomerServiceWindow).mockReturnValue(true);
  vi.mocked(queueForAssistant).mockClear();
});

describe("handleFinishedPhoneAction", () => {
  it("all do-steps ok: no message", async () => {
    const id = owner();
    await handleFinishedPhoneAction(row(id, [{ type: "alarm", time: "05:15" }], [{ index: 0, ok: true, at: T0 }], "done"), T0);
    expect(sendProactiveMessage).not.toHaveBeenCalled();
    expect(queueForAssistant).not.toHaveBeenCalled();
  });

  it("failure: one message naming the step, and a known problem", async () => {
    const id = owner();
    await handleFinishedPhoneAction(
      row(id, [{ type: "focus", name: "Work", on: true }], [{ index: 0, ok: false, error: "Focus not found", at: T0 }], "failed"),
      T0
    );
    expect(sendProactiveMessage).toHaveBeenCalledWith("+447700900001", expect.stringMatching(/Couldn't turn Work Focus on: Focus not found/), "alert");
    expect(store.getShortcutStatus(id)!.knownProblems).toEqual([
      { type: "focus", detail: "turn Work Focus on", error: "Focus not found", at: T0 },
    ]);
  });

  it("known problems replace the same step, drop old ones and cap at 10", async () => {
    const id = owner();
    store.setShortcutKnownProblems(id, [
      { type: "wifi", detail: "turn Wi-Fi off", error: "old", at: T0 - PROBLEM_TTL_MS - 1 },
      { type: "focus", detail: "turn Work Focus on", error: "first", at: T0 - 1 },
    ]);
    await handleFinishedPhoneAction(
      row(id, [{ type: "focus", name: "Work", on: true }], [{ index: 0, ok: false, error: "second", at: T0 }], "failed"),
      T0
    );
    expect(store.getShortcutStatus(id)!.knownProblems.map((p) => p.error)).toEqual(["second"]);
  });

  it("report-back values become a [From your phone] turn and location is saved as a check-in", async () => {
    const id = owner();
    await handleFinishedPhoneAction(
      row(
        id,
        [{ type: "get_location" }, { type: "get_battery" }],
        [
          { index: 0, ok: true, value: { latitude: 51.5, longitude: -0.12 }, at: T0 },
          { index: 1, ok: true, value: 54, at: T0 },
        ],
        "done"
      ),
      T0
    );
    expect(queueForAssistant).toHaveBeenCalledWith(id, "+447700900001", "", expect.any(Number), null, true);
    expect(store.listCheckins(id, 1)[0]).toMatchObject({ latitude: 51.5, longitude: -0.12 });
  });

  it("a failed WhatsApp send does not lose the rest of the run's results", async () => {
    const id = owner();
    vi.mocked(sendProactiveMessage).mockRejectedValueOnce(new Error("transient"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await handleFinishedPhoneAction(
      row(
        id,
        [{ type: "get_location" }, { type: "focus", name: "Work", on: true }],
        [
          { index: 0, ok: true, value: { latitude: 51.5, longitude: -0.12 }, at: T0 },
          { index: 1, ok: false, error: "Focus not found", at: T0 },
        ],
        "failed"
      ),
      T0
    );
    errSpy.mockRestore();
    expect(store.listCheckins(id, 1)[0]).toMatchObject({ latitude: 51.5, longitude: -0.12 });
    expect(queueForAssistant).toHaveBeenCalled();
    expect(store.getShortcutStatus(id)!.knownProblems).toHaveLength(1);
  });

  it("report-back is not queued when the WhatsApp window is closed, and is when open", async () => {
    const id = owner();
    const r = () => row(id, [{ type: "get_battery" }], [{ index: 0, ok: true, value: 54, at: T0 }], "done");
    vi.mocked(isWithinCustomerServiceWindow).mockReturnValue(false);
    await handleFinishedPhoneAction(r(), T0);
    expect(queueForAssistant).not.toHaveBeenCalled();
    vi.mocked(isWithinCustomerServiceWindow).mockReturnValue(true);
    await handleFinishedPhoneAction(r(), T0);
    expect(queueForAssistant).toHaveBeenCalledTimes(1);
  });

  it("a web-chat action (source chat, no phone) never starts a WhatsApp reply, but a briefing action does", async () => {
    const id = owner();
    store.addPhoneNumberForUser(id, "+447700900077");
    const base = row(id, [{ type: "get_battery" }], [{ index: 0, ok: true, value: 54, at: T0 }], "done", null);
    await handleFinishedPhoneAction({ ...base, source: "chat" }, T0);
    expect(queueForAssistant).not.toHaveBeenCalled();
    await handleFinishedPhoneAction({ ...base, source: "briefing" }, T0);
    expect(queueForAssistant).toHaveBeenCalledWith(id, "447700900077", "", expect.any(Number), null, true);
  });

  it("no phone on the row falls back to the user's first number; none at all sends nothing", async () => {
    const id = owner();
    await handleFinishedPhoneAction(row(id, [{ type: "get_battery" }], [{ index: 0, ok: true, value: 54, at: T0 }], "done", null), T0);
    expect(queueForAssistant).not.toHaveBeenCalled();
  });
});

describe("formatReportedValue", () => {
  it("words each report type and rejects junk", () => {
    expect(formatReportedValue({ type: "get_location" }, { latitude: 51.5, longitude: -0.12 })).toBe("location 51.5, -0.12");
    expect(formatReportedValue({ type: "get_location" }, "here")).toBeNull();
    expect(formatReportedValue({ type: "get_battery" }, 54)).toBe("battery 54%");
    expect(formatReportedValue({ type: "get_health", metric: "steps_today" }, 8042)).toBe("steps today: 8042");
    expect(formatReportedValue({ type: "ask", prompt: "Which hotel?" }, "The Hoxton")).toBe('answer to "Which hotel?": The Hoxton');
    expect(formatReportedValue({ type: "alarm", time: "05:00" }, 1)).toBeNull();
  });
});

describe("phonePromptSection", () => {
  it("lists version, fresh known problems and recent results", () => {
    const id = owner();
    store.setShortcutKnownProblems(id, [{ type: "focus", detail: "turn Work Focus on", error: "Focus not found", at: Date.now() }]);
    const text = phonePromptSection(id);
    expect(text).toMatch(/make_phone_action/);
    expect(text).toMatch(/version 1/);
    expect(text).toMatch(/turn Work Focus on.*Focus not found/);
  });

  it("tells the model about the install link when the Shortcut never ran", () => {
    const u = store.findOrCreateUserByEmail(`phone-follow-new-${Date.now()}@example.com`);
    expect(phonePromptSection(u.id)).toMatch(/hasn't run the Marlo Shortcut yet/);
  });

  it("lists only the steps the user's Shortcut version can run", () => {
    const id = owner(); // reported version 1
    const text = phonePromptSection(id);
    expect(text).toMatch(/alarm, timer, reminder/);
    expect(text).not.toMatch(/get_location|directions/);
  });
});
