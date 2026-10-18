import { beforeEach, describe, expect, it, vi } from "vitest";

// Records sends instead of calling the Graph API. `failFor` makes sends to a number throw.
const sent: string[] = [];
const failFor = new Set<string>();
vi.mock("./whatsapp.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./whatsapp.js")>();
  return {
    ...actual,
    sendJoyceMessage: vi.fn(async (to: string, text: string) => {
      if (failFor.has(to)) throw new Error("send failed");
      sent.push(`text ${to}: ${text}`);
    }),
    sendJoyceReminderTemplate: vi.fn(async (to: string, text: string) => {
      if (failFor.has(to)) throw new Error("send failed");
      sent.push(`template ${to}: ${text}`);
    }),
  };
});

const { deliverDueReminders } = await import("./reminderDelivery.js");
const { handleOnboarding } = await import("./onboarding.js");
const { openFamilySessionForPhone } = await import("./familyDb.js");
const { claimDueReminders, createReminder, getFamilyJoinCode, recentHistory, setMemberName } = await import(
  "./store.js"
);
const { familiesWithRemindersDue } = await import("./registry.js");

let n = 0;
function phone(): string {
  n += 1;
  return `4477007${String(n).padStart(5, "0")}`;
}

/** A family of the given names; the first created it. Returns each member's phone. */
function familyOf(...names: string[]): string[] {
  const phones = names.map(() => phone());
  handleOnboarding(phones[0], "hi");
  const created = handleOnboarding(phones[0], "new");
  if (!created.done) throw new Error("no family");
  const code = getFamilyJoinCode(created.session)!;
  for (const p of phones.slice(1)) {
    handleOnboarding(p, "hi");
    handleOnboarding(p, code);
  }
  phones.forEach((p, i) => setMemberName(openFamilySessionForPhone(p)!, names[i]));
  return phones;
}

const session = (p: string) => openFamilySessionForPhone(p)!;
const HOUR = 60 * 60 * 1000;

function lastSeenHoursAgo(p: string, hours: number) {
  const s = session(p);
  s.db.prepare(`UPDATE members SET last_seen_at = ? WHERE id = ?`).run(Date.now() - hours * HOUR, s.actor.id);
}

beforeEach(() => {
  sent.length = 0;
  failFor.clear();
});

describe("sending reminders when they come due", () => {
  it("messages the person directly when they've been in touch in the last 24 hours", async () => {
    const [ana] = familyOf("Ana");
    const s = session(ana);
    createReminder(s, "Call the vet", Date.now() - 1000, s.actor.id);
    await deliverDueReminders();
    expect(sent).toEqual([`text ${ana}: Reminder: Call the vet`]);
  });

  it("uses the template for someone who hasn't messaged in over 24 hours", async () => {
    const [bo] = familyOf("Bo");
    const s = session(bo);
    createReminder(s, "Bins out", Date.now() - 1000, s.actor.id);
    lastSeenHoursAgo(bo, 30);
    await deliverDueReminders();
    expect(sent).toEqual([`template ${bo}: Bins out`]);
  });

  it("sends a whole-family reminder to everyone, saying who set it", async () => {
    const [priya, sam] = familyOf("Priya", "Sam");
    createReminder(session(priya), "School trip money", Date.now() - 1000, null);
    await deliverDueReminders();
    expect(sent.sort()).toEqual(
      [`text ${priya}: Reminder: School trip money`, `text ${sam}: Reminder: School trip money (from Priya)`].sort()
    );
    // Done for everyone: nothing left to hand over when they next message.
    expect(claimDueReminders(session(sam))).toEqual([]);
    // And each of them has it in their own conversation, so Joyce knows what a reply refers to.
    expect(recentHistory(session(priya)).at(-1)?.body).toBe("Reminder: School trip money");
    expect(recentHistory(session(sam)).at(-1)?.body).toBe("Reminder: School trip money (from Priya)");
  });

  it("doesn't send anything before it's due", async () => {
    const [cy] = familyOf("Cy");
    createReminder(session(cy), "Later", Date.now() + HOUR, null);
    await deliverDueReminders();
    expect(sent).toEqual([]);
  });

  it("tries once; anyone it couldn't reach gets it when they next message, and only then", async () => {
    const [dee, eli] = familyOf("Dee", "Eli");
    createReminder(session(dee), "Dentist at 4", Date.now() - 1000, null);
    failFor.add(eli);
    await deliverDueReminders();
    expect(sent).toEqual([`text ${dee}: Reminder: Dentist at 4`]);

    // A second pass doesn't retry Eli.
    sent.length = 0;
    failFor.clear();
    await deliverDueReminders();
    expect(sent).toEqual([]);

    // Eli gets it on his next message; Dee doesn't get it twice.
    expect(claimDueReminders(session(eli)).map((r) => r.body)).toEqual(["Dentist at 4"]);
    expect(claimDueReminders(session(dee))).toEqual([]);
    expect(claimDueReminders(session(eli))).toEqual([]);
  });

  it("clears the family from the schedule once nothing is left to send", async () => {
    const [fay] = familyOf("Fay");
    const s = session(fay);
    createReminder(s, "Pay the window cleaner", Date.now() - 1000, null);
    expect(familiesWithRemindersDue(Date.now()).map((f) => f.familyId)).toContain(s.familyId);
    await deliverDueReminders();
    expect(familiesWithRemindersDue(Date.now()).map((f) => f.familyId)).not.toContain(s.familyId);
  });
});
