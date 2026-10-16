import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  createFamily,
  findFamilyForPhone,
  joinFamilyByCode,
  normalizeJoinCode,
  rotateJoinCode,
  FAMILY_DB_DIR,
} from "./registry.js";
import { openFamilySessionForPhone, openFamilySessionForNewMember } from "./familyDb.js";
import { decryptFor, deriveFamilyKey, encryptFor, newFamilySalt } from "./familyKey.js";
import {
  claimRelaysFor,
  findMemberByName,
  listMembers,
  listNotes,
  queueRelay,
  saveNote,
  searchNotes,
  setMemberName,
} from "./store.js";
import { extractIncomingMessages } from "../providers/whatsapp.js";

// These tests are the evidence for the claim the whole design rests on: one family cannot reach
// another's data, and the failure mode if anything is wired up wrong is a crash rather than a
// leak. Each barrier is tested on its own, so a regression names which one broke.

function newFamilyWith(phone: string, name: string) {
  const { family, joinCode } = createFamily(phone);
  const session = openFamilySessionForNewMember(family, phone);
  setMemberName(session, name);
  // Reopen so `actor.displayName` reflects the name just set.
  return { session: openFamilySessionForPhone(phone)!, joinCode };
}

describe("barrier 1: separate database file per family", () => {
  it("keeps one family's notes entirely out of another's", () => {
    const a = newFamilyWith("15550000001", "Ana");
    const b = newFamilyWith("15550000002", "Ben");

    saveNote(a.session, "Wifi password", "hunter2");
    saveNote(b.session, "Wifi password", "correcthorse");

    expect(listNotes(a.session).map((n) => n.body)).toEqual(["hunter2"]);
    expect(listNotes(b.session).map((n) => n.body)).toEqual(["correcthorse"]);

    // The searches most likely to leak — same query, same note title, different families.
    expect(searchNotes(a.session, "wifi").map((n) => n.body)).toEqual(["hunter2"]);
    expect(searchNotes(b.session, "hunter2")).toEqual([]);
  });

  it("writes each family to its own file on disk", () => {
    const a = newFamilyWith("15550000003", "Cara");
    const b = newFamilyWith("15550000004", "Dev");
    expect(a.session.familyId).not.toEqual(b.session.familyId);

    for (const id of [a.session.familyId, b.session.familyId]) {
      expect(fs.existsSync(path.join(FAMILY_DB_DIR, `${id}.db`))).toBe(true);
    }
  });

  it("does not let one family see another's members", () => {
    const a = newFamilyWith("15550000005", "Eve");
    const b = newFamilyWith("15550000006", "Finn");
    expect(listMembers(a.session).map((m) => m.displayName)).toEqual(["Eve"]);
    expect(findMemberByName(a.session, "Finn")).toEqual({ found: false, reason: "unknown" });
  });
});

describe("barrier 2: per-family encryption key", () => {
  it("derives a different key for every family", () => {
    const salt = newFamilySalt();
    // Same salt, different family id — the id is mixed into the derivation precisely so that a
    // reused salt still can't produce a shared key.
    expect(deriveFamilyKey("family-one", salt)).not.toEqual(deriveFamilyKey("family-two", salt));
  });

  it("throws rather than returning anything when the wrong family's key is used", () => {
    const keyA = deriveFamilyKey("family-a", newFamilySalt());
    const keyB = deriveFamilyKey("family-b", newFamilySalt());
    const ciphertext = encryptFor(keyA, "the vet is on Mill Road");

    expect(decryptFor(keyA, ciphertext)).toBe("the vet is on Mill Road");
    // AES-GCM authenticates before it decrypts, so this is a hard failure — never garbage, and
    // never another family's plaintext.
    expect(() => decryptFor(keyB, ciphertext)).toThrow();
  });

  it("stores note content as ciphertext, not plaintext, in the family file", () => {
    const a = newFamilyWith("15550000007", "Gita");
    saveNote(a.session, "Passport number", "X1234567");

    const raw = fs.readFileSync(path.join(FAMILY_DB_DIR, `${a.session.familyId}.db`));
    expect(raw.includes(Buffer.from("X1234567"))).toBe(false);
    expect(raw.includes(Buffer.from("Passport number"))).toBe(false);
    // Confirms the absence above is encryption, not a failed write.
    expect(listNotes(a.session)[0].body).toBe("X1234567");
  });
});

describe("barrier 3: no API takes a family identifier", () => {
  it("resolves a family only from a phone number, and returns null for an unknown one", () => {
    expect(openFamilySessionForPhone("15559999999")).toBeNull();
  });

  it("rotates only the caller's own family id", () => {
    const a = newFamilyWith("15550000008", "Hal");
    const b = newFamilyWith("15550000009", "Ivy");

    const rotated = rotateJoinCode("15550000008")!;
    expect(rotated).toMatch(/^JOY-[0-9A-Z]{4}-[0-9A-Z]{4}$/);

    // Ben's old code still works; Ana's doesn't. There is no argument by which Ana could have
    // rotated Ben's, which is the point being asserted.
    expect(joinFamilyByCode("15550000010", a.joinCode)).toEqual({
      ok: false,
      reason: "unknown_code",
    });
    expect(joinFamilyByCode("15550000011", b.joinCode).ok).toBe(true);
  });
});

describe("family membership", () => {
  it("puts a second phone into the same family via the join code, sharing everything", () => {
    const a = newFamilyWith("15550000020", "Jo");
    saveNote(a.session, "Vet", "Mill Road, 01223 555111");

    expect(joinFamilyByCode("15550000021", a.joinCode).ok).toBe(true);
    const joined = openFamilySessionForPhone("15550000021")!;

    expect(joined.familyId).toBe(a.session.familyId);
    // The whole product in one assertion: what one member saved, another can read.
    expect(searchNotes(joined, "vet")[0].body).toBe("Mill Road, 01223 555111");
    expect(searchNotes(joined, "vet")[0].savedByName).toBe("Jo");
  });

  it("refuses to put one phone in a second family", () => {
    const a = newFamilyWith("15550000030", "Kit");
    const b = newFamilyWith("15550000031", "Lee");

    expect(joinFamilyByCode("15550000030", b.joinCode)).toEqual({
      ok: false,
      reason: "already_in_a_family",
    });
    expect(() => createFamily("15550000030")).toThrow();
    // Still in the family they started with.
    expect(findFamilyForPhone("15550000030")!.familyId).toBe(a.session.familyId);
  });

  it("accepts a join code however it was typed, and rejects anything else", () => {
    expect(normalizeJoinCode("JOY-4K7M-2QX9")).toBe("4K7M2QX9");
    expect(normalizeJoinCode("joy 4k7m 2qx9")).toBe("4K7M2QX9");
    expect(normalizeJoinCode("4k7m2qx9")).toBe("4K7M2QX9");
    expect(normalizeJoinCode("nope")).toBeNull();
    expect(normalizeJoinCode("JOY-4K7M-2QX")).toBeNull();
  });
});

describe("passing messages between family members", () => {
  it("delivers a relay to the recipient and nobody else", () => {
    const a = newFamilyWith("15550000040", "Mo");
    expect(joinFamilyByCode("15550000041", a.joinCode).ok).toBe(true);
    const nina = openFamilySessionForPhone("15550000041")!;
    setMemberName(nina, "Nina");

    const target = findMemberByName(a.session, "Nina");
    expect(target.found).toBe(true);
    queueRelay(a.session, (target as { id: number }).id, "can you get milk");

    // The sender doesn't receive their own relay.
    expect(claimRelaysFor(a.session)).toEqual([]);

    const delivered = claimRelaysFor(openFamilySessionForPhone("15550000041")!);
    expect(delivered.map((r) => r.body)).toEqual(["can you get milk"]);
    expect(delivered[0].fromName).toBe("Mo");

    // Claimed once only, so it can't be delivered twice.
    expect(claimRelaysFor(openFamilySessionForPhone("15550000041")!)).toEqual([]);
  });
});

describe("Marlowe and Joyce webhook separation", () => {
  const payload = (phoneNumberId: string | undefined) => ({
    entry: [
      {
        changes: [
          {
            value: {
              ...(phoneNumberId ? { metadata: { phone_number_id: phoneNumberId } } : {}),
              messages: [{ from: "15550001234", id: "wamid.1", type: "text", text: { body: "hi" } }],
            },
          },
        ],
      },
    ],
  });

  it("drops a message addressed to the other number", () => {
    expect(extractIncomingMessages(payload("joyce-number"), "marlowe-number")).toEqual([]);
    expect(extractIncomingMessages(payload("marlowe-number"), "marlowe-number")).toHaveLength(1);
  });

  it("keeps a payload with no metadata, so existing traffic and fixtures still work", () => {
    expect(extractIncomingMessages(payload(undefined), "marlowe-number")).toHaveLength(1);
    expect(extractIncomingMessages(payload("joyce-number"))).toHaveLength(1);
  });
});
