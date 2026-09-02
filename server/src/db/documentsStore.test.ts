import { describe, it, expect } from "vitest";
import { findOrCreateUserByEmail, saveDocument, listDocuments, upsertAccount } from "./store.js";

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

// Requirement: documents/entities derived from an email carry which inbox they came from — see
// feature-to-do plan "Multi-inbox Gmail: permissions, attribution, and inbox tagging".
describe("documents emailAccountEmail", () => {
  it("snapshots the connected account's email address when emailAccountId is given", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("email-tag-set"));
    const account = upsertAccount(user.id, {
      provider: "google",
      email: uniqueEmail("inbox"),
      accessToken: "t",
      refreshToken: "r",
      expiryDate: null,
    });

    const doc = saveDocument(user.id, {
      phone: `email:${account.id}`,
      filename: null,
      mimeType: "text/plain",
      storedPath: "/tmp/fake",
      caption: null,
      title: "Receipt",
      extractedText: "text",
      category: "receipts",
      source: "email",
      emailAccountId: account.id,
      emailMessageId: "msg-1",
      emailAttachmentId: null,
    });

    expect(doc.emailAccountEmail).toBe(account.email);
  });

  it("leaves emailAccountEmail null for a WhatsApp-sourced document", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("email-tag-null"));
    const doc = saveTestDoc(user.id, "travel");
    expect(doc.emailAccountEmail).toBeNull();
  });
});
