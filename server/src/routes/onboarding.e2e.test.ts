// The whole onboarding journey in one test, from an uninvited number's first "hi" to a fully set
// up account answering ordinary questions — driven through the real entry points (handleIncoming
// for every inbound WhatsApp message, the real /auth/google/register and /auth/google/callback
// routes for the OAuth hop) against the real database.
//
// Everything between those entry points runs for real: the invite gate, the registration state
// machine, token issue/consume, account creation and phone binding, and the post-connect question
// chain. Only the outermost boundaries are stubbed — WhatsApp sends (asserted on instead),
// Google's token endpoint, the Anthropic calls (the assistant itself, the registration assist
// reply, the setup-intent check, the rolling conversation summary) and the mailbox/calendar hub.
//
// The per-step unit tests cover the branches; this covers the seams between them, which is where
// the loops and dead ends this file was written alongside actually lived.
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

process.env.WHATSAPP_DEBOUNCE_SHORT_MS = "20";
process.env.WHATSAPP_DEBOUNCE_LONG_MS = "20";

vi.mock("../providers/whatsapp.js", () => ({
  sendWhatsAppMessage: vi.fn(async () => "wamid.out"),
  sendWhatsAppReplyButtons: vi.fn(async () => undefined),
  sendWhatsAppCtaUrl: vi.fn(async () => undefined),
  sendWhatsAppTypingIndicator: vi.fn(async () => undefined),
  sendWhatsAppReaction: vi.fn(async () => undefined),
  sendChoiceMessage: vi.fn(async () => undefined),
  isWhatsAppConfigured: () => true,
  isWhatsAppSignatureConfigured: () => true,
  isSimulatedPhone: () => false,
  verifyWebhookChallenge: vi.fn(),
  verifyWebhookSignature: vi.fn(() => true),
  extractIncomingMessages: vi.fn(() => []),
}));
vi.mock("../providers/google.js", () => ({
  isGoogleConfigured: () => true,
  getGoogleAuthUrl: (state: string) => `https://accounts.google.com/mock?state=${state}`,
  exchangeGoogleCode: vi.fn(),
  handleGoogleCallback: vi.fn(),
}));
vi.mock("../providers/microsoft.js", () => ({
  isMicrosoftConfigured: () => true,
  getMicrosoftAuthUrl: (state: string) => `https://login.microsoftonline.com/mock?state=${state}`,
  exchangeMicrosoftCode: vi.fn(),
  microsoftGetGraphUserId: vi.fn(),
  microsoftIdentitySubject: (auth: { tenantId: string; objectId: string }) => `${auth.tenantId}:${auth.objectId}`,
}));
vi.mock("../ai/assistant.js", () => ({
  MAX_HISTORY_MESSAGES: 24,
  runAssistantChat: vi.fn(async () => ({ text: "Your next meeting is at 3pm." })),
  getRegistrationAssistReply: vi.fn(async () => "Happy to help — which would you like to do?"),
}));
vi.mock("../services/hub.js", () => ({
  hubListMessages: vi.fn().mockResolvedValue([]),
  hubListEvents: vi.fn().mockResolvedValue([]),
}));
vi.mock("../services/importantEmailAlerts.js", () => ({
  scanAndCurateImportantEmailsForOnboarding: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/conversationSummary.js", () => ({
  maybeUpdateConversationSummary: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/memoryExtraction.js", () => ({
  maybeExtractMemory: vi.fn().mockResolvedValue(undefined),
}));
// The fixed "carry on with setup" list alone decides here — no model call.
vi.mock("../services/setupIntent.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/setupIntent.js")>();
  return {
    ...actual,
    wantsToContinueSetup: async (_ownerId: number, body: string) => actual.isObviousContinue(body),
  };
});

const { sendWhatsAppMessage, sendWhatsAppReplyButtons, sendWhatsAppCtaUrl } = await import(
  "../providers/whatsapp.js"
);
const { exchangeGoogleCode } = await import("../providers/google.js");
const { exchangeMicrosoftCode } = await import("../providers/microsoft.js");
const { runAssistantChat } = await import("../ai/assistant.js");
const { authRoutes } = await import("./authRoutes.js");
const { handleIncoming } = await import("./whatsappRoutes.js");
const {
  addInvitedPhone,
  getPendingRegistration,
  getPendingSetup,
  resolveOwnerByPhone,
  getUser,
  getUserByEmail,
  listAccounts,
  getSetting,
  listWaitlistRequests,
  findOrCreateUserByEmail,
  addPhoneNumberForUser,
  resetOnboardingConnectionState,
  getReplayParkedOwner,
} = await import("../db/store.js");
const { getBriefingSettings } = await import("../services/briefing.js");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let counter = 0;
function freshPhone(): string {
  counter += 1;
  return `44700055${String(counter).padStart(4, "0")}`;
}

let messageCounter = 0;
function nextId(): string {
  messageCounter += 1;
  return `wamid.e2e.${messageCounter}`;
}

async function sendText(phone: string, text: string): Promise<void> {
  await handleIncoming({ kind: "text", from: phone, text, messageId: nextId() });
}

async function tap(phone: string, buttonId: string): Promise<void> {
  await handleIncoming({ kind: "interactive", from: phone, buttonId, messageId: nextId() });
}

// What Marlo said, oldest first — the plain-text messages and the button prompts interleaved is
// more than these assertions need, so each is read separately.
function messagesTo(phone: string): string[] {
  return vi
    .mocked(sendWhatsAppMessage)
    .mock.calls.filter(([to]) => to === phone)
    .map(([, body]) => body);
}

function buttonPromptsTo(phone: string): { text: string; ids: string[] }[] {
  return vi
    .mocked(sendWhatsAppReplyButtons)
    .mock.calls.filter(([to]) => to === phone)
    .map(([, text, buttons]) => ({ text, ids: buttons.map((b) => b.id) }));
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(authRoutes);
  return app;
}

function parseSetCookie(res: request.Response, name: string): string | undefined {
  const raw = res.headers["set-cookie"] as unknown as string[] | undefined;
  return raw?.find((c) => c.startsWith(`${name}=`));
}

// Walks the browser half of the flow exactly as tapping the CTA button does: the register route
// (which validates the token and sets the nonce cookie), then the provider's redirect back.
async function completeOAuth(phone: string, email: string): Promise<request.Response> {
  const link = vi
    .mocked(sendWhatsAppCtaUrl)
    .mock.calls.filter(([to]) => to === phone)
    .at(-1)![3];
  const token = new URL(link).searchParams.get("token")!;
  vi.mocked(exchangeGoogleCode).mockResolvedValue({
    email,
    accessToken: "at",
    refreshToken: "rt",
    expiryDate: Date.now() + 3600_000,
  });

  const app = buildApp();
  const start = await request(app).get(`/auth/google/register?token=${token}`);
  const nonce = parseSetCookie(start, "oauth_nonce")!;
  const state = new URL(start.headers.location!).searchParams.get("state")!;
  const res = await request(app)
    .get(`/auth/google/callback?code=realcode&state=${encodeURIComponent(state)}`)
    .set("Cookie", nonce);

  // The post-connect WhatsApp push is fired and not awaited by the callback (it reacts to a
  // browser round trip, not an inbound webhook), so wait for the chain it starts to land.
  for (let i = 0; i < 50 && getPendingSetup(resolveOwnerByPhone(phone) ?? -1) === null; i++) {
    await sleep(20);
  }
  return res;
}

beforeEach(() => {
  vi.mocked(sendWhatsAppMessage).mockClear();
  vi.mocked(sendWhatsAppReplyButtons).mockClear();
  vi.mocked(sendWhatsAppCtaUrl).mockClear();
  vi.mocked(runAssistantChat).mockClear();
});

describe("onboarding end to end — the happy path", () => {
  it("carries a brand-new number from an uninvited 'hi' to a working, briefing-enabled account", async () => {
    const phone = freshPhone();
    const email = `e2e-happy-${phone}@gmail.com`;

    // 1. Not invited yet: turned away, logged for an admin, no registration started.
    await sendText(phone, "hi");
    expect(messagesTo(phone).at(-1)).toContain("waitlist");
    expect(listWaitlistRequests().find((r) => r.phone === phone)?.requestCount).toBe(1);
    expect(getPendingRegistration(phone)).toBeNull();

    // 2. Invited, and they message again: the real chain starts.
    addInvitedPhone(phone);
    await sendText(phone, "hi");
    expect(messagesTo(phone).at(-1)).toContain("What would you like me to call you?");
    expect(getPendingRegistration(phone)?.step).toBe("awaiting_name");

    // 3. Their name — greeted, told what Marlo does, then asked about email.
    await sendText(phone, "Sam");
    expect(messagesTo(phone)).toContain("Hi Sam. I hope to be helpful with anything you could need.");
    expect(buttonPromptsTo(phone).at(-1)?.ids).toEqual(["email_confirm_yes", "email_confirm_no"]);

    // 4. Yes → the provider question, now with a way out as well as the two providers.
    await tap(phone, "email_confirm_yes");
    expect(buttonPromptsTo(phone).at(-1)?.ids).toEqual([
      "register_google",
      "register_microsoft",
      "register_skip",
    ]);

    // 5. Gmail → a real one-time link.
    await tap(phone, "register_google");
    expect(getPendingRegistration(phone)?.step).toBe("awaiting_link_tap");
    const [, , , link] = vi.mocked(sendWhatsAppCtaUrl).mock.calls.at(-1)!;
    expect(link).toContain("/auth/google/register?token=");

    // 6. The browser hop, for real, through the actual auth routes.
    const res = await completeOAuth(phone, email);
    expect(res.headers.location).toBe(`${process.env.CLIENT_URL ?? "http://localhost:5173"}/connected`);

    const ownerId = resolveOwnerByPhone(phone);
    expect(ownerId).not.toBeNull();
    expect(getUserByEmail(email)?.id).toBe(ownerId);
    expect(listAccounts(ownerId!, "google")).toHaveLength(1);
    // The name typed at step 3 carried across, so the chain doesn't ask for it again.
    expect(getSetting(ownerId!, "user_name")).toBe("Sam");
    expect(messagesTo(phone).some((m) => m.includes("*Connected!*"))).toBe(true);
    expect(getPendingSetup(ownerId!)).toBe("ask_first_task");

    // 7. Nothing to look at right now → the briefing question.
    await sendText(phone, "skip");
    expect(buttonPromptsTo(phone).at(-1)?.ids).toEqual(["briefing_yes", "briefing_no"]);

    // 8. Yes → saved, and (no Microsoft account, so no Teams question) the chain closes.
    await tap(phone, "briefing_yes");
    expect(getBriefingSettings(ownerId!).proactive).toBe(true);
    expect(messagesTo(phone).some((m) => m.includes("*All set!*"))).toBe(true);
    expect(getPendingSetup(ownerId!)).toBeNull();

    // 9. Onboarding is over: the next message is an ordinary one, answered by the assistant.
    await sendText(phone, "what's on today?");
    await sleep(150);
    expect(runAssistantChat).toHaveBeenCalled();
    expect(messagesTo(phone).at(-1)).toBe("Your next meeting is at 3pm.");
  });

  it("skips the provider question when the address they volunteer says which provider it is", async () => {
    const phone = freshPhone();
    addInvitedPhone(phone);
    await sendText(phone, "hi");
    await sendText(phone, "Margaret");

    await sendText(phone, `margaret-${phone}@gmail.com`);

    expect(buttonPromptsTo(phone).map((p) => p.ids)).not.toContainEqual([
      "register_google",
      "register_microsoft",
      "register_skip",
    ]);
    expect(sendWhatsAppCtaUrl).toHaveBeenCalledWith(
      phone,
      expect.stringContaining("*Gmail*"),
      "Connect Gmail",
      expect.stringContaining("/auth/google/register")
    );
  });
});

// The path that used to loop: every one of these points is past the single step that recognized
// a decline, so each was answered by re-asking the same question forever.
describe("onboarding end to end — backing out of email at each step", () => {
  it.each([
    ["the provider question, by tapping Not now", async (phone: string) => tap(phone, "register_skip")],
    ["the provider question, by typing", async (phone: string) => sendText(phone, "no thanks")],
  ])("finishes with a working phone-only account when they back out at %s", async (_label, backOut) => {
    const phone = freshPhone();
    addInvitedPhone(phone);
    await sendText(phone, "hi");
    await sendText(phone, "Sam");
    await tap(phone, "email_confirm_yes");

    await backOut(phone);

    const ownerId = resolveOwnerByPhone(phone);
    expect(ownerId).not.toBeNull();
    expect(getUser(ownerId!)?.email).toBeNull();
    expect(getSetting(ownerId!, "user_name")).toBe("Sam");
    expect(getPendingRegistration(phone)?.step).toBe("completed");
    expect(messagesTo(phone).at(-1)).toContain("If you want to connect your email in the future");

    // And the account actually works — the next message reaches the assistant rather than
    // bouncing off the registration flow.
    vi.mocked(runAssistantChat).mockClear();
    await sendText(phone, "remind me to call mum at 6");
    await sleep(150);
    expect(runAssistantChat).toHaveBeenCalled();
  });

  it("finishes with a working phone-only account when they back out after the link was sent", async () => {
    const phone = freshPhone();
    addInvitedPhone(phone);
    await sendText(phone, "hi");
    await sendText(phone, "Sam");
    await tap(phone, "email_confirm_yes");
    await tap(phone, "register_google");
    expect(getPendingRegistration(phone)?.step).toBe("awaiting_link_tap");

    await sendText(phone, "skip");

    expect(resolveOwnerByPhone(phone)).not.toBeNull();
    expect(getPendingRegistration(phone)?.step).toBe("completed");
  });

  it("still forwards a real question at the provider step instead of treating it as a decline", async () => {
    const phone = freshPhone();
    addInvitedPhone(phone);
    await sendText(phone, "hi");
    await sendText(phone, "Sam");
    await tap(phone, "email_confirm_yes");

    await sendText(phone, "no idea which one I have, how do I check?");

    expect(resolveOwnerByPhone(phone)).toBeNull();
    expect(getPendingRegistration(phone)?.step).toBe("awaiting_provider");
  });
});

describe("onboarding end to end — connecting email later", () => {
  it("lets someone who declined connect a mailbox afterwards without redoing registration", async () => {
    const phone = freshPhone();
    const email = `e2e-later-${phone}@gmail.com`;
    addInvitedPhone(phone);
    await sendText(phone, "hi");
    await sendText(phone, "Sam");
    await tap(phone, "email_confirm_no");
    const ownerId = resolveOwnerByPhone(phone)!;
    expect(getUser(ownerId).email).toBeNull();

    // What the assistant's connect_email tool does once they ask for it later.
    const { sendConnectLink } = await import("../services/connectMailboxLink.js");
    expect(await sendConnectLink(phone, "google")).toBe("sent");
    const res = await completeOAuth(phone, email);

    expect(res.headers.location).not.toContain("error=");
    // Same account, now with a mailbox on it — not a second one.
    expect(resolveOwnerByPhone(phone)).toBe(ownerId);
    expect(getUser(ownerId).email).toBe(email);
    expect(listAccounts(ownerId, "google")).toHaveLength(1);
    // Mid-conversation, so the chain skips the name and first-task questions it already has
    // answers for and goes straight to the briefing question.
    expect(getPendingSetup(ownerId)).toBe("ask_briefing");
  });
});

describe("onboarding end to end — a failed OAuth hop", () => {
  it("tells them on WhatsApp and leaves them able to retry with 'resend'", async () => {
    const phone = freshPhone();
    addInvitedPhone(phone);
    await sendText(phone, "hi");
    await sendText(phone, "Sam");
    await tap(phone, "email_confirm_yes");
    await tap(phone, "register_google");

    const link = vi.mocked(sendWhatsAppCtaUrl).mock.calls.at(-1)![3];
    const token = new URL(link).searchParams.get("token")!;
    vi.mocked(exchangeGoogleCode).mockRejectedValue(new Error("token endpoint exploded"));
    const app = buildApp();
    const start = await request(app).get(`/auth/google/register?token=${token}`);
    const nonce = parseSetCookie(start, "oauth_nonce")!;
    const state = new URL(start.headers.location!).searchParams.get("state")!;
    await request(app)
      .get(`/auth/google/callback?code=realcode&state=${encodeURIComponent(state)}`)
      .set("Cookie", nonce);

    expect(messagesTo(phone).at(-1)).toContain("resend");
    expect(resolveOwnerByPhone(phone)).toBeNull();

    // "resend" issues a fresh link, and the second attempt goes all the way through. The link
    // they were just told to ask for has to actually arrive: the resend cooldown is there to stop
    // someone mashing the button, not to refuse the one retry we just instructed them to make —
    // and "still working on it" is a lie once the attempt has already failed.
    vi.mocked(sendWhatsAppCtaUrl).mockClear();
    await sendText(phone, "resend");
    expect(messagesTo(phone).at(-1)).not.toContain("Still working on it");
    expect(sendWhatsAppCtaUrl).toHaveBeenCalled();
    await completeOAuth(phone, `e2e-retry-${phone}@gmail.com`);

    expect(resolveOwnerByPhone(phone)).not.toBeNull();
    expect(getPendingSetup(resolveOwnerByPhone(phone)!)).toBe("ask_first_task");
  });
});

// The app owner replayed his own onboarding and tried to finish it with a freshly created test
// Outlook address. It was refused — correctly, since replay deliberately leaves users.email alone
// and that account already has one — but the message claimed the brand-new address "already
// belongs to a Marlo account", so he went looking for the account holding it and then for the
// account-merge script. Nothing held it. The refusal is right; only the explanation was wrong.
describe("onboarding end to end — replaying onto an account that already has an address", () => {
  it("names the address the account actually has instead of blaming the new one", async () => {
    const phone = freshPhone();
    const existingEmail = `owner-${phone}@gmail.com`;
    addInvitedPhone(phone);

    // An established account on this number, exactly as it looks after replay-onboarding: the
    // phone unbound but parked, the address still on the row, no connected mailbox.
    const owner = findOrCreateUserByEmail(existingEmail);
    addPhoneNumberForUser(owner.id, phone);
    resetOnboardingConnectionState(owner.id);
    expect(resolveOwnerByPhone(phone)).toBeNull();
    expect(getReplayParkedOwner(phone)).toBe(owner.id);

    // Replay start to finish with a different provider and a brand-new address nobody holds.
    await sendText(phone, "hi");
    await sendText(phone, "Sam");
    await tap(phone, "email_confirm_yes");
    await tap(phone, "register_microsoft");
    const testAddress = `testing-${phone}@outlook.com`;
    expect(getUserByEmail(testAddress)).toBeFalsy();

    const link = vi.mocked(sendWhatsAppCtaUrl).mock.calls.at(-1)![3];
    const token = new URL(link).searchParams.get("token")!;
    vi.mocked(exchangeMicrosoftCode).mockResolvedValue({
      email: testAddress,
      accessToken: "at",
      refreshToken: "rt",
      expiryDate: Date.now() + 3600_000,
      tenantId: `tenant-${phone}`,
      objectId: `obj-${phone}`,
      graphUserId: `graph-${phone}`,
    });
    const app = buildApp();
    const start = await request(app).get(`/auth/microsoft/register?token=${token}`);
    const nonce = parseSetCookie(start, "oauth_nonce")!;
    const state = new URL(start.headers.location!).searchParams.get("state")!;
    await request(app)
      .get(`/auth/microsoft/callback?code=realcode&state=${encodeURIComponent(state)}`)
      .set("Cookie", nonce);

    const said = messagesTo(phone).at(-1)!;
    expect(said).toContain(existingEmail);
    expect(said).toContain("Settings");
    expect(said).not.toContain("already belongs to a Marlo account");
    // And nothing was damaged on the way past: the account keeps its address, the test address
    // is still unclaimed, and no orphan account was minted for it.
    expect(getUser(owner.id)?.email).toBe(existingEmail);
    expect(getUserByEmail(testAddress)).toBeFalsy();
  });
});
