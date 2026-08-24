import { describe, it, expect } from "vitest";
import { findOrCreateUserByEmail, saveDocument, saveMatchKeys, listRecentMatchKeys } from "./store.js";

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

function saveTestDoc(ownerId: number, title: string) {
  return saveDocument(ownerId, {
    phone: "447000000001",
    filename: null,
    mimeType: "image/jpeg",
    storedPath: "/tmp/fake",
    caption: null,
    title,
    extractedText: "some text",
    category: "travel",
  });
}

describe("document_match_keys", () => {
  it("round-trips saved keys through listRecentMatchKeys, joined with the document title", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("keys-roundtrip"));
    const doc = saveTestDoc(user.id, "Delta Boarding Pass");

    saveMatchKeys(user.id, doc.id, {
      referenceCode: "K4X9QP",
      flightNumber: "DL1234",
      vendor: "Delta",
      eventDate: "2026-09-12",
    });

    const rows = listRecentMatchKeys(user.id, Date.now() - 1000);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      documentId: doc.id,
      referenceCode: "K4X9QP",
      flightNumber: "DL1234",
      vendor: "Delta",
      eventDate: "2026-09-12",
      docTitle: "Delta Boarding Pass",
    });
  });

  it("does not write a row when every field is absent", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("keys-empty"));
    const doc = saveTestDoc(user.id, "Empty Keys Doc");

    saveMatchKeys(user.id, doc.id, {});

    const rows = listRecentMatchKeys(user.id, Date.now() - 1000);
    expect(rows).toHaveLength(0);
  });

  it("excludes rows created before the sinceMs cutoff", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("keys-window"));
    const doc = saveTestDoc(user.id, "Old Doc");
    saveMatchKeys(user.id, doc.id, { referenceCode: "OLD123" });

    // A cutoff in the future excludes everything that already exists.
    const rows = listRecentMatchKeys(user.id, Date.now() + 60_000);
    expect(rows).toHaveLength(0);
  });

  it("scopes results by owner", () => {
    const userA = findOrCreateUserByEmail(uniqueEmail("keys-owner-a"));
    const userB = findOrCreateUserByEmail(uniqueEmail("keys-owner-b"));
    const docA = saveTestDoc(userA.id, "A's Doc");
    saveMatchKeys(userA.id, docA.id, { referenceCode: "AAAA11" });

    const rowsForB = listRecentMatchKeys(userB.id, Date.now() - 1000);
    expect(rowsForB).toHaveLength(0);
  });
});
