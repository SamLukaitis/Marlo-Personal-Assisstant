import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { handleOnboarding } from "./onboarding.js";
import { openFamilySessionForPhone, type FamilySession } from "./familyDb.js";
import {
  addEvent,
  appendMessage,
  createReminder,
  getFamilyJoinCode,
  getMessageByWamid,
  getMessage,
  listNotes,
  listUpcomingReminders,
  listEventsBetween,
  recentHistory,
  saveNote,
  setMemberName,
} from "./store.js";
import { recordDerivation } from "./provenance.js";
import { DELETE_WINDOW_MS, handlePendingDelete, requestDelete } from "./deleting.js";
import { saveFamilyFile } from "./files.js";
import { FAMILY_FILES_DIR } from "./registry.js";
import { composeReply } from "./routes.js";

let n = 0;
/** A family: the first name creates it (and is admin), the rest join. Returns phones. */
function familyOf(...names: string[]): string[] {
  const phones = names.map(() => {
    n += 1;
    return `4477006${String(n).padStart(5, "0")}`;
  });
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
const session = (p: string): FamilySession => openFamilySessionForPhone(p)!;
const DAY = 24 * 60 * 60 * 1000;

/**
 * What a turn records (see runJoyceTurn): a document sent in a message, an event and a reminder
 * made from it, and Joyce's reply. Returns the ids.
 */
async function letterAboutATrip(phone: string) {
  const s = session(phone);
  const doc = await saveFamilyFile(s, {
    buffer: Buffer.from("School trip to Paris, 3-7 November. Pay £120 by Friday."),
    mimeType: "text/plain",
    filename: "trip-letter.txt",
  });
  const msg = appendMessage(s, "user", "[Sent a file \"trip-letter.txt\"]", `wamid.letter.${phone}`);
  const turn = [{ type: "message" as const, id: msg }];
  recordDerivation(s, { type: "document", id: doc.documentId }, turn);
  const sources = [...turn, { type: "document" as const, id: doc.documentId }];
  const event = addEvent(s, {
    title: "Paris trip",
    allDay: true,
    startDate: "2026-11-03",
    endDate: "2026-11-07",
    startsAt: Date.UTC(2026, 10, 3),
    endsAt: Date.UTC(2026, 10, 8),
    aboutMemberId: null,
  });
  recordDerivation(s, { type: "event", id: event }, sources);
  const reminder = createReminder(s, "Pay £120 for the Paris trip", Date.now() + DAY, null);
  recordDerivation(s, { type: "reminder", id: reminder }, sources);
  const reply = appendMessage(s, "assistant", "Saved the trip letter and put Paris on the calendar.");
  recordDerivation(s, { type: "message", id: reply }, sources);
  return { msg, doc: doc.documentId, event, reminder, reply };
}

describe("deleting a message and everything made from it", () => {
  it("also removes the request to delete it, which often names what was deleted", async () => {
    const [gus] = familyOf("Gus");
    const s = session(gus);
    const secret = appendMessage(s, "user", "my PIN is 4821");
    const request = appendMessage(s, "user", "delete this, it had my PIN in it");
    const asked = appendMessage(s, "assistant", "(Asked them to confirm deleting a message.)");
    recordDerivation(s, { type: "message", id: asked }, [{ type: "message", id: request }]);
    requestDelete(s, getMessage(s, secret), Date.now(), request);
    handlePendingDelete(session(gus), "Delete");
    expect([secret, request, asked].map((id) => getMessage(session(gus), id))).toEqual([null, null, null]);
  });

  it("removes the message, its file, and the event, reminder and reply made from it", async () => {
    const [priya] = familyOf("Priya");
    const ids = await letterAboutATrip(priya);
    // Something unrelated, which must survive.
    saveNote(session(priya), "Wifi", "mango-tree-88");

    const target = getMessageByWamid(session(priya), `wamid.letter.${priya}`);
    const asked = requestDelete(session(priya), target);
    expect(asked.ok).toBe(true);
    if (!asked.ok) return;
    expect(asked.confirmation.text).toContain('The file "trip-letter.txt"');
    expect(asked.confirmation.text).toContain('The calendar event "Paris trip"');
    expect(asked.confirmation.text).toContain('The reminder "Pay £120 for the Paris trip"');
    expect(asked.confirmation.text).toContain("My reply to it");
    expect(asked.confirmation.buttons?.map((b) => b.title)).toEqual(["Delete", "Keep"]);

    const folder = path.join(FAMILY_FILES_DIR, session(priya).familyId);
    expect(fs.readdirSync(folder)).toHaveLength(1);

    expect(handlePendingDelete(session(priya), "Delete")).toBe("Deleted. I've removed it and 4 things I'd made from it.");
    const s = session(priya);
    expect(getMessage(s, ids.msg)).toBeNull();
    expect(getMessage(s, ids.reply)).toBeNull();
    expect(listEventsBetween(s, 0, Date.UTC(2030, 0, 1))).toEqual([]);
    expect(listUpcomingReminders(s)).toEqual([]);
    expect(fs.readdirSync(folder)).toHaveLength(0);
    expect(listNotes(s).map((note) => note.title)).toEqual(["Wifi"]);
  });

  it("doesn't reach things made in a later turn — only what came directly from the message", async () => {
    const [ana] = familyOf("Ana");
    const ids = await letterAboutATrip(ana);
    const s = session(ana);
    // A later turn, which looked at the trip event, saved a packing note. As runJoyceTurn
    // records it: linked to that turn's own message only.
    const later = appendMessage(s, "user", "make a packing list for the trip");
    const note = saveNote(s, "Packing for Paris", "passport, adaptor");
    recordDerivation(s, { type: "note", id: note }, [{ type: "message", id: later }]);

    requestDelete(s, getMessage(s, ids.msg));
    handlePendingDelete(session(ana), "delete");
    expect(listNotes(session(ana)).map((n) => n.title)).toEqual(["Packing for Paris"]);
    expect(listEventsBetween(session(ana), 0, Date.UTC(2030, 0, 1))).toEqual([]);
  });

  it("keeps everything on anything other than Delete", async () => {
    const [bo] = familyOf("Bo");
    const ids = await letterAboutATrip(bo);
    requestDelete(session(bo), getMessage(session(bo), ids.msg));
    expect(handlePendingDelete(session(bo), "actually no")).toBe("Okay, I've kept it.");
    expect(getMessage(session(bo), ids.msg)).not.toBeNull();
    // The request is spent: a later "Delete" does nothing.
    expect(handlePendingDelete(session(bo), "Delete")).toBeNull();
  });

  it("lets the family admin delete another member's message, but not other members", async () => {
    const [admin, sam, leo] = familyOf("Priya", "Sam", "Leo");
    const samMsg = appendMessage(session(sam), "user", "our bank PIN is 4821");
    expect(requestDelete(session(leo), getMessage(session(leo), samMsg))).toEqual({
      ok: false,
      reason: "Only the person who sent that, or whoever started the family group, can delete it.",
    });
    expect(requestDelete(session(admin), getMessage(session(admin), samMsg)).ok).toBe(true);
    handlePendingDelete(session(admin), "Delete");
    expect(getMessage(session(sam), samMsg)).toBeNull();
  });

  it("refuses anything older than 24 hours, for the admin too", async () => {
    const [admin] = familyOf("Dee");
    const old = appendMessage(session(admin), "user", "an old message");
    const later = Date.now() + DELETE_WINDOW_MS + 60_000;
    const outcome = requestDelete(session(admin), getMessage(session(admin), old), later);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("more than 24 hours ago");
  });

  it("refuses to delete one of Joyce's own messages", async () => {
    const [eli] = familyOf("Eli");
    const mine = appendMessage(session(eli), "assistant", "Saved.");
    const outcome = requestDelete(session(eli), getMessage(session(eli), mine));
    expect(outcome.ok).toBe(false);
  });

  it("handles the Delete tap before Joyce's model ever sees it", async () => {
    const [fay] = familyOf("Fay");
    const msg = appendMessage(session(fay), "user", "my passport number is 123456789");
    requestDelete(session(fay), getMessage(session(fay), msg));
    // composeReply would call the model for anything else; this resolves without an API key.
    const reply = await composeReply(fay, "Delete");
    expect(reply.map((m) => m.text)).toEqual(["Deleted."]);
    expect(recentHistory(session(fay)).map((h) => h.body).join(" ")).not.toContain("123456789");
  });
});
