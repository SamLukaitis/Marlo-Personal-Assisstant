// End-to-end regression for the mid-reply race, against the real SQLite history (messageBatching.test.ts
// covers the same logic with a mocked history). A message that arrives while Marlo is still
// generating a reply is saved BEFORE that reply, so matching batched messages to history by position
// sent Claude a request ending on Marlo's own reply — or overwrote that reply with the new message's
// quoted/document context.
import { it, expect, vi } from "vitest";

process.env.WHATSAPP_DEBOUNCE_SHORT_MS = "20";
process.env.WHATSAPP_DEBOUNCE_LONG_MS = "20";

const calls: { role: string; content: string }[][] = [];
vi.mock("../ai/assistant.js", () => ({
  MAX_HISTORY_MESSAGES: 24,
  runAssistantChat: vi.fn(async (_ownerId: number, history: { role: string; content: string }[]) => {
    calls.push(history.map((h) => ({ ...h })));
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { text: `reply#${calls.length}` };
  }),
}));
vi.mock("../providers/whatsapp.js", () => ({
  sendWhatsAppMessage: vi.fn(async () => "wamid.out"),
  sendWhatsAppTypingIndicator: vi.fn(async () => undefined),
  sendChoiceMessage: vi.fn(),
  sendWhatsAppReaction: vi.fn(),
}));

const store = await import("../db/store.js");
const { queueForAssistant } = await import("./messageBatching.js");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendBWhileReplyingToA(phone: string, overrideForB: string | null) {
  const user = store.findOrCreateUserByEmail(`batch-race-${phone}@example.com`);
  calls.length = 0;
  const aRow = store.appendWhatsAppMessage(user.id, phone, "user", "A");
  queueForAssistant(user.id, phone, "wamid.a", aRow, null, true);
  await sleep(50); // the call for A is now in flight
  const bRow = store.appendWhatsAppMessage(user.id, phone, "user", "B");
  queueForAssistant(user.id, phone, "wamid.b", bRow, overrideForB, true);
  await sleep(400);
  return calls[1].map((m) => `${m.role}:${m.content}`);
}

it("answers a plain message sent mid-reply as the latest user turn", async () => {
  expect(await sendBWhileReplyingToA("449990100001", null)).toEqual(["user:A", "assistant:reply#1", "user:B"]);
});

it("keeps the earlier reply intact when the mid-reply message carries extra context", async () => {
  expect(await sendBWhileReplyingToA("449990100002", "B + quoted context")).toEqual([
    "user:A",
    "assistant:reply#1",
    "user:B + quoted context",
  ]);
});
