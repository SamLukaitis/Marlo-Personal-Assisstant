import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Records what would go out over WhatsApp, in order, instead of calling the Graph API.
const sent: string[] = [];
vi.mock("./whatsapp.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./whatsapp.js")>()),
  sendJoyceMessage: vi.fn(async (_to: string, text: string) => {
    sent.push(`text: ${text}`);
  }),
  sendJoyceButtons: vi.fn(async (_to: string, text: string, buttons: { title: string }[]) => {
    sent.push(`buttons: ${text} [${buttons.map((b) => b.title).join(" | ")}]`);
  }),
}));

const { sendJoyceReply } = await import("./routes.js");

describe("sendJoyceReply", () => {
  beforeEach(() => {
    sent.length = 0;
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  async function send(...args: Parameters<typeof sendJoyceReply>) {
    const done = sendJoyceReply(...args);
    await vi.runAllTimersAsync();
    await done;
  }

  it("sends each message in order, with the buttons on the one that has them", async () => {
    await send("447000000001", [
      { text: "One." },
      { text: "Two." },
      { text: "Pick one?", buttons: [{ id: "a", title: "A" }, { id: "b", title: "B" }] },
    ]);
    expect(sent).toEqual(["text: One.", "text: Two.", "buttons: Pick one? [A | B]"]);
  });

  it("splits a long reply into separate messages at its paragraphs, like Marlo", async () => {
    await send("447000000001", [{ text: "First paragraph.\n\nSecond paragraph." }]);
    expect(sent).toEqual(["text: First paragraph.", "text: Second paragraph."]);
  });

  it("sends nothing for an empty reply", async () => {
    await send("447000000001", []);
    expect(sent).toEqual([]);
  });
});
