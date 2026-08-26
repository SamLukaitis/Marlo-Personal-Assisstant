import { describe, it, expect } from "vitest";
import {
  findOrCreateUserByEmail,
  saveDocument,
  findDocumentByEmailAttachment,
} from "./store.js";

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

describe("saveDocument source/email fields", () => {
  it("defaults source to 'whatsapp' and the email fields to null when omitted", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("doc-source-default"));
    const doc = saveDocument(user.id, {
      phone: "447900000099",
      filename: null,
      mimeType: "image/jpeg",
      storedPath: "/tmp/fake",
      caption: null,
      title: "Test",
      extractedText: "text",
      category: null,
    });
    expect(doc.source).toBe("whatsapp");
    expect(doc.emailAccountId).toBeNull();
    expect(doc.emailMessageId).toBeNull();
    expect(doc.emailAttachmentId).toBeNull();
  });

  it("stores email provenance when given", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("doc-source-email"));
    const doc = saveDocument(user.id, {
      phone: "email:7",
      filename: "boarding-pass.pdf",
      mimeType: "application/pdf",
      storedPath: "/tmp/fake2",
      caption: null,
      title: "Test",
      extractedText: "text",
      category: "travel",
      source: "email",
      emailAccountId: 7,
      emailMessageId: "msg-123",
      emailAttachmentId: "att-456",
    });
    expect(doc.source).toBe("email");
    expect(doc.emailAccountId).toBe(7);
    expect(doc.emailMessageId).toBe("msg-123");
    expect(doc.emailAttachmentId).toBe("att-456");
  });
});

describe("findDocumentByEmailAttachment", () => {
  it("finds a previously-saved document by its email provenance", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("doc-find-by-email"));
    const saved = saveDocument(user.id, {
      phone: "email:9",
      filename: "receipt.pdf",
      mimeType: "application/pdf",
      storedPath: "/tmp/fake3",
      caption: null,
      title: "Test",
      extractedText: "text",
      category: "receipts",
      source: "email",
      emailAccountId: 9,
      emailMessageId: "msg-789",
      emailAttachmentId: "att-999",
    });

    const found = findDocumentByEmailAttachment(user.id, 9, "msg-789", "att-999");
    expect(found?.id).toBe(saved.id);
  });

  it("returns undefined when nothing matches", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("doc-find-by-email-miss"));
    expect(findDocumentByEmailAttachment(user.id, 1, "nope", "nope")).toBeUndefined();
  });
});
