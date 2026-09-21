import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../providers/whatsapp.js", () => ({
  sendWhatsAppMessage: vi.fn(),
  sendWhatsAppCtaUrl: vi.fn(),
}));

const { sendWhatsAppMessage, sendWhatsAppCtaUrl } = await import("../providers/whatsapp.js");
const { sendConnectLink } = await import("./connectMailboxLink.js");
const { getPendingRegistration, upsertPendingRegistration, deletePendingRegistration } = await import(
  "../db/store.js"
);

let counter = 0;
function freshPhone(): string {
  counter += 1;
  return `44700009${String(counter).padStart(4, "0")}`;
}

beforeEach(() => {
  vi.mocked(sendWhatsAppMessage).mockClear();
  vi.mocked(sendWhatsAppCtaUrl).mockClear();
});

// A missing pending row used to abort the send outright. Both populations that hit it are real
// and recoverable — an admin's replay-onboarding deleting the row mid-flow, and a web-registered
// user who added their number in Settings and never had one — but the caller could only report
// failure: the assistant's connect_email tool told them to fetch a developer, and
// whatsappRegistration's sendProviderLink returned having sent nothing at all.
describe("sendConnectLink — no pending registration row", () => {
  it("creates the row it needs and sends a real, redeemable link", async () => {
    const phone = freshPhone();
    expect(getPendingRegistration(phone)).toBeNull();

    const result = await sendConnectLink(phone, "google");

    expect(result).toBe("sent");
    expect(sendWhatsAppCtaUrl).toHaveBeenCalledWith(
      phone,
      expect.stringContaining("*Gmail*"),
      "Connect Gmail",
      expect.stringContaining("/auth/google/register")
    );
    // The token has to be stored against a row, or the link it's embedded in can never be
    // redeemed — that is the whole reason the original guard existed.
    expect(getPendingRegistration(phone)?.tokenHash).toBeTruthy();
  });

  // The row it creates must not drop a registered user back into the registration state machine
  // (see handlePendingRegistration's routing), so it starts already completed. Callers that do
  // want a registration step set it themselves afterwards.
  it("creates the row as completed rather than mid-registration", async () => {
    const phone = freshPhone();

    await sendConnectLink(phone, "microsoft");

    expect(getPendingRegistration(phone)?.step).toBe("completed");
  });

  it("leaves an existing row's step alone", async () => {
    const phone = freshPhone();
    upsertPendingRegistration(phone, { step: "awaiting_provider", name: "Sam" });

    await sendConnectLink(phone, "google");

    expect(getPendingRegistration(phone)?.step).toBe("awaiting_provider");
  });

  it("does not resurrect a row for a phone still inside the resend cooldown", async () => {
    const phone = freshPhone();
    await sendConnectLink(phone, "google");
    deletePendingRegistration(phone);
    vi.mocked(sendWhatsAppCtaUrl).mockClear();

    const result = await sendConnectLink(phone, "google");

    expect(result).toBe("throttled");
    expect(sendWhatsAppCtaUrl).not.toHaveBeenCalled();
    expect(getPendingRegistration(phone)).toBeNull();
  });
});
