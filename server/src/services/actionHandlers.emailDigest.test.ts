import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../ai/assistant.js", () => ({
  runTool: vi.fn(),
  runAssistantChat: vi.fn(async () => ({ text: "What time would you like it?" })),
  MAX_HISTORY_MESSAGES: 12,
}));
vi.mock("../providers/whatsapp.js", () => ({
  sendWhatsAppMessage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./whatsappReply.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./whatsappReply.js")>()),
  sendAssistantReply: vi.fn().mockResolvedValue(undefined),
}));

const { findOrCreateUserByEmail, createPendingAction, getWhatsAppHistory } = await import("../db/store.js");
const { runAssistantChat } = await import("../ai/assistant.js");
const { sendWhatsAppMessage } = await import("../providers/whatsapp.js");
const { sendAssistantReply } = await import("./whatsappReply.js");
const { handlePendingActionReply } = await import("./actionHandlers.js");
const { realPersonAlertMode, realPersonAlertModeChosen, setEmailDigestTime } = await import(
  "./emailAlertSettings.js"
);

let counter = 0;
function setup() {
  counter += 1;
  const user = findOrCreateUserByEmail(`digest-tap-${Date.now()}-${counter}@example.com`);
  const actionId = createPendingAction(user.id, "email_digest", "Keep the daily email summary?", "{}");
  return { user, actionId, phone: `44700010${String(counter).padStart(4, "0")}` };
}

function tap(ownerId: number, phone: string, actionId: string, key: string) {
  return handlePendingActionReply(ownerId, {
    kind: "interactive",
    from: phone,
    messageId: `wamid.tap${counter}`,
    buttonId: `pa:${actionId}:${key}`,
  });
}

beforeEach(() => {
  vi.mocked(sendWhatsAppMessage).mockClear();
  vi.mocked(sendAssistantReply).mockClear();
  vi.mocked(runAssistantChat).mockClear();
});

describe("tapping the first-digest check-in buttons", () => {
  it("'Keep daily summary' records the choice and confirms, with the user's own digest time", async () => {
    const { user, actionId, phone } = setup();
    setEmailDigestTime(user.id, "18:30");

    expect(await tap(user.id, phone, actionId, "keep")).toBe(true);

    expect(realPersonAlertMode(user.id)).toBe("digest");
    expect(realPersonAlertModeChosen(user.id)).toBe(true);
    const [, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(text).toContain("6:30pm");
    expect(runAssistantChat).not.toHaveBeenCalled();
    expect(getWhatsAppHistory(phone).at(-1)?.content).toBe(text);
  });

  it("'Ping me instantly' switches them to a ping per email", async () => {
    const { user, actionId, phone } = setup();

    await tap(user.id, phone, actionId, "instant");

    expect(realPersonAlertMode(user.id)).toBe("instant");
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    expect(runAssistantChat).not.toHaveBeenCalled();
  });

  it("'Different time' changes nothing yet and hands the conversation to the assistant to ask what time", async () => {
    const { user, actionId, phone } = setup();

    await tap(user.id, phone, actionId, "time");

    expect(realPersonAlertModeChosen(user.id)).toBe(false);
    expect(runAssistantChat).toHaveBeenCalledTimes(1);
    expect(sendAssistantReply).toHaveBeenCalledTimes(1);
    expect(getWhatsAppHistory(phone).some((m) => m.content.includes("different time"))).toBe(true);
  });

  it("a second tap finds the question already answered and changes nothing", async () => {
    const { user, actionId, phone } = setup();
    await tap(user.id, phone, actionId, "instant");
    vi.mocked(sendWhatsAppMessage).mockClear();

    await tap(user.id, phone, actionId, "keep");

    expect(realPersonAlertMode(user.id)).toBe("instant");
    expect(sendWhatsAppMessage).toHaveBeenCalledWith(phone, "That option has expired — just ask me again.");
  });

  it("answering once retires any other open copy of the question", async () => {
    const { user, actionId, phone } = setup();
    const duplicate = createPendingAction(user.id, "email_digest", "Keep the daily email summary?", "{}");

    await tap(user.id, phone, actionId, "keep");
    vi.mocked(sendWhatsAppMessage).mockClear();
    await tap(user.id, phone, duplicate, "instant");

    expect(realPersonAlertMode(user.id)).toBe("digest");
    expect(sendWhatsAppMessage).toHaveBeenCalledWith(phone, "That option has expired — just ask me again.");
  });

  it("someone else's tap id does nothing", async () => {
    const { actionId } = setup();
    const other = findOrCreateUserByEmail(`digest-tap-other-${Date.now()}@example.com`);

    await tap(other.id, "44700010999", actionId, "instant");

    expect(realPersonAlertModeChosen(other.id)).toBe(false);
  });

  it("an expired question does nothing", async () => {
    counter += 1;
    const user = findOrCreateUserByEmail(`digest-tap-expired-${Date.now()}-${counter}@example.com`);
    const actionId = createPendingAction(user.id, "email_digest", "q", "{}", -1000);

    await tap(user.id, "44700010888", actionId, "instant");

    expect(realPersonAlertModeChosen(user.id)).toBe(false);
    expect(sendWhatsAppMessage).toHaveBeenCalledWith("44700010888", "That option has expired — just ask me again.");
  });
});
