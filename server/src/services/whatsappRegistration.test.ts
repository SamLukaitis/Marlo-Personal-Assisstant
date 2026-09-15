import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../providers/whatsapp.js", () => ({
  sendWhatsAppMessage: vi.fn(),
  sendWhatsAppReplyButtons: vi.fn(),
  sendWhatsAppCtaUrl: vi.fn(),
}));

const { sendWhatsAppMessage, sendWhatsAppReplyButtons, sendWhatsAppCtaUrl } = await import("../providers/whatsapp.js");
const { handlePendingRegistration } = await import("./whatsappRegistration.js");
const {
  upsertPendingRegistration,
  getPendingRegistration,
  findOrCreateUserByEmail,
  addPhoneNumberForUser,
  addInvitedPhone,
} = await import("../db/store.js");

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
      type: "sticker",
    });

    expect(sendWhatsAppMessage).toHaveBeenCalledWith(
      PHONE,
      "Let's finish setting you up first — what should I call you?"
    );
  });

  // A location pin is a fully handled type once someone is registered (handleLocation), but
  // mid-registration there's no ownerId and no registration state a pin could advance, so it
  // takes the same redirect as media/unsupported/reaction rather than falling through to the
  // text branch and crashing on a missing .text.
  it("redirects to setup for a location pin sent mid-registration", async () => {
    await handlePendingRegistration({
      kind: "location",
      from: PHONE,
      messageId: "m2",
      latitude: 51.5074,
      longitude: -0.1278,
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

// Invite-only access is gated by phone number: a brand-new number only starts the actual
// registration chain (and gets a pending_whatsapp_registrations row) if it's on the
// invited-numbers list — see db/store.ts's isPhoneInvited/addInvitedPhone.
describe("handlePendingRegistration — phone invite gate (first contact)", () => {
  it("turns away a brand-new, uninvited number without creating a pending registration row", async () => {
    const phone = freshPhone();

    await handlePendingRegistration({ kind: "text", from: phone, text: "hi", messageId: "m1" });

    expect(sendWhatsAppMessage).toHaveBeenCalledWith(phone, expect.stringContaining("isn't invited yet"));
    expect(sendWhatsAppMessage).not.toHaveBeenCalledWith(phone, expect.stringContaining("Welcome to the Marlowe"));
    expect(getPendingRegistration(phone)).toBeNull();
  });

  it("starts the real registration chain for an invited number", async () => {
    const phone = freshPhone();
    addInvitedPhone(phone);

    await handlePendingRegistration({ kind: "text", from: phone, text: "hi", messageId: "m1" });

    expect(sendWhatsAppMessage).toHaveBeenCalledWith(phone, expect.stringContaining("Welcome to the Marlowe"));
    expect(getPendingRegistration(phone)?.step).toBe("awaiting_name");
  });

  it("lets an uninvited number in once it's actually invited, after an earlier rejected attempt", async () => {
    const phone = freshPhone();
    await handlePendingRegistration({ kind: "text", from: phone, text: "hi", messageId: "m1" });
    expect(getPendingRegistration(phone)).toBeNull(); // still turned away

    addInvitedPhone(phone);
    await handlePendingRegistration({ kind: "text", from: phone, text: "hi", messageId: "m2" });

    expect(getPendingRegistration(phone)?.step).toBe("awaiting_name");
  });
});

describe("handlePendingRegistration — awaiting_email provider auto-detect", () => {
  it("skips the provider question and goes straight to the link for a gmail.com address", async () => {
    const phone = freshPhone();
    const email = `margaret+${phone}@gmail.com`;
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
