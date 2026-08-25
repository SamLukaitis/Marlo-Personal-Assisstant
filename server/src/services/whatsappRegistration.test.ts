import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../providers/whatsapp.js", () => ({
  sendWhatsAppMessage: vi.fn(),
}));
vi.mock("./hub.js", () => ({
  hubListMessages: vi.fn().mockResolvedValue([]),
  hubListEvents: vi.fn().mockResolvedValue([]),
}));
vi.mock("../ai/assistant.js", () => ({
  getRegistrationAssistReply: vi.fn().mockResolvedValue("mocked assist reply"),
}));

const { sendWhatsAppMessage } = await import("../providers/whatsapp.js");
const { getRegistrationAssistReply } = await import("../ai/assistant.js");
const { sendFirstValueAndBriefingPrompt, handlePendingRegistration, MARLOWE_HELP_TEXT } = await import(
  "./whatsappRegistration.js"
);
const { getPendingRegistration, upsertPendingRegistration, findOrCreateUserByEmail } = await import(
  "../db/store.js"
);

let counter = 0;
function freshPhone(): string {
  counter += 1;
  return `44700001${String(counter).padStart(4, "0")}`;
}
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

function textMessage(from: string, text: string) {
  return { kind: "text" as const, from, text, messageId: `msg-${Math.random()}` };
}

beforeEach(() => {
  vi.mocked(sendWhatsAppMessage).mockClear();
  vi.mocked(getRegistrationAssistReply).mockClear();
});

describe("sendFirstValueAndBriefingPrompt", () => {
  it("sends the connected-confirmation and the new briefing-content prompt", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("first-value"));
    const phone = freshPhone();

    await sendFirstValueAndBriefingPrompt(user.id, phone);

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = vi.mocked(sendWhatsAppMessage).mock.calls;
    expect(firstCall[0]).toBe(phone);
    expect(firstCall[1]).toContain("Connected");
    expect(secondCall[0]).toBe(phone);
    expect(secondCall[1]).toContain("email");
    expect(secondCall[1]).toContain("calendar");
    // No more rigid 8am/9am/no-thanks menu — the follow-up is answerable in free text.
    expect(secondCall[1]).not.toMatch(/8am/i);
  });

  it("marks the pending registration row completed immediately — nothing left to await", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("completes-row"));
    const phone = freshPhone();
    upsertPendingRegistration(phone, { step: "awaiting_link_tap" });

    await sendFirstValueAndBriefingPrompt(user.id, phone);

    expect(getPendingRegistration(phone)?.step).toBe("completed");
  });
});

describe("first contact", () => {
  it("greets a brand-new number with the capability overview, ending in the name question", async () => {
    const phone = freshPhone();

    await handlePendingRegistration(textMessage(phone, "hi"));

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    const [sentPhone, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(sentPhone).toBe(phone);
    expect(text).toBe(MARLOWE_HELP_TEXT);
    expect(text).toContain("What should I call you?");
  });
});

describe("help trigger", () => {
  it("re-sends the overview and repeats the current step's prompt instead of advancing", async () => {
    const phone = freshPhone();
    upsertPendingRegistration(phone, { step: "awaiting_email", name: "Margaret" });

    await handlePendingRegistration(textMessage(phone, "help"));

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = vi.mocked(sendWhatsAppMessage).mock.calls;
    expect(firstCall[1]).toBe(MARLOWE_HELP_TEXT);
    expect(secondCall[1]).toContain("email");
    // Still on the same step — asking for help must not advance the state machine.
    expect(getPendingRegistration(phone)?.step).toBe("awaiting_email");
  });

  it("matches case-insensitively and with surrounding whitespace", async () => {
    const phone = freshPhone();
    upsertPendingRegistration(phone, { step: "awaiting_link_tap" });

    await handlePendingRegistration(textMessage(phone, "  Menu  "));

    expect(vi.mocked(sendWhatsAppMessage).mock.calls[0][1]).toBe(MARLOWE_HELP_TEXT);
  });
});

describe("handleAwaitingEmail — conversational fallback", () => {
  it("asks the assistant for a helpful reply instead of the canned rejection, and stays on the same step", async () => {
    const phone = freshPhone();
    upsertPendingRegistration(phone, { step: "awaiting_email", name: "Margaret" });

    await handlePendingRegistration(textMessage(phone, "I have two, which one should I use?"));

    expect(getRegistrationAssistReply).toHaveBeenCalledWith(
      "I have two, which one should I use?",
      "email"
    );
    expect(sendWhatsAppMessage).toHaveBeenCalledWith(phone, "mocked assist reply");
    expect(getPendingRegistration(phone)?.step).toBe("awaiting_email");
  });
});

describe("handleAwaitingLinkTap — conversational fallback", () => {
  it("asks the assistant for a helpful reply on anything that isn't a resend request", async () => {
    const phone = freshPhone();
    upsertPendingRegistration(phone, { step: "awaiting_link_tap" });

    await handlePendingRegistration(textMessage(phone, "did it work? nothing happened"));

    expect(getRegistrationAssistReply).toHaveBeenCalledWith(
      "did it work? nothing happened",
      "link"
    );
    expect(sendWhatsAppMessage).toHaveBeenCalledWith(phone, "mocked assist reply");
    expect(getPendingRegistration(phone)?.step).toBe("awaiting_link_tap");
  });
});
