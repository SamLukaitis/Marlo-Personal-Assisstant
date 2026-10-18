import { beforeEach, describe, expect, it, vi } from "vitest";

// Records sends instead of calling the Graph API. `failFor` makes every send to a number throw;
// `windowClosedFor` makes only ordinary messages to it fail, the way Meta refuses them outside
// the 24-hour window.
const sent: string[] = [];
const failFor = new Set<string>();
const windowClosedFor = new Set<string>();
vi.mock("./whatsapp.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./whatsapp.js")>();
  return {
    ...actual,
    sendJoyceMessage: vi.fn(async (to: string, text: string) => {
      if (failFor.has(to)) throw new Error("send failed");
      if (windowClosedFor.has(to)) throw new actual.JoyceSendError("outside window", actual.JOYCE_WINDOW_CLOSED_ERROR);
      sent.push(`text ${to}: ${text}`);
    }),
    sendJoyceRelayTemplate: vi.fn(
      async (to: string, r: { recipientName: string | null; senderName: string | null; message: string }) => {
        if (failFor.has(to)) throw new Error("template not approved");
        sent.push(`template ${to}: ${r.recipientName} / ${r.senderName} / ${r.message}`);
      }
    ),
  };
});

const { sendRelayNow } = await import("./relayDelivery.js");
const { handleOnboarding } = await import("./onboarding.js");
const { openFamilySessionForPhone } = await import("./familyDb.js");
const { claimRelaysFor, findMemberByName, getFamilyJoinCode, queueRelay, recentHistory, setMemberName } =
  await import("./store.js");

let n = 0;
function phone(): string {
  n += 1;
  return `4477005${String(n).padStart(5, "0")}`;
}

/** Jake and Ella in one family. Returns their phones. */
function jakeAndElla(): { jake: string; ella: string } {
  const jake = phone();
  const ella = phone();
  handleOnboarding(jake, "hi");
  const created = handleOnboarding(jake, "new");
  if (!created.done) throw new Error("no family");
  handleOnboarding(ella, "hi");
  handleOnboarding(ella, getFamilyJoinCode(created.session)!);
  setMemberName(openFamilySessionForPhone(jake)!, "Jake");
  setMemberName(openFamilySessionForPhone(ella)!, "Ella");
  return { jake, ella };
}

const HOUR = 60 * 60 * 1000;

function lastSeenHoursAgo(p: string, hours: number) {
  const s = openFamilySessionForPhone(p)!;
  s.db.prepare(`UPDATE members SET last_seen_at = ? WHERE id = ?`).run(Date.now() - hours * HOUR, s.actor.id);
}

/** Jake leaves Ella a message and Joyce tries to send it now. */
async function tellElla(jake: string, body: string) {
  const s = openFamilySessionForPhone(jake)!;
  const ella = findMemberByName(s, "Ella");
  if (!ella.found) throw new Error("no Ella");
  const relayId = queueRelay(s, ella.id, body);
  return sendRelayNow(s, relayId, ella.id, body);
}

beforeEach(() => {
  sent.length = 0;
  failFor.clear();
  windowClosedFor.clear();
});

describe("passing a message on", () => {
  it("goes straight to someone who messaged Joyce in the last 24 hours, once", async () => {
    const { jake, ella } = jakeAndElla();
    lastSeenHoursAgo(ella, 2);
    expect(await tellElla(jake, "I'll be late tonight")).toBe(true);
    expect(sent).toEqual([`text ${ella}: Jake asked me to pass this on: I'll be late tonight`]);

    // Not handed over a second time when she next messages.
    const ellaSession = openFamilySessionForPhone(ella)!;
    expect(claimRelaysFor(ellaSession)).toEqual([]);
    // And it's in her conversation, so Joyce knows what she means if she replies to it.
    expect(recentHistory(ellaSession).map((h) => h.body)).toContain("Jake asked me to pass this on: I'll be late tonight");
  });

  it("goes as the family-message template when they haven't messaged in the last 24 hours", async () => {
    const { jake, ella } = jakeAndElla();
    lastSeenHoursAgo(ella, 30);
    expect(await tellElla(jake, "call Gran")).toBe(true);
    expect(sent).toEqual([`template ${ella}: Ella / Jake / call Gran`]);
    const ellaSession = openFamilySessionForPhone(ella)!;
    expect(claimRelaysFor(ellaSession)).toEqual([]);
    expect(recentHistory(ellaSession).map((h) => h.body)).toContain(
      'Hi Ella, you have a new message from Jake in your family group:\n\n"call Gran"\n\nReply here if you\'d like me to pass anything back.'
    );
  });

  it("falls back to the template when Meta says the window has closed after all", async () => {
    const { jake, ella } = jakeAndElla();
    lastSeenHoursAgo(ella, 23);
    windowClosedFor.add(ella);
    expect(await tellElla(jake, "bring the charger")).toBe(true);
    expect(sent).toEqual([`template ${ella}: Ella / Jake / bring the charger`]);
  });

  it("waits for their next message when the template can't be sent (e.g. not approved yet)", async () => {
    const { jake, ella } = jakeAndElla();
    lastSeenHoursAgo(ella, 30);
    failFor.add(ella);
    expect(await tellElla(jake, "call Gran")).toBe(false);
    expect(claimRelaysFor(openFamilySessionForPhone(ella)!).map((r) => r.body)).toEqual(["call Gran"]);
  });

  it("waits for their next message if the send fails, rather than being lost", async () => {
    const { jake, ella } = jakeAndElla();
    lastSeenHoursAgo(ella, 1);
    failFor.add(ella);
    expect(await tellElla(jake, "milk please")).toBe(false);
    expect(claimRelaysFor(openFamilySessionForPhone(ella)!).map((r) => r.body)).toEqual(["milk please"]);
  });

  it("waits when Joyce doesn't have their number yet", async () => {
    const { jake, ella } = jakeAndElla();
    const s = openFamilySessionForPhone(ella)!;
    s.db.prepare(`UPDATE members SET phone_enc = NULL WHERE id = ?`).run(s.actor.id);
    expect(await tellElla(jake, "see you at 6")).toBe(false);
    expect(sent).toEqual([]);
  });
});
