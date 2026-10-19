import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../providers/whatsapp.js", () => ({
  sendWhatsAppMessage: vi.fn(),
  sendWhatsAppReplyButtons: vi.fn(),
  sendWhatsAppCtaUrl: vi.fn(),
}));

const { sendWhatsAppMessage, sendWhatsAppCtaUrl } = await import("../providers/whatsapp.js");
const { runTool } = await import("./assistant.js");
const { resolveRegistrationUser } = await import("../routes/authRoutes.js");
const {
  findOrCreateUserByPhone,
  findOrCreateUserByEmail,
  addPhoneNumberForUser,
  upsertAccount,
  upsertPendingRegistration,
  completePendingRegistration,
  getPendingRegistration,
  consumePendingRegistrationToken,
  getUser,
  markAccountAuthBroken,
} = await import("../db/store.js");

let counter = 0;
function freshPhone(): string {
  counter += 1;
  return `44793000${String(counter).padStart(4, "0")}`;
}

// Mirrors the real precondition (whatsappRegistration.ts's handleEmailConfirmTap): a phone-only
// account always has a pending_whatsapp_registrations row left at step "completed" — Task 4's
// decline flow creates the account but never deletes the row. connect_email's own token issuance
// (setPendingRegistrationToken — store.ts) is an UPDATE keyed on that row existing, so a test that
// skips creating it would issue a token nothing can ever redeem.
function phoneOnlyAccount(phone: string) {
  upsertPendingRegistration(phone, { step: "awaiting_email_confirm" });
  const user = findOrCreateUserByPhone(phone);
  completePendingRegistration(phone);
  return user;
}

beforeEach(() => {
  vi.mocked(sendWhatsAppMessage).mockClear();
  vi.mocked(sendWhatsAppCtaUrl).mockClear();
});

describe("connect_email tool", () => {
  it("refuses when the user already has a connected account, and sends nothing", async () => {
    const phone = freshPhone();
    const user = phoneOnlyAccount(phone);
    upsertAccount(user.id, {
      provider: "google",
      email: `already-${phone}@example.com`,
      accessToken: "t",
      refreshToken: "r",
      expiryDate: null,
    });

    const result = await runTool(user.id, "connect_email", { provider: "google" });

    expect(result).toEqual({ error: expect.stringContaining("already has a mailbox connected") });
    expect(sendWhatsAppCtaUrl).not.toHaveBeenCalled();
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it("issues a token and sends a CTA URL for a mailbox-less user (google)", async () => {
    const phone = freshPhone();
    const user = phoneOnlyAccount(phone);

    const result = await runTool(user.id, "connect_email", { provider: "google" });

    expect(result).toEqual({ ok: true });
    expect(sendWhatsAppCtaUrl).toHaveBeenCalledWith(
      phone,
      expect.stringContaining("*Gmail*"),
      "Connect Gmail",
      expect.stringContaining("/auth/google/register")
    );
  });

  it("issues a token and sends a CTA URL for a mailbox-less user (microsoft)", async () => {
    const phone = freshPhone();
    const user = phoneOnlyAccount(phone);

    const result = await runTool(user.id, "connect_email", { provider: "microsoft" });

    expect(result).toEqual({ ok: true });
    expect(sendWhatsAppCtaUrl).toHaveBeenCalledWith(
      phone,
      expect.stringContaining("*Outlook*"),
      "Connect Outlook",
      expect.stringContaining("/auth/microsoft/register")
    );
  });

  it("rejects an unrecognized provider without sending anything", async () => {
    const phone = freshPhone();
    const user = phoneOnlyAccount(phone);

    const result = await runTool(user.id, "connect_email", { provider: "yahoo" });

    expect(result).toEqual({ error: expect.stringContaining("unknown provider") });
    expect(sendWhatsAppCtaUrl).not.toHaveBeenCalled();
  });

  it("fails clearly when the account has no phone number on file, rather than silently no-op-ing", async () => {
    const user = findOrCreateUserByEmail(`no-phone-${Date.now()}@example.com`);

    const result = await runTool(user.id, "connect_email", { provider: "google" });

    expect(result).toEqual({ error: expect.stringContaining("No WhatsApp number") });
    expect(sendWhatsAppCtaUrl).not.toHaveBeenCalled();
  });

  // The bug this whole task exists to fix: re-entering the registration state machine would make
  // whatsappRoutes.ts treat the user's next ordinary message as registration input again.
  it("does not move the pending registration row off completed", async () => {
    const phone = freshPhone();
    const user = phoneOnlyAccount(phone);
    expect(getPendingRegistration(phone)?.step).toBe("completed");

    await runTool(user.id, "connect_email", { provider: "google" });

    expect(getPendingRegistration(phone)?.step).toBe("completed");
  });

  // Review finding #2: setPendingRegistrationToken (store.ts) is an UPDATE keyed on phone — with
  // no matching row it still hands back a token nothing can ever redeem. Two real populations
  // reach a phone with zero accounts and no pending row: an admin's replay-onboarding action, and
  // a web-registered user who added this number in Settings then deleted their mailbox. This test
  // mirrors the latter directly (findOrCreateUserByEmail + addPhoneNumberForUser, no registration
  // row ever created).
  //
  // That used to be reported to the user as "this needs a developer", which is a dead end for a
  // request Marlowe can simply honour: sendConnectLink now creates the row the token needs (as
  // "completed", so a registered number is never dropped back into the registration state
  // machine) and sends a link that actually works.
  it("creates the missing pending-registration row and sends a redeemable link", async () => {
    const phone = freshPhone();
    const user = findOrCreateUserByEmail(`web-registered-${phone}@example.com`);
    addPhoneNumberForUser(user.id, phone);
    expect(getPendingRegistration(phone)).toBeNull();

    const result = await runTool(user.id, "connect_email", { provider: "google" });

    expect(result).toEqual({ ok: true });
    expect(sendWhatsAppCtaUrl).toHaveBeenCalled();
    expect(getPendingRegistration(phone)?.step).toBe("completed");
    expect(getPendingRegistration(phone)?.tokenHash).toBeTruthy();
  });

  // Review finding #4: sendConnectLink used to return void for both a real send and a
  // cooldown-swallowed one, so the tool always reported ok:true — telling the user a link is on
  // its way even when the only thing sent was "Still working on it...".
  it("surfaces the cooldown instead of claiming success when a second call lands within it", async () => {
    const phone = freshPhone();
    const user = phoneOnlyAccount(phone);

    const first = await runTool(user.id, "connect_email", { provider: "google" });
    expect(first).toEqual({ ok: true });

    // "actually, Outlook" moments later — still within the resend cooldown.
    const second = await runTool(user.id, "connect_email", { provider: "microsoft" });

    expect(second).toEqual({ error: expect.stringContaining("A link was just sent") });
    expect(sendWhatsAppCtaUrl).toHaveBeenCalledTimes(1); // only the first (Gmail) link ever went out
    expect(sendWhatsAppMessage).toHaveBeenCalledWith(phone, expect.stringContaining("Still working on it"));
  });

  it("end-to-end: the issued token resolves back to this phone, and OAuth attaches the address to the existing account rather than creating a second one", async () => {
    const phone = freshPhone();
    const user = phoneOnlyAccount(phone);

    await runTool(user.id, "connect_email", { provider: "google" });

    const [, , , link] = vi.mocked(sendWhatsAppCtaUrl).mock.calls[0];
    const token = new URL(link as string).searchParams.get("token")!;
    const reg = consumePendingRegistrationToken(token);
    expect(reg?.phone).toBe(phone);

    const email = `linked-${phone}@example.com`;
    const resolution = resolveRegistrationUser(reg!.phone, email);

    expect(resolution.kind).toBe("ok");
    if (resolution.kind !== "ok") return;
    expect(resolution.userId).toBe(user.id);
    expect(getUser(user.id)?.email).toBe(email);
  });
});

// A dead token (revoked, expired, Google's 7-day Testing-mode limit) is the one case where a user
// who already has a mailbox needs a link: the same one-tap link, sent as a reconnect.
describe("connect_email for a broken connection", () => {
  it("sends a reconnect link for the provider whose connection has expired", async () => {
    const phone = freshPhone();
    const user = phoneOnlyAccount(phone);
    const account = upsertAccount(user.id, {
      provider: "google",
      email: `broken-${phone}@example.com`,
      accessToken: "t",
      refreshToken: "r",
      expiryDate: null,
    });
    markAccountAuthBroken(user.id, account.id);

    const result = await runTool(user.id, "connect_email", { provider: "google" });

    expect(result).toEqual({ ok: true });
    expect(sendWhatsAppCtaUrl).toHaveBeenCalledWith(
      phone,
      expect.stringContaining("reconnect *Gmail*"),
      "Reconnect Gmail",
      expect.stringContaining("/auth/google/register")
    );
  });

  it("still refuses when the connected mailbox is healthy", async () => {
    const phone = freshPhone();
    const user = phoneOnlyAccount(phone);
    upsertAccount(user.id, {
      provider: "google",
      email: `healthy-${phone}@example.com`,
      accessToken: "t",
      refreshToken: "r",
      expiryDate: null,
    });

    const result = await runTool(user.id, "connect_email", { provider: "google" });

    expect(result).toEqual({ error: expect.stringContaining("already has a mailbox connected") });
    expect(sendWhatsAppCtaUrl).not.toHaveBeenCalled();
  });
});
