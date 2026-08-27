import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../providers/whatsapp.js", () => ({
  sendWhatsAppMessage: vi.fn(),
  sendWhatsAppReplyButtons: vi.fn(),
  sendWhatsAppCtaUrl: vi.fn(),
}));

const { sendWhatsAppMessage } = await import("../providers/whatsapp.js");
const { handlePendingRegistration } = await import("./whatsappRegistration.js");

const PHONE = "447000003001";

beforeEach(() => {
  vi.mocked(sendWhatsAppMessage).mockClear();
});

describe("handlePendingRegistration — unsupported message types", () => {
  it("redirects to setup the same way an unexpected media message does, rather than crashing on missing .text", async () => {
    await handlePendingRegistration({
      kind: "unsupported",
      from: PHONE,
      messageId: "m1",
      type: "location",
    });

    expect(sendWhatsAppMessage).toHaveBeenCalledWith(
      PHONE,
      "Let's finish setting you up first — what should I call you?"
    );
  });
});
