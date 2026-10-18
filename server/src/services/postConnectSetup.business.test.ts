// Business-edition onboarding (feature-to-do/business-edition-phase-c.md item 4): the same chain
// as everyone else, but "what does your business do?" and "send me a receipt" replace the generic
// first-task question, and the briefing offer is about money, not headlines.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../providers/whatsapp.js", () => ({
  sendWhatsAppMessage: vi.fn(),
  sendWhatsAppReplyButtons: vi.fn(),
}));
vi.mock("./hub.js", () => ({
  hubListMessages: vi.fn().mockResolvedValue([]),
  hubListEvents: vi.fn().mockResolvedValue([]),
}));
vi.mock("./chatDispatch.js", () => ({
  handleText: vi.fn().mockResolvedValue(undefined),
}));
const mockWantsToContinue = vi.fn();
vi.mock("./setupIntent.js", async (importActual) => {
  const actual = await importActual<typeof import("./setupIntent.js")>();
  mockWantsToContinue.mockImplementation(async (_ownerId: number, body: string) => actual.isObviousContinue(body));
  return { ...actual, wantsToContinueSetup: (...args: unknown[]) => mockWantsToContinue(...args) };
});
vi.mock("./importantEmailAlerts.js", () => ({
  scanAndCurateImportantEmailsForOnboarding: vi.fn().mockResolvedValue(null),
}));

const { sendWhatsAppMessage, sendWhatsAppReplyButtons } = await import("../providers/whatsapp.js");
const { handleText } = await import("./chatDispatch.js");
const {
  startPostConnectSetup,
  handleNameReply,
  handleFirstTaskReply,
  handleBusinessReply,
  handleFirstReceiptReply,
  firstReceiptFollowUp,
  handlePostConnectSetupReply,
} = await import("./postConnectSetup.js");
const { findOrCreateUserByEmail, getPendingSetup, setPendingSetup, getSetting, setSetting, setUserEdition, upsertAccount } =
  await import("../db/store.js");
const { getBriefingSettings, saveBriefingSettings } = await import("./briefing.js");
const { getBusinessDescription } = await import("../business/profile.js");

let counter = 0;
function owner(edition: "general" | "business", name: string | null = "Sam"): number {
  counter += 1;
  const id = findOrCreateUserByEmail(`biz-onboarding-${Date.now()}-${counter}@example.com`).id;
  setUserEdition(id, edition);
  if (name) setSetting(id, "user_name", name);
  return id;
}

const PHONE = "447000002101";
const text = (body: string) => ({ kind: "text" as const, from: PHONE, text: body, messageId: `msg-${Math.random()}` });
const tap = (buttonId: string) => ({ kind: "interactive" as const, from: PHONE, buttonId, messageId: `msg-${Math.random()}` });
const media = () => ({
  kind: "media" as const,
  from: PHONE,
  mediaId: "m1",
  mimeType: "image/jpeg",
  messageId: `msg-${Math.random()}`,
});
const sentTexts = () => vi.mocked(sendWhatsAppMessage).mock.calls.map((c) => c[1] as string);
const lastButtonsPrompt = () => vi.mocked(sendWhatsAppReplyButtons).mock.calls.at(-1)?.[1] as string | undefined;

beforeEach(() => {
  vi.mocked(sendWhatsAppMessage).mockClear();
  vi.mocked(sendWhatsAppReplyButtons).mockClear();
  vi.mocked(handleText).mockClear().mockResolvedValue(undefined);
  mockWantsToContinue.mockClear();
});

describe("start of the chain", () => {
  it("a named business user is asked what their business does, not the generic first-task question", async () => {
    const id = owner("business");
    await startPostConnectSetup(id, PHONE);
    expect(getPendingSetup(id)).toBe("ask_business");
    expect(sentTexts().at(-1)).toContain("What does your business do");
    expect(sentTexts().join("\n")).not.toContain("Anything you'd like me to look at");
  });

  it("an unnamed business user is asked their name first, then about the business", async () => {
    const id = owner("business", null);
    await startPostConnectSetup(id, PHONE);
    expect(getPendingSetup(id)).toBe("ask_name");
    await handleNameReply(id, text("Sam"));
    expect(getPendingSetup(id)).toBe("ask_business");
  });

  it("skipping the name still leads to the business question", async () => {
    const id = owner("business", null);
    await startPostConnectSetup(id, PHONE);
    await handleNameReply(id, text("skip"));
    expect(getPendingSetup(id)).toBe("ask_business");
  });

  it("general users are untouched: they still get the first-task question", async () => {
    const id = owner("general");
    await startPostConnectSetup(id, PHONE);
    expect(getPendingSetup(id)).toBe("ask_first_task");
  });
});

describe("ask_business", () => {
  async function atBusinessStep() {
    const id = owner("business");
    await startPostConnectSetup(id, PHONE);
    vi.mocked(sendWhatsAppMessage).mockClear();
    return id;
  }

  it("saves a description and moves on to the receipt invitation", async () => {
    const id = await atBusinessStep();
    expect(await handleBusinessReply(id, text("Plumber in Leeds"))).toBe(true);
    expect(getBusinessDescription(id)).toBe("Plumber in Leeds");
    expect(getPendingSetup(id)).toBe("ask_first_receipt");
    expect(sentTexts().at(-1)).toContain("photo of any receipt");
    expect(handleText).not.toHaveBeenCalled();
  });

  it("trims and caps a very long description", async () => {
    const id = await atBusinessStep();
    await handleBusinessReply(id, text(`  ${"carpentry ".repeat(60)}  `));
    const saved = getBusinessDescription(id)!;
    expect(saved.length).toBeLessThanOrEqual(200);
    expect(saved.startsWith("carpentry")).toBe(true);
  });

  it("skip saves nothing and moves on", async () => {
    const id = await atBusinessStep();
    await handleBusinessReply(id, text("skip"));
    expect(getBusinessDescription(id)).toBeNull();
    expect(getPendingSetup(id)).toBe("ask_first_receipt");
  });

  it("a blank reply counts as a skip", async () => {
    const id = await atBusinessStep();
    await handleBusinessReply(id, text("   "));
    expect(getBusinessDescription(id)).toBeNull();
    expect(getPendingSetup(id)).toBe("ask_first_receipt");
  });

  it.each(["what can you do?", "How does this work", "Can you read invoices from email?"])(
    "a question (%s) goes to the assistant, isn't saved as the description, and the chain waits for the answer",
    async (q) => {
      const id = await atBusinessStep();
      await handleBusinessReply(id, text(q));
      expect(getBusinessDescription(id)).toBeNull();
      expect(handleText).toHaveBeenCalledTimes(1);
      // Not advanced until the assistant has replied…
      expect(getPendingSetup(id)).toBe("ask_business");
      const afterReply = vi.mocked(handleText).mock.calls[0][6] as () => Promise<void>;
      await afterReply();
      // …then on to the receipt invitation.
      expect(getPendingSetup(id)).toBe("ask_first_receipt");
    }
  );

  it("ignores button taps and media while waiting for the answer", async () => {
    const id = await atBusinessStep();
    expect(await handleBusinessReply(id, tap("briefing_yes"))).toBe(false);
    expect(await handleBusinessReply(id, media() as never)).toBe(false);
    expect(getPendingSetup(id)).toBe("ask_business");
  });

  it("does nothing when another step is pending", async () => {
    const id = owner("business");
    setPendingSetup(id, "ask_briefing");
    expect(await handleBusinessReply(id, text("Plumber"))).toBe(false);
    expect(getBusinessDescription(id)).toBeNull();
  });

  it("the other free-text handlers leave this step alone", async () => {
    const id = await atBusinessStep();
    expect(await handleNameReply(id, text("Plumber"))).toBe(false);
    expect(await handleFirstTaskReply(id, text("Plumber"))).toBe(false);
  });
});

describe("ask_first_receipt", () => {
  async function atReceiptStep() {
    const id = owner("business");
    await startPostConnectSetup(id, PHONE);
    await handleBusinessReply(id, text("Electrician"));
    vi.mocked(sendWhatsAppMessage).mockClear();
    return id;
  }

  it("skip moves on to the business briefing question", async () => {
    const id = await atReceiptStep();
    expect(await handleFirstReceiptReply(id, text("skip"))).toBe(true);
    expect(getPendingSetup(id)).toBe("ask_briefing");
    expect(lastButtonsPrompt()).toMatch(/money/i);
  });

  it("a typed request goes to the assistant first, then the briefing question", async () => {
    const id = await atReceiptStep();
    await handleFirstReceiptReply(id, text("I paid £40 for fuel yesterday"));
    expect(handleText).toHaveBeenCalledTimes(1);
    expect(getPendingSetup(id)).toBe("ask_first_receipt");
    await (vi.mocked(handleText).mock.calls[0][6] as () => Promise<void>)();
    expect(getPendingSetup(id)).toBe("ask_briefing");
  });

  it("a receipt photo: the step waits for the assistant's reply, then asks about the briefing once", async () => {
    const id = await atReceiptStep();
    // Media isn't consumed by the text handler — it goes through normal document handling…
    expect(await handleFirstReceiptReply(id, media() as never)).toBe(false);
    const follow = firstReceiptFollowUp(id, PHONE);
    expect(follow).toBeDefined();
    // …and the step stays pending (so the assistant knows it's mid-setup) until the reply is sent.
    expect(getPendingSetup(id)).toBe("ask_first_receipt");
    await follow!();
    expect(getPendingSetup(id)).toBe("ask_briefing");
    expect(vi.mocked(sendWhatsAppReplyButtons)).toHaveBeenCalledTimes(1);
  });

  it("two receipt photos in a row advance the chain only once", async () => {
    const id = await atReceiptStep();
    const a = firstReceiptFollowUp(id, PHONE)!;
    const b = firstReceiptFollowUp(id, PHONE)!;
    await a();
    await b();
    expect(vi.mocked(sendWhatsAppReplyButtons)).toHaveBeenCalledTimes(1);
    expect(getPendingSetup(id)).toBe("ask_briefing");
  });

  it("no follow-up outside this step (general users, or later in the chain)", async () => {
    expect(firstReceiptFollowUp(owner("general"), PHONE)).toBeUndefined();
    const id = owner("business");
    setPendingSetup(id, "ask_briefing");
    expect(firstReceiptFollowUp(id, PHONE)).toBeUndefined();
  });
});

describe("business briefing question", () => {
  async function atBriefingStep(withMicrosoft = false) {
    const id = owner("business");
    if (withMicrosoft) {
      upsertAccount(id, {
        provider: "microsoft",
        email: `ms-${counter}@example.com`,
        accessToken: "x",
        refreshToken: "y",
        expiryDate: Date.now() + 3600_000,
      } as never);
    }
    await startPostConnectSetup(id, PHONE);
    await handleBusinessReply(id, text("Photographer"));
    await handleFirstReceiptReply(id, text("skip"));
    vi.mocked(sendWhatsAppMessage).mockClear();
    return id;
  }

  it("yes turns on the morning message without headlines", async () => {
    const id = await atBriefingStep();
    await handlePostConnectSetupReply(id, tap("briefing_yes"));
    const s = getBriefingSettings(id);
    expect(s.proactive).toBe(true);
    expect(s.includeNews).toBe(false);
    expect(s.topics).toEqual([]);
    const said = sentTexts().join("\n");
    expect(said).not.toMatch(/headline/i);
    expect(said).toMatch(/Monday/);
  });

  it("no leaves it off", async () => {
    const id = await atBriefingStep();
    await handlePostConnectSetupReply(id, tap("briefing_no"));
    expect(getBriefingSettings(id).proactive).toBe(false);
  });

  it("a Microsoft-connected business user is still asked about Teams afterwards", async () => {
    const id = await atBriefingStep(true);
    await handlePostConnectSetupReply(id, tap("briefing_yes"));
    expect(getPendingSetup(id)).toBe("ask_teams");
  });

  it("without Microsoft, the chain ends with the closing message", async () => {
    const id = await atBriefingStep();
    await handlePostConnectSetupReply(id, tap("briefing_no"));
    expect(getPendingSetup(id)).toBeNull();
    expect(sentTexts().join("\n")).toContain("All set");
  });

  it("general users still get headlines on yes", async () => {
    const id = owner("general");
    setPendingSetup(id, "ask_briefing");
    await handlePostConnectSetupReply(id, tap("briefing_yes"));
    expect(getBriefingSettings(id).includeNews).toBe(true);
  });
});

describe("linking a mailbox later (existing business account)", () => {
  it("gets the business briefing question, not the business/receipt steps", async () => {
    const id = owner("business");
    await startPostConnectSetup(id, PHONE, true);
    expect(getPendingSetup(id)).toBe("ask_briefing");
    expect(lastButtonsPrompt()).toMatch(/money/i);
  });

  it("keeps briefing settings they already chose", async () => {
    const id = owner("business");
    saveBriefingSettings(id, { ...getBriefingSettings(id), includeNews: true, topics: ["tech"] });
    await startPostConnectSetup(id, PHONE, true);
    expect(getPendingSetup(id)).not.toBe("ask_briefing");
    expect(getBriefingSettings(id).topics).toEqual(["tech"]);
  });
});

describe("edition switched mid-setup", () => {
  it("a business step already pending still completes for someone switched to general", async () => {
    const id = owner("business");
    await startPostConnectSetup(id, PHONE);
    setUserEdition(id, "general");
    expect(await handleBusinessReply(id, text("skip"))).toBe(true);
    expect(getPendingSetup(id)).toBe("ask_first_receipt");
    await handleFirstReceiptReply(id, text("skip"));
    // From here they're on general, so the briefing offer is the general one.
    expect(lastButtonsPrompt()).not.toMatch(/money/i);
  });
});

// Keeps getSetting imported for parity with the general suite's helpers.
void getSetting;
