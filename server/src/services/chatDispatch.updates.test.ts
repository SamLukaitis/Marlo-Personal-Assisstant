import { describe, it, expect, vi } from "vitest";

vi.mock("./messageBatching.js", () => ({
  queueForAssistant: vi.fn(),
  looksComplete: vi.fn(),
}));
const sendTextAndRecord = vi.fn(async () => {});
vi.mock("./whatsappReply.js", () => ({ sendTextAndRecord }));

const { findOrCreateUserByPhone } = await import("../db/store.js");
const { handleText } = await import("./chatDispatch.js");
const { queueForAssistant } = await import("./messageBatching.js");
const { wantsProductUpdates } = await import("./announcements.js");

let counter = 0;
function freshPhone(): string {
  counter += 1;
  return `44793310${String(counter).padStart(4, "0")}`;
}

describe("handleText: stop updates / start updates", () => {
  it("turns announcements off and back on without asking the model", async () => {
    const phone = freshPhone();
    const user = findOrCreateUserByPhone(phone);

    await handleText(user.id, phone, "Stop updates", "wamid.stop");
    expect(wantsProductUpdates(user.id)).toBe(false);
    expect(sendTextAndRecord).toHaveBeenLastCalledWith(user.id, phone, expect.stringContaining("won't get"));

    await handleText(user.id, phone, "start updates", "wamid.start");
    expect(wantsProductUpdates(user.id)).toBe(true);
    expect(queueForAssistant).not.toHaveBeenCalled();
  });
});
