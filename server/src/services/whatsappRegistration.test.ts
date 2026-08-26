import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../providers/whatsapp.js", () => ({
  sendWhatsAppMessage: vi.fn(),
  sendWhatsAppReplyButtons: vi.fn(),
  sendWhatsAppCtaUrl: vi.fn(),
}));
vi.mock("./hub.js", () => ({
  hubListMessages: vi.fn().mockResolvedValue([]),
  hubListEvents: vi.fn().mockResolvedValue([]),
}));
vi.mock("../ai/assistant.js", () => ({
  getRegistrationAssistReply: vi.fn().mockResolvedValue("mocked assist reply"),
}));

const { sendWhatsAppMessage, sendWhatsAppReplyButtons, sendWhatsAppCtaUrl } = await import(
  "../providers/whatsapp.js"
);
const { getRegistrationAssistReply } = await import("../ai/assistant.js");
const { sendFirstValueAndBriefingPrompt, handlePendingRegistration, MARLOWE_HELP_TEXT } = await import(
  "./whatsappRegistration.js"
);
const { getPendingRegistration, upsertPendingRegistration, findOrCreateUserByEmail, addInvitedEmail } =
  await import("../db/store.js");

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
function interactiveMessage(from: string, buttonId: string) {
  return { kind: "interactive" as const, from, buttonId, messageId: `msg-${Math.random()}` };
}

beforeEach(() => {
  vi.mocked(sendWhatsAppMessage).mockClear();
  vi.mocked(sendWhatsAppReplyButtons).mockClear();
  vi.mocked(sendWhatsAppCtaUrl).mockClear();
  vi.mocked(getRegistrationAssistReply).mockClear();
});

describe("sendFirstValueAndBriefingPrompt", () => {
  it("sends the connected-confirmation, then hands off to the post-connect button chain", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("first-value"));
    const phone = freshPhone();

    await sendFirstValueAndBriefingPrompt(user.id, phone);

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    expect(sendWhatsAppMessage.mock.calls[0][0]).toBe(phone);
    expect(sendWhatsAppMessage.mock.calls[0][1]).toContain("Connected");

    expect(sendWhatsAppReplyButtons).toHaveBeenCalledTimes(1);
    const [buttonPhone, bodyText, buttons] = vi.mocked(sendWhatsAppReplyButtons).mock.calls[0];
    expect(buttonPhone).toBe(phone);
    expect(bodyText).toContain("daily");
    expect(buttons.map((b) => b.id)).toEqual(["briefing_yes", "briefing_no"]);
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

  it("asks which provider via buttons once a valid, invited email is given", async () => {
    const email = uniqueEmail("provider-ask");
    addInvitedEmail(email);
    const phone = freshPhone();
    upsertPendingRegistration(phone, { step: "awaiting_email", name: "Margaret" });

    await handlePendingRegistration(textMessage(phone, email));

    expect(sendWhatsAppReplyButtons).toHaveBeenCalledTimes(1);
    const [buttonPhone, , buttons] = vi.mocked(sendWhatsAppReplyButtons).mock.calls[0];
    expect(buttonPhone).toBe(phone);
    expect(buttons.map((b) => b.id)).toEqual(["register_google", "register_microsoft"]);
    expect(getPendingRegistration(phone)?.step).toBe("awaiting_provider");
  });
});

describe("awaiting_provider", () => {
  async function advanceToAwaitingProvider(phone: string): Promise<void> {
    const email = uniqueEmail("provider-flow");
    addInvitedEmail(email);
    upsertPendingRegistration(phone, { step: "awaiting_email", name: "Margaret" });
    await handlePendingRegistration(textMessage(phone, email));
    vi.mocked(sendWhatsAppReplyButtons).mockClear();
  }

  it("sends a single Google CTA link and advances to awaiting_link_tap on a Gmail button tap", async () => {
    const phone = freshPhone();
    await advanceToAwaitingProvider(phone);

    await handlePendingRegistration(interactiveMessage(phone, "register_google"));

    expect(sendWhatsAppCtaUrl).toHaveBeenCalledTimes(1);
    const [linkPhone, , , url] = vi.mocked(sendWhatsAppCtaUrl).mock.calls[0];
    expect(linkPhone).toBe(phone);
    expect(url).toContain("/auth/google/register?token=");
    const row = getPendingRegistration(phone);
    expect(row?.step).toBe("awaiting_link_tap");
    expect(row?.provider).toBe("google");
  });

  it("sends a single Microsoft CTA link on an Outlook button tap", async () => {
    const phone = freshPhone();
    await advanceToAwaitingProvider(phone);

    await handlePendingRegistration(interactiveMessage(phone, "register_microsoft"));

    const [, , , url] = vi.mocked(sendWhatsAppCtaUrl).mock.calls[0];
    expect(url).toContain("/auth/microsoft/register?token=");
    expect(getPendingRegistration(phone)?.provider).toBe("microsoft");
  });

  it("accepts a typed provider name as a fallback to tapping", async () => {
    const phone = freshPhone();
    await advanceToAwaitingProvider(phone);

    await handlePendingRegistration(textMessage(phone, "I use outlook"));

    expect(sendWhatsAppCtaUrl).toHaveBeenCalledTimes(1);
    expect(getPendingRegistration(phone)?.provider).toBe("microsoft");
  });

  it("asks the assistant for a helpful reply on typed text that names neither provider", async () => {
    const phone = freshPhone();
    await advanceToAwaitingProvider(phone);

    await handlePendingRegistration(textMessage(phone, "does it matter?"));

    expect(getRegistrationAssistReply).toHaveBeenCalledWith("does it matter?", "provider");
    expect(sendWhatsAppCtaUrl).not.toHaveBeenCalled();
    expect(getPendingRegistration(phone)?.step).toBe("awaiting_provider");
  });

  it("resend at awaiting_link_tap re-sends only the chosen provider's link, once past the resend cooldown", async () => {
    const phone = freshPhone();
    await advanceToAwaitingProvider(phone);
    await handlePendingRegistration(interactiveMessage(phone, "register_google"));
    vi.mocked(sendWhatsAppCtaUrl).mockClear();

    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(61_000); // past RESEND_COOLDOWN_MS
      await handlePendingRegistration(textMessage(phone, "resend"));
    } finally {
      vi.useRealTimers();
    }

    expect(sendWhatsAppCtaUrl).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendWhatsAppCtaUrl).mock.calls[0][3]).toContain("/auth/google/register?token=");
  });

  it("holds off resending within the cooldown window instead of sending a second link", async () => {
    const phone = freshPhone();
    await advanceToAwaitingProvider(phone);
    await handlePendingRegistration(interactiveMessage(phone, "register_google"));
    vi.mocked(sendWhatsAppCtaUrl).mockClear();
    vi.mocked(sendWhatsAppMessage).mockClear();

    await handlePendingRegistration(textMessage(phone, "resend"));

    expect(sendWhatsAppCtaUrl).not.toHaveBeenCalled();
    expect(sendWhatsAppMessage).toHaveBeenCalledWith(phone, expect.stringContaining("Still working on it"));
  });
});

describe("mistimed interactive messages", () => {
  it("redirects a button tap with no matching pending registration step", async () => {
    const phone = freshPhone();

    await handlePendingRegistration(interactiveMessage(phone, "register_google"));

    expect(sendWhatsAppMessage).toHaveBeenCalledWith(
      phone,
      expect.stringContaining("Let's finish setting you up")
    );
  });
});

describe("handleAwaitingLinkTap — conversational fallback", () => {
  it("asks the assistant for a helpful reply on anything that isn't a resend request", async () => {
    const phone = freshPhone();
    upsertPendingRegistration(phone, { step: "awaiting_link_tap", provider: "google" });

    await handlePendingRegistration(textMessage(phone, "did it work? nothing happened"));

    expect(getRegistrationAssistReply).toHaveBeenCalledWith(
      "did it work? nothing happened",
      "link"
    );
    expect(sendWhatsAppMessage).toHaveBeenCalledWith(phone, "mocked assist reply");
    expect(getPendingRegistration(phone)?.step).toBe("awaiting_link_tap");
  });
});
