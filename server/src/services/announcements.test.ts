import { describe, it, expect, vi, beforeEach } from "vitest";

const sent: { phone: string; text: string; kind: string; templateText?: string }[] = [];
const failFor = new Set<string>();
vi.mock("./outbound.js", () => ({
  sendProactiveMessage: vi.fn(async (phone: string, text: string, kind: string, _note?: string, templateText?: string) => {
    if (failFor.has(phone)) throw new Error("Meta said no");
    sent.push({ phone, text, kind, templateText });
  }),
}));

const {
  sendAnnouncement,
  sendTestAnnouncement,
  retryAnnouncement,
  listAnnouncementRecipients,
  setProductUpdates,
  updatesTrigger,
  MAX_ANNOUNCEMENT_CHARS,
} = await import("./announcements.js");
const { findOrCreateUserByPhone, getAnnouncement } = await import("../db/store.js");

let counter = 0;
function newPhone(): string {
  counter += 1;
  return `4479330${String(Date.now()).slice(-4)}${String(counter).padStart(2, "0")}`;
}

function newUser() {
  const phone = newPhone();
  return { ...findOrCreateUserByPhone(phone), phone };
}

beforeEach(() => {
  sent.length = 0;
  failFor.clear();
});

describe("updatesTrigger", () => {
  it("recognises stop and start on their own, not inside a sentence", () => {
    expect(updatesTrigger("Stop updates")).toBe("stop");
    expect(updatesTrigger("  stop updates. ")).toBe("stop");
    expect(updatesTrigger("start updates")).toBe("start");
    expect(updatesTrigger("stop updates about Railway crash emails")).toBeNull();
  });
});

describe("sendAnnouncement", () => {
  it("sends to every user who hasn't opted out, as a marketing announcement with the opt-out line", async () => {
    const admin = newUser();
    const keen = newUser();
    const optedOut = newUser();
    setProductUpdates(optedOut.id, false);

    const result = await sendAnnouncement(admin.id, "  Hotel search is live.  ");

    const phones = sent.map((s) => s.phone);
    expect(phones).toContain(keen.phone);
    expect(phones).not.toContain(optedOut.phone);
    const toKeen = sent.find((s) => s.phone === keen.phone)!;
    expect(toKeen.kind).toBe("announcement");
    expect(toKeen.text).toContain("What's new in Marlo");
    expect(toKeen.text).toContain("Hotel search is live.");
    expect(toKeen.text).toContain("stop updates");
    // The template has its own lead-in, so its variable doesn't repeat the heading.
    expect(toKeen.templateText).not.toContain("What's new");
    expect(toKeen.templateText).toContain("stop updates");
    expect(getAnnouncement(result.id)).toMatchObject({ text: "Hotel search is live.", sent: result.sent, failed: 0 });
  });

  it("retries only the numbers that failed", async () => {
    const admin = newUser();
    const flaky = newUser();
    failFor.add(flaky.phone);

    const first = await sendAnnouncement(admin.id, "Short links are here.");
    expect(first.failed).toBeGreaterThanOrEqual(1);
    const sentFirstTime = new Set(sent.map((s) => s.phone));

    sent.length = 0;
    failFor.clear();
    const retry = await retryAnnouncement(first.id);
    expect(retry.failed).toBe(0);
    expect(sent.map((s) => s.phone)).toEqual([flaky.phone]);
    expect(sentFirstTime.has(flaky.phone)).toBe(false);
  });

  it("rejects an empty or over-long update", async () => {
    const admin = newUser();
    await expect(sendAnnouncement(admin.id, "   ")).rejects.toThrow("Write the update first");
    await expect(sendAnnouncement(admin.id, "x".repeat(MAX_ANNOUNCEMENT_CHARS + 1))).rejects.toThrow("Keep it to");
    expect(sent).toHaveLength(0);
  });
});

describe("sendTestAnnouncement", () => {
  it("goes only to the admin's own number, even if they've opted out", async () => {
    const admin = newUser();
    setProductUpdates(admin.id, false);
    newUser();

    const result = await sendTestAnnouncement(admin.id, "Testing.");

    expect(result).toEqual({ sent: 1, failed: 0 });
    expect(sent.map((s) => s.phone)).toEqual([admin.phone]);
    expect(listAnnouncementRecipients().some((r) => r.ownerId === admin.id)).toBe(false);
  });
});
