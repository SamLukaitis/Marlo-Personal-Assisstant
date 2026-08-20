import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../providers/whatsapp.js", () => ({
  sendWhatsAppMessage: vi.fn(),
}));
vi.mock("./hub.js", () => ({
  hubListMessages: vi.fn().mockResolvedValue([]),
  hubListEvents: vi.fn().mockResolvedValue([]),
}));

const { sendWhatsAppMessage } = await import("../providers/whatsapp.js");
const { sendFirstValueAndBriefingPrompt } = await import("./whatsappRegistration.js");
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

beforeEach(() => {
  vi.mocked(sendWhatsAppMessage).mockClear();
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
