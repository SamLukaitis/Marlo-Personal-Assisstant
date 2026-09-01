import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../providers/whatsapp.js", () => ({
  sendWhatsAppMessage: vi.fn(),
  sendWhatsAppReplyButtons: vi.fn(),
  sendWhatsAppCtaUrl: vi.fn(),
}));

const { sendWhatsAppMessage, sendWhatsAppReplyButtons, sendWhatsAppCtaUrl } = await import("../providers/whatsapp.js");
const { handlePendingRegistration } = await import("./whatsappRegistration.js");
const { addInvitedEmail, upsertPendingRegistration, getPendingRegistration, findOrCreateUserByEmail, addPhoneNumberForUser } =
  await import("../db/store.js");

const PHONE = "447000003001";

beforeEach(() => {
  vi.mocked(sendWhatsAppMessage).mockClear();
  vi.mocked(sendWhatsAppReplyButtons).mockClear();
  vi.mocked(sendWhatsAppCtaUrl).mockClear();
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

// A fresh phone per test avoids cross-test interference — store.ts's DB connection is a
// module-level singleton shared across the whole test file run.
let counter = 0;
function freshPhone(): string {
  counter += 1;
  return `44700000${String(counter).padStart(4, "0")}`;
}

describe("handlePendingRegistration — awaiting_email provider auto-detect", () => {
  it("skips the provider question and goes straight to the link for a gmail.com address", async () => {
    const phone = freshPhone();
    const email = `margaret+${phone}@gmail.com`;
    addInvitedEmail(email);
    upsertPendingRegistration(phone, { step: "awaiting_email", name: "Margaret" });

    await handlePendingRegistration({ kind: "text", from: phone, text: email, messageId: "m1" });

    expect(sendWhatsAppReplyButtons).not.toHaveBeenCalled();
    expect(sendWhatsAppCtaUrl).toHaveBeenCalledWith(
      phone,
      expect.stringContaining("*Gmail*"),
      "Connect Gmail",
      expect.stringContaining("/auth/google/register")
    );
    expect(getPendingRegistration(phone)?.step).toBe("awaiting_link_tap");
    expect(getPendingRegistration(phone)?.provider).toBe("google");
  });

  it("skips the provider question and goes straight to the link for an outlook.com address", async () => {
    const phone = freshPhone();
    const email = `margaret+${phone}@outlook.com`;
    addInvitedEmail(email);
    upsertPendingRegistration(phone, { step: "awaiting_email", name: "Margaret" });

    await handlePendingRegistration({ kind: "text", from: phone, text: email, messageId: "m1" });

    expect(sendWhatsAppCtaUrl).toHaveBeenCalledWith(
      phone,
      expect.stringContaining("*Outlook*"),
      "Connect Outlook",
      expect.stringContaining("/auth/microsoft/register")
    );
    expect(getPendingRegistration(phone)?.provider).toBe("microsoft");
  });

  it("still asks the explicit provider question for an ambiguous custom-domain address", async () => {
    const phone = freshPhone();
    const email = `margaret+${phone}@somecompany.com`;
    addInvitedEmail(email);
    upsertPendingRegistration(phone, { step: "awaiting_email", name: "Margaret" });

    await handlePendingRegistration({ kind: "text", from: phone, text: email, messageId: "m1" });

    expect(sendWhatsAppCtaUrl).not.toHaveBeenCalled();
    expect(sendWhatsAppReplyButtons).toHaveBeenCalledWith(phone, "Do you use Gmail or Outlook/Hotmail?", [
      { id: "register_google", title: "Gmail" },
      { id: "register_microsoft", title: "Outlook" },
    ]);
    expect(getPendingRegistration(phone)?.step).toBe("awaiting_provider");
  });
});

describe("handlePendingRegistration — awaiting_email reconnecting an existing account", () => {
  it("blocks when the existing account still has a phone bound (unchanged behavior)", async () => {
    const phone = freshPhone();
    const email = `stillbound-${phone}@gmail.com`;
    addInvitedEmail(email);
    const existing = findOrCreateUserByEmail(email);
    addPhoneNumberForUser(existing.id, "447900009999"); // some other number, still connected

    upsertPendingRegistration(phone, { step: "awaiting_email", name: "Margaret" });
    await handlePendingRegistration({ kind: "text", from: phone, text: email, messageId: "m1" });

    expect(sendWhatsAppMessage).toHaveBeenCalledWith(
      phone,
      "That email's already connected to a Marlowe account. Add this WhatsApp number from Settings on the website instead of starting again here."
    );
    expect(sendWhatsAppCtaUrl).not.toHaveBeenCalled();
  });

  it("lets it through when the existing account has zero phones bound (e.g. after replay-onboarding)", async () => {
    const phone = freshPhone();
    const email = `replay-${phone}@gmail.com`;
    addInvitedEmail(email);
    findOrCreateUserByEmail(email); // account exists but no phone bound — matches resetOnboardingConnectionState's result

    upsertPendingRegistration(phone, { step: "awaiting_email", name: "Margaret" });
    await handlePendingRegistration({ kind: "text", from: phone, text: email, messageId: "m1" });

    // Falls through to the normal auto-detect path instead of the "already connected" block.
    expect(sendWhatsAppCtaUrl).toHaveBeenCalledWith(
      phone,
      expect.stringContaining("*Gmail*"),
      "Connect Gmail",
      expect.stringContaining("/auth/google/register")
    );
    expect(getPendingRegistration(phone)?.step).toBe("awaiting_link_tap");
  });
});
