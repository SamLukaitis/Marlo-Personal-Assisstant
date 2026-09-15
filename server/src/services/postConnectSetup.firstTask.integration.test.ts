// End-to-end regression for the ask_first_task step, through the real chatDispatch/messageBatching
// path (postConnectSetup.test.ts mocks handleText, which hid this). handleText only queues a message
// behind a debounce, so the briefing question used to go out before the assistant had answered —
// and the pending step had already moved on, so the assistant never saw its onboarding note.
import { it, expect, vi, beforeEach } from "vitest";

process.env.WHATSAPP_DEBOUNCE_SHORT_MS = "20";
process.env.WHATSAPP_DEBOUNCE_LONG_MS = "20";

const stepsSeenByAssistant: (string | null)[] = [];
vi.mock("../ai/assistant.js", async () => {
  const store = await import("../db/store.js");
  return {
    MAX_HISTORY_MESSAGES: 24,
    runAssistantChat: vi.fn(async (ownerId: number) => {
      stepsSeenByAssistant.push(store.getPendingSetup(ownerId));
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { text: "You've got a dentist appointment at 3pm." };
    }),
  };
});
vi.mock("../providers/whatsapp.js", () => ({
  sendWhatsAppMessage: vi.fn(async () => "wamid.out"),
  sendWhatsAppReplyButtons: vi.fn(async () => undefined),
  sendChoiceMessage: vi.fn(async () => undefined),
  sendWhatsAppReaction: vi.fn(async () => undefined),
}));
vi.mock("./hub.js", () => ({
  hubListMessages: vi.fn().mockResolvedValue([]),
  hubListEvents: vi.fn().mockResolvedValue([]),
}));
vi.mock("./importantEmailAlerts.js", () => ({
  scanAndCurateImportantEmailsForOnboarding: vi.fn().mockResolvedValue(null),
}));

const { sendWhatsAppMessage, sendWhatsAppReplyButtons } = await import("../providers/whatsapp.js");
const { runAssistantChat } = await import("../ai/assistant.js");
const store = await import("../db/store.js");
const { startPostConnectSetup, handleFirstTaskReply } = await import("./postConnectSetup.js");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let counter = 0;

async function ownerAtFirstTask(phone: string): Promise<number> {
  counter += 1;
  const ownerId = store.findOrCreateUserByEmail(`first-task-${Date.now()}-${counter}@example.com`).id;
  store.setSetting(ownerId, "user_name", "Sam");
  await startPostConnectSetup(ownerId, phone);
  expect(store.getPendingSetup(ownerId)).toBe("ask_first_task");
  return ownerId;
}

function text(from: string, body: string) {
  return { kind: "text" as const, from, text: body, messageId: `wamid.${Math.random()}` };
}

beforeEach(() => {
  stepsSeenByAssistant.length = 0;
  vi.mocked(sendWhatsAppMessage).mockClear();
  vi.mocked(sendWhatsAppReplyButtons).mockClear();
  vi.mocked(runAssistantChat).mockClear();
});

it("answers the request before asking the briefing question, with the onboarding step still visible to the assistant", async () => {
  const phone = "449990200001";
  const ownerId = await ownerAtFirstTask(phone);
  vi.mocked(sendWhatsAppMessage).mockClear();

  await handleFirstTaskReply(ownerId, text(phone, "What's on my calendar today?"));
  await sleep(400);

  expect(runAssistantChat).toHaveBeenCalledTimes(1);
  expect(stepsSeenByAssistant).toEqual(["ask_first_task"]);

  const answerCall = vi
    .mocked(sendWhatsAppMessage)
    .mock.calls.findIndex(([, body]) => body === "You've got a dentist appointment at 3pm.");
  expect(answerCall).toBeGreaterThanOrEqual(0);
  expect(sendWhatsAppReplyButtons).toHaveBeenCalledTimes(1);
  expect(vi.mocked(sendWhatsAppMessage).mock.invocationCallOrder[answerCall]).toBeLessThan(
    vi.mocked(sendWhatsAppReplyButtons).mock.invocationCallOrder[0]
  );
  expect(store.getPendingSetup(ownerId)).toBe("ask_briefing");
});

it("folds a follow-up sent before the answer into the same reply, and asks the briefing question once", async () => {
  const phone = "449990200002";
  const ownerId = await ownerAtFirstTask(phone);

  expect(await handleFirstTaskReply(ownerId, text(phone, "What's on my calendar"))).toBe(true);
  // Still waiting on the answer — this is a follow-up for the assistant, not a second first-task reply.
  expect(await handleFirstTaskReply(ownerId, text(phone, "today?"))).toBe(false);
  await sleep(400);

  expect(sendWhatsAppReplyButtons).toHaveBeenCalledTimes(1);
  expect(store.getPendingSetup(ownerId)).toBe("ask_briefing");
});
