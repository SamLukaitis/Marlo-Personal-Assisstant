import { describe, it, expect } from "vitest";
import { findOrCreateUserByEmail, saveDocument, listDocuments } from "./store.js";

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

function saveTestDoc(ownerId: number, category: "travel" | "id_legal" | "receipts" | "other" | null) {
  return saveDocument(ownerId, {
    phone: "447000000001",
    filename: null,
    mimeType: "image/jpeg",
    storedPath: "/tmp/fake",
    caption: null,
    title: "Test doc",
    extractedText: "some text",
    category,
  });
}

describe("documents category", () => {
  it("round-trips the category through saveDocument and listDocuments", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("cat-roundtrip"));
    const saved = saveTestDoc(user.id, "travel");
    expect(saved.category).toBe("travel");

    const [listed] = listDocuments(user.id, 10);
    expect(listed.category).toBe("travel");
  });

  it("stores null category for documents that weren't categorized", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("cat-null"));
    const saved = saveTestDoc(user.id, null);
    expect(saved.category).toBeNull();
  });

  it("filters listDocuments by category when given", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("cat-filter"));
    saveTestDoc(user.id, "travel");
    saveTestDoc(user.id, "receipts");
    saveTestDoc(user.id, "travel");

    const travelOnly = listDocuments(user.id, 10, "travel");
    expect(travelOnly).toHaveLength(2);
    expect(travelOnly.every((d) => d.category === "travel")).toBe(true);
  });

  it("returns every category when no category filter is given", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("cat-nofilter"));
    saveTestDoc(user.id, "travel");
    saveTestDoc(user.id, "other");

    const all = listDocuments(user.id, 10);
    expect(all).toHaveLength(2);
  });
});
