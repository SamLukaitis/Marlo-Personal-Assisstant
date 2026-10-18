import { describe, expect, it } from "vitest";
import { composeReply as composeReplyMessages } from "./routes.js";
import { asText } from "./messages.js";
import { openFamilySessionForPhone } from "./familyDb.js";
import { listNotes, saveNote } from "./store.js";
import { createFamily, findFamilyForPhone, joinFamilyByCode, requestLeave } from "./registry.js";
import { openFamilySessionForNewMember } from "./familyDb.js";
import {
  LEFT_MESSAGE,
  NOT_CONFIRMED_MESSAGE,
  handlePendingLeave,
  isLeaveConfirmation,
} from "./leaving.js";
import { setMemberName } from "./store.js";

// These tests check wording; joining the messages back into text keeps them about that.
const composeReply = async (...args: Parameters<typeof composeReplyMessages>) =>
  asText(await composeReplyMessages(...args));

// The confirmation half of leaving runs entirely without the model, which is the security
// property worth testing: it can be exercised, and must behave, with no API key present.

function familyOf(phone: string, name: string) {
  const { family, joinCode } = createFamily(phone);
  const s = openFamilySessionForNewMember(family, phone);
  setMemberName(s, name);
  return { session: openFamilySessionForPhone(phone)!, joinCode };
}

describe("the confirmation phrase", () => {
  it("accepts the exact phrase, forgiving case and surrounding space", () => {
    expect(isLeaveConfirmation("confirm cancel")).toBe(true);
    expect(isLeaveConfirmation("Confirm cancel")).toBe(true);
    expect(isLeaveConfirmation("  CONFIRM CANCEL  ")).toBe(true);
  });

  it("rejects anything that isn't just those two words", () => {
    for (const near of [
      "yes confirm cancel",
      "confirm cancel!",
      "confirm",
      "cancel",
      "confirm-cancel",
      "confirmcancel",
      "yes",
      "I confirm I want to cancel",
    ]) {
      expect(isLeaveConfirmation(near), near).toBe(false);
    }
  });
});

describe("leaving a family", () => {
  it("removes them on the exact phrase and says so", async () => {
    const a = familyOf("15552220001", "Ana");
    saveNote(a.session, "Bin day", "Tuesdays");

    requestLeave("15552220001");
    expect(await composeReply("15552220001", "confirm cancel")).toBe(LEFT_MESSAGE);
    expect(findFamilyForPhone("15552220001")).toBeNull();
    expect(openFamilySessionForPhone("15552220001")).toBeNull();
  });

  it("cancels the request on anything else, leaving them where they were", async () => {
    const a = familyOf("15552220002", "Ben");
    requestLeave("15552220002");

    expect(await composeReply("15552220002", "yes")).toBe(NOT_CONFIRMED_MESSAGE);
    expect(findFamilyForPhone("15552220002")!.familyId).toBe(a.session.familyId);
  });

  it("spends the request on the very next message, whatever it says", async () => {
    familyOf("15552220003", "Cara");
    requestLeave("15552220003");

    expect(await composeReply("15552220003", "actually never mind")).toBe(NOT_CONFIRMED_MESSAGE);
    // The phrase arriving later is now just an ordinary message, not a confirmation.
    expect(handlePendingLeave("15552220003", "confirm cancel")).toBeNull();
    expect(findFamilyForPhone("15552220003")).not.toBeNull();
  });

  it("does nothing at all without a pending request", () => {
    familyOf("15552220004", "Dev");
    expect(handlePendingLeave("15552220004", "confirm cancel")).toBeNull();
    expect(findFamilyForPhone("15552220004")).not.toBeNull();
  });

  it("leaves the family's data with the family, and keeps the leaver's attributions", async () => {
    const a = familyOf("15552220010", "Eve");
    expect(joinFamilyByCode("15552220011", a.joinCode).ok).toBe(true);
    const finn = openFamilySessionForPhone("15552220011")!;
    setMemberName(finn, "Finn");

    saveNote(a.session, "Vet", "Mill Road");
    requestLeave("15552220010");
    expect(await composeReply("15552220010", "confirm cancel")).toBe(LEFT_MESSAGE);

    // Finn still has the note, still correctly attributed to Eve.
    const remaining = listNotes(openFamilySessionForPhone("15552220011")!);
    expect(remaining.map((n) => n.body)).toEqual(["Mill Road"]);
    expect(remaining[0].savedByName).toBe("Eve");
  });

  it("puts the leaver straight back at the new-or-join question", async () => {
    const other = familyOf("15552220020", "Gita");
    familyOf("15552220021", "Hal");

    requestLeave("15552220021");
    expect(await composeReply("15552220021", "confirm cancel")).toBe(LEFT_MESSAGE);

    // No second introduction: the leave message already asked, so "join" is read as the answer.
    const asked = await composeReply("15552220021", "join");
    expect(asked).toContain("family ID");
    await composeReply("15552220021", other.joinCode);
    expect(findFamilyForPhone("15552220021")!.familyId).toBe(other.session.familyId);
  });

  it("lets the last member leave, and someone with the code rejoin afterwards", async () => {
    const a = familyOf("15552220030", "Ivy");
    saveNote(a.session, "Wifi", "orange-lamp-4");

    requestLeave("15552220030");
    await composeReply("15552220030", "confirm cancel");
    expect(findFamilyForPhone("15552220030")).toBeNull();

    // The family and its code outlive its last member, so the data isn't stranded.
    expect(joinFamilyByCode("15552220031", a.joinCode).ok).toBe(true);
    expect(listNotes(openFamilySessionForPhone("15552220031")!)[0].body).toBe("orange-lamp-4");
  });
});

describe("leaving cannot be done by the assistant", () => {
  it("exposes no tool that removes anyone from a family", async () => {
    const assistant = await import("./assistant.js");
    // The tool list is module-private, so assert on the source: the only leave-related tool must
    // be the one that *requests* confirmation. A future tool that actually removes someone would
    // bypass the typed confirmation in leaving.ts entirely.
    const fs = await import("node:fs");
    const url = await import("node:url");
    const source = fs.readFileSync(
      url.fileURLToPath(new URL("./assistant.ts", import.meta.url)),
      "utf8"
    );
    expect(source).toContain("request_leave_family");
    expect(source).not.toContain("leaveFamily");
    expect(assistant.runJoyceTurn).toBeTypeOf("function");
  });
});
