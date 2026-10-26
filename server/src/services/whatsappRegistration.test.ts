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
  removeInvitedPhone,
  listWaitlistRequests,
  deletePendingRegistration,
  resolveOwnerByPhone,
  getUser,
  getSetting,
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

    expect(sendWhatsAppMessage).toHaveBeenCalledWith(phone, expect.stringContaining("on the waitlist"));
    expect(sendWhatsAppMessage).not.toHaveBeenCalledWith(phone, expect.stringContaining("I'm *Marlowe*"));
    expect(getPendingRegistration(phone)).toBeNull();
  });

  it("starts the real registration chain for an invited number", async () => {
    const phone = freshPhone();
    addInvitedPhone(phone);

    await handlePendingRegistration({ kind: "text", from: phone, text: "hi", messageId: "m1" });

    expect(sendWhatsAppMessage).toHaveBeenCalledWith(phone, expect.stringContaining("I'm *Marlowe*"));
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

// An uninvited number isn't just turned away — it's logged so admins can see who asked
// (Settings → Waitlist). Being on the waitlist grants nothing; invited_phones is still the gate.
describe("handlePendingRegistration — waitlist", () => {
  it("records the request and sends the full explanation on first contact", async () => {
    const phone = freshPhone();

    await handlePendingRegistration({ kind: "text", from: phone, text: "hi", messageId: "m1" });

    expect(sendWhatsAppMessage).toHaveBeenCalledWith(
      phone,
      expect.stringContaining("Thank you for your interest")
    );
    const entry = listWaitlistRequests().find((r) => r.phone === phone);
    expect(entry).toBeDefined();
    expect(entry?.requestCount).toBe(1);
  });

  it("asks for a name on first contact", async () => {
    const phone = freshPhone();
    await handlePendingRegistration({ kind: "text", from: phone, text: "hi", messageId: "m1" });

    expect(sendWhatsAppMessage).toHaveBeenCalledWith(phone, expect.stringContaining("what's your name"));
    expect(listWaitlistRequests().find((r) => r.phone === phone)?.name).toBeNull();
  });

  it("stores the reply as the name and confirms", async () => {
    const phone = freshPhone();
    await handlePendingRegistration({ kind: "text", from: phone, text: "hi", messageId: "m1" });
    vi.mocked(sendWhatsAppMessage).mockClear();

    await handlePendingRegistration({ kind: "text", from: phone, text: "Sam Jones", messageId: "m2" });

    expect(listWaitlistRequests().find((r) => r.phone === phone)?.name).toBe("Sam Jones");
    expect(sendWhatsAppMessage).toHaveBeenCalledWith(phone, expect.stringContaining("Thanks Sam Jones"));
  });

  it("asks once more for a non-name reply, then gives up and sends the nudge", async () => {
    const phone = freshPhone();
    await handlePendingRegistration({ kind: "text", from: phone, text: "hi", messageId: "m1" });
    vi.mocked(sendWhatsAppMessage).mockClear();

    await handlePendingRegistration({ kind: "text", from: phone, text: "what is this, who are you?", messageId: "m2" });
    expect(sendWhatsAppMessage).toHaveBeenCalledWith(phone, expect.stringContaining("didn't catch that"));
    vi.mocked(sendWhatsAppMessage).mockClear();

    await handlePendingRegistration({ kind: "text", from: phone, text: "still not a name!!", messageId: "m3" });
    expect(sendWhatsAppMessage).toHaveBeenCalledWith(phone, expect.stringContaining("still on the waitlist"));
    expect(listWaitlistRequests().find((r) => r.phone === phone)?.name).toBe("");
  });

  it("sends the short nudge instead of the full message once named", async () => {
    const phone = freshPhone();
    await handlePendingRegistration({ kind: "text", from: phone, text: "hi", messageId: "m1" });
    await handlePendingRegistration({ kind: "text", from: phone, text: "Sam", messageId: "m2" });
    vi.mocked(sendWhatsAppMessage).mockClear();

    await handlePendingRegistration({ kind: "text", from: phone, text: "hello?", messageId: "m3" });

    expect(sendWhatsAppMessage).toHaveBeenCalledWith(
      phone,
      expect.stringContaining("still on the waitlist")
    );
    expect(sendWhatsAppMessage).not.toHaveBeenCalledWith(
      phone,
      expect.stringContaining("Thank you for your interest")
    );
  });

  it("skips the name question for an invited number whose waitlist name was carried over", async () => {
    const phone = freshPhone();
    addInvitedPhone(phone, undefined, "Margaret");

    await handlePendingRegistration({ kind: "text", from: phone, text: "hi", messageId: "m1" });

    expect(sendWhatsAppMessage).toHaveBeenCalledWith(phone, expect.stringContaining("Hi Margaret, I'm *Marlowe*"));
    expect(sendWhatsAppMessage).not.toHaveBeenCalledWith(phone, expect.stringContaining("What would you like me to call you"));
    expect(sendWhatsAppReplyButtons).toHaveBeenCalled();
    const row = getPendingRegistration(phone);
    expect(row?.step).toBe("awaiting_email_confirm");
    expect(row?.name).toBe("Margaret");
  });

  it("counts repeat attempts on one entry rather than adding duplicates", async () => {
    const phone = freshPhone();

    for (const id of ["m1", "m2", "m3"]) {
      await handlePendingRegistration({ kind: "text", from: phone, text: "Sam", messageId: id });
    }

    const entries = listWaitlistRequests().filter((r) => r.phone === phone);
    expect(entries).toHaveLength(1);
    expect(entries[0].requestCount).toBe(3);
    expect(entries[0].lastRequestedAt).toBeGreaterThanOrEqual(entries[0].firstRequestedAt);
  });

  // The waitlist is a record of who asked, not a permission — an invited number must never be
  // diverted into it, and an uninvited one must never get past the gate by being on it.
  it("never records an invited number", async () => {
    const phone = freshPhone();
    addInvitedPhone(phone);

    await handlePendingRegistration({ kind: "text", from: phone, text: "hi", messageId: "m1" });

    expect(listWaitlistRequests().find((r) => r.phone === phone)).toBeUndefined();
    expect(getPendingRegistration(phone)?.step).toBe("awaiting_name");
  });

  it("does not let a waitlisted number register until it is actually invited", async () => {
    const phone = freshPhone();
    await handlePendingRegistration({ kind: "text", from: phone, text: "hi", messageId: "m1" });
    expect(listWaitlistRequests().find((r) => r.phone === phone)).toBeDefined();

    await handlePendingRegistration({ kind: "text", from: phone, text: "Sam", messageId: "m2" });

    expect(getPendingRegistration(phone)).toBeNull();
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
      { id: "register_skip", title: "Not now" },
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
      expect.stringContaining("already connected to a Marlowe account")
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

// Accepting no longer asks for the address first: it was only ever an OAuth login_hint, and the
// callback (authRoutes.ts) decides the identity and the "already taken" question for itself. Two
// taps to a link instead of a typed address in between.
describe("handlePendingRegistration — accepting email goes straight to the provider buttons", () => {
  it("asks Gmail-or-Outlook on a Yes tap instead of asking for an address", async () => {
    const phone = freshPhone();
    addInvitedPhone(phone);
    upsertPendingRegistration(phone, { step: "awaiting_email_confirm", name: "Sam" });

    await handlePendingRegistration({
      kind: "interactive",
      from: phone,
      messageId: "m1",
      buttonId: "email_confirm_yes",
    });

    expect(sendWhatsAppReplyButtons).toHaveBeenCalledWith(phone, "Do you use Gmail or Outlook/Hotmail?", [
      { id: "register_google", title: "Gmail" },
      { id: "register_microsoft", title: "Outlook" },
      { id: "register_skip", title: "Not now" },
    ]);
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(getPendingRegistration(phone)?.step).toBe("awaiting_provider");
  });

  it("takes the same route for a typed yes", async () => {
    const phone = freshPhone();
    addInvitedPhone(phone);
    upsertPendingRegistration(phone, { step: "awaiting_email_confirm", name: "Sam" });

    await handlePendingRegistration({ kind: "text", from: phone, text: "yes", messageId: "m1" });

    expect(getPendingRegistration(phone)?.step).toBe("awaiting_provider");
  });

  // The address is still accepted from anyone who volunteers it — it skips the provider question
  // when the domain is unambiguous, and is kept as the login_hint either way.
  it("still short-circuits to the link when they send an address instead of tapping", async () => {
    const phone = freshPhone();
    addInvitedPhone(phone);
    upsertPendingRegistration(phone, { step: "awaiting_email_confirm", name: "Sam" });

    await handlePendingRegistration({
      kind: "text",
      from: phone,
      text: `sam+${phone}@gmail.com`,
      messageId: "m1",
    });

    expect(sendWhatsAppCtaUrl).toHaveBeenCalledWith(
      phone,
      expect.stringContaining("*Gmail*"),
      "Connect Gmail",
      expect.stringContaining("/auth/google/register")
    );
    expect(getPendingRegistration(phone)?.typedEmail).toBe(`sam+${phone}@gmail.com`);
  });
});

// Declining email is a real choice, not a dead end: it creates a working account so the very next
// message goes to the assistant instead of back into registration. Before this existed, Marlowe
// said "let me know how I can help!" and then deflected every request back to the email question.
describe("handlePendingRegistration — declining email creates a phone-only account", () => {
  it("creates an account with no email, bound to the number", async () => {
    const phone = freshPhone();
    addInvitedPhone(phone);
    upsertPendingRegistration(phone, { step: "awaiting_email_confirm", name: "Sam" });

    await handlePendingRegistration({
      kind: "interactive",
      from: phone,
      messageId: "m1",
      buttonId: "email_confirm_no",
    });

    const ownerId = resolveOwnerByPhone(phone);
    expect(ownerId).not.toBeNull();
    expect(getUser(ownerId!)?.email).toBeNull();
  });

  it("carries the captured name onto the new account", async () => {
    const phone = freshPhone();
    addInvitedPhone(phone);
    upsertPendingRegistration(phone, { step: "awaiting_email_confirm", name: "Margaret" });

    await handlePendingRegistration({
      kind: "interactive",
      from: phone,
      messageId: "m1",
      buttonId: "email_confirm_no",
    });

    expect(getSetting(resolveOwnerByPhone(phone)!, "user_name")).toBe("Margaret");
  });

  it("marks the registration completed so the next message leaves the registration flow", async () => {
    const phone = freshPhone();
    addInvitedPhone(phone);
    upsertPendingRegistration(phone, { step: "awaiting_email_confirm", name: "Sam" });

    await handlePendingRegistration({
      kind: "interactive",
      from: phone,
      messageId: "m1",
      buttonId: "email_confirm_no",
    });

    expect(getPendingRegistration(phone)?.step).toBe("completed");
  });

  // Proves handlePendingRegistration itself stops treating the number as still-in-registration
  // once No is tapped (step is "completed", so a follow-up here hits the no-op case rather than
  // getRegistrationAssistReply). It does NOT prove the message reaches the assistant — that
  // depends on whatsappRoutes.ts's resolveOwnerByPhone fork, which is a separate module this file
  // doesn't exercise; see "handleIncoming — routing after an account exists" in
  // whatsappRoutes.test.ts for that end-to-end proof, and the "creates an account..." test above
  // for the resolveOwnerByPhone fact that fork actually branches on.
  it("does not re-ask for an email when they send a real request afterwards", async () => {
    const phone = freshPhone();
    addInvitedPhone(phone);
    upsertPendingRegistration(phone, { step: "awaiting_email_confirm", name: "Sam" });
    await handlePendingRegistration({
      kind: "interactive",
      from: phone,
      messageId: "m1",
      buttonId: "email_confirm_no",
    });
    vi.mocked(sendWhatsAppMessage).mockClear();
    vi.mocked(sendWhatsAppReplyButtons).mockClear();

    await handlePendingRegistration({
      kind: "text",
      from: phone,
      text: "remind me to call mum at 6",
      messageId: "m2",
    });

    expect(sendWhatsAppReplyButtons).not.toHaveBeenCalled();
    expect(sendWhatsAppMessage).not.toHaveBeenCalledWith(phone, expect.stringContaining("email"));
  });

  // Phone-only testers were promised "to-dos", which Marlowe doesn't have, and given no idea of
  // what does work without a mailbox. The reply now names things that need no email at all.
  it("tells them what works without email, and promises nothing that doesn't exist", async () => {
    const phone = freshPhone();
    addInvitedPhone(phone);
    upsertPendingRegistration(phone, { step: "awaiting_email_confirm", name: "Sam" });

    await handlePendingRegistration({
      kind: "interactive",
      from: phone,
      messageId: "m1",
      buttonId: "email_confirm_no",
    });

    const reply = vi
      .mocked(sendWhatsAppMessage)
      .mock.calls.map(([, text]) => text)
      .find((text) => text.startsWith("No problem"));
    expect(reply).toBeDefined();
    expect(reply).not.toMatch(/to-?dos?\b/i);
    expect(reply).toMatch(/remind/i);
    expect(reply).toMatch(/flight/i);
    expect(reply).toMatch(/photo/i);
  });

  // A sentence is not a name (plausibleName.ts) — it must not become a permanent display name.
  it("stores no name when what they typed was not a plausible one", async () => {
    const phone = freshPhone();
    addInvitedPhone(phone);
    upsertPendingRegistration(phone, { step: "awaiting_email_confirm", name: "" });

    await handlePendingRegistration({
      kind: "interactive",
      from: phone,
      messageId: "m1",
      buttonId: "email_confirm_no",
    });

    // getSetting returns null (not undefined) for a missing key.
    expect(getSetting(resolveOwnerByPhone(phone)!, "user_name")).toBeNull();
  });

  // The hole this closes: once an account exists, resolveOwnerByPhone resolves the number and
  // the invite gate is never consulted for it again — so if No skipped this re-check, a number
  // revoked mid-conversation would get permanent access via a single tap.
  it("does not create an account if the invite was revoked while awaiting the email choice", async () => {
    const phone = freshPhone();
    addInvitedPhone(phone);
    upsertPendingRegistration(phone, { step: "awaiting_email_confirm", name: "Sam" });
    removeInvitedPhone(phone); // simulates an admin revoke mid-conversation

    await handlePendingRegistration({
      kind: "interactive",
      from: phone,
      messageId: "m1",
      buttonId: "email_confirm_no",
    });

    expect(resolveOwnerByPhone(phone)).toBeNull();
  });
});

// Pre-existing narrow regex, widened here — "nah"/"nope"/"no thx" used to fall through to
// getRegistrationAssistReply, the exact deflection this task removes, just for a different set of
// typed words than "no"/"n".
describe("handlePendingRegistration — typed decline recognizes common short forms", () => {
  it.each(["nah", "nope", "no thx"])("treats %s as a decline, same as tapping No", async (text) => {
    const phone = freshPhone();
    addInvitedPhone(phone);
    upsertPendingRegistration(phone, { step: "awaiting_email_confirm", name: "Sam" });

    await handlePendingRegistration({ kind: "text", from: phone, text, messageId: "m1" });

    expect(resolveOwnerByPhone(phone)).not.toBeNull();
    expect(getPendingRegistration(phone)?.step).toBe("completed");
  });

  // A longer sentence that happens to start with a decline word is real free text, not a decline
  // — it must still reach the assistant-backed help reply instead of being misread.
  it("does not treat a longer sentence starting with a decline word as a decline", async () => {
    const phone = freshPhone();
    addInvitedPhone(phone);
    upsertPendingRegistration(phone, { step: "awaiting_email_confirm", name: "Sam" });

    await handlePendingRegistration({
      kind: "text",
      from: phone,
      text: "nope not sure what my email is",
      messageId: "m1",
    });

    expect(resolveOwnerByPhone(phone)).toBeNull();
    expect(getPendingRegistration(phone)?.step).toBe("awaiting_email_confirm");
  });
});

// ---------------------------------------------------------------------------
// Escaping the email flow after it has already started. Declining used to be recognized at
// exactly one step (awaiting_email_confirm) — past it, every "actually, no thanks" fell through
// to getRegistrationAssistReply, whose prompt for each of these steps ends by re-asking the same
// question. Tapping Yes and then changing your mind was an unbreakable loop.
// ---------------------------------------------------------------------------
describe("handlePendingRegistration — declining after the email flow has started", () => {
  it.each([
    ["awaiting_provider", "no thanks"],
    ["awaiting_email", "not now"],
    ["awaiting_link_tap", "nah"],
  ] as const)("treats a decline at %s as skipping email entirely", async (step, text) => {
    const phone = freshPhone();
    addInvitedPhone(phone);
    upsertPendingRegistration(phone, { step, name: "Sam", provider: "google" });

    await handlePendingRegistration({ kind: "text", from: phone, text, messageId: "m1" });

    expect(resolveOwnerByPhone(phone)).not.toBeNull();
    expect(getPendingRegistration(phone)?.step).toBe("completed");
  });

  it("recognizes 'skip' as a decline too, since the prompts now offer it by name", async () => {
    const phone = freshPhone();
    addInvitedPhone(phone);
    upsertPendingRegistration(phone, { step: "awaiting_provider", name: "Sam" });

    await handlePendingRegistration({ kind: "text", from: phone, text: "skip", messageId: "m1" });

    expect(getPendingRegistration(phone)?.step).toBe("completed");
  });

  it("does not misread a longer sentence at awaiting_provider as a decline", async () => {
    const phone = freshPhone();
    addInvitedPhone(phone);
    upsertPendingRegistration(phone, { step: "awaiting_provider", name: "Sam" });

    await handlePendingRegistration({
      kind: "text",
      from: phone,
      text: "no idea which one I have, how do I check?",
      messageId: "m1",
    });

    expect(resolveOwnerByPhone(phone)).toBeNull();
    expect(getPendingRegistration(phone)?.step).toBe("awaiting_provider");
  });

  // The tap-only path needs its own exit: someone who has tapped every button so far has no
  // tappable way to back out of the provider question.
  it("offers a third 'Not now' button on the provider question and honours the tap", async () => {
    const phone = freshPhone();
    addInvitedPhone(phone);
    upsertPendingRegistration(phone, { step: "awaiting_email_confirm", name: "Sam" });

    await handlePendingRegistration({
      kind: "interactive",
      from: phone,
      messageId: "m1",
      buttonId: "email_confirm_yes",
    });

    expect(sendWhatsAppReplyButtons).toHaveBeenCalledWith(phone, expect.any(String), [
      { id: "register_google", title: "Gmail" },
      { id: "register_microsoft", title: "Outlook" },
      { id: "register_skip", title: "Not now" },
    ]);

    await handlePendingRegistration({
      kind: "interactive",
      from: phone,
      messageId: "m2",
      buttonId: "register_skip",
    });

    expect(resolveOwnerByPhone(phone)).not.toBeNull();
    expect(getPendingRegistration(phone)?.step).toBe("completed");
  });
});

// An address already bound to another account left the step unchanged, so retyping the same
// address (likely — it may be their only one) replayed the identical message forever.
describe("handlePendingRegistration — already-connected address is not a dead end", () => {
  it("tells them how to get out as well as what went wrong", async () => {
    const phone = freshPhone();
    const taken = `taken+${phone}@gmail.com`;
    addInvitedPhone(phone);
    const other = findOrCreateUserByEmail(taken);
    addPhoneNumberForUser(other.id, freshPhone());
    upsertPendingRegistration(phone, { step: "awaiting_email", name: "Sam" });

    await handlePendingRegistration({ kind: "text", from: phone, text: taken, messageId: "m1" });

    expect(sendWhatsAppMessage).toHaveBeenCalledWith(phone, expect.stringContaining("already connected"));
    expect(sendWhatsAppMessage).toHaveBeenCalledWith(phone, expect.stringContaining("skip"));
  });
});

// redirectToSetup asked for a name at every step — send a photo while waiting on the OAuth link
// and you were told to introduce yourself, then your name was answered with "tap the link".
describe("handlePendingRegistration — mistimed media points at the actual current step", () => {
  it("repeats the link prompt, not the name question, at awaiting_link_tap", async () => {
    const phone = freshPhone();
    addInvitedPhone(phone);
    upsertPendingRegistration(phone, { step: "awaiting_link_tap", name: "Sam", provider: "google" });

    await handlePendingRegistration({
      kind: "media",
      from: phone,
      messageId: "m1",
      mediaId: "media-1",
      mimeType: "image/jpeg",
    });

    expect(sendWhatsAppMessage).toHaveBeenCalledWith(phone, expect.stringContaining("Tap the link"));
    expect(sendWhatsAppMessage).not.toHaveBeenCalledWith(phone, expect.stringContaining("what should I call you"));
  });

  it("still asks for a name when that really is the current step", async () => {
    const phone = freshPhone();
    addInvitedPhone(phone);
    upsertPendingRegistration(phone, { step: "awaiting_name" });

    await handlePendingRegistration({
      kind: "unsupported",
      from: phone,
      messageId: "m1",
      type: "sticker",
    });

    expect(sendWhatsAppMessage).toHaveBeenCalledWith(phone, expect.stringContaining("what should I call you"));
  });
});
