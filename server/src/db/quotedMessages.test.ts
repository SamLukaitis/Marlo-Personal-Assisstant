import { describe, it, expect } from "vitest";
import {
  findOrCreateUserByEmail,
  appendWhatsAppMessage,
  getWhatsAppMessageByWamid,
  saveDocument,
  getDocumentByWamid,
  recordSentDocumentWamid,
  getSentDocumentByWamid,
  deleteDocument,
} from "./store.js";

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

describe("getWhatsAppMessageByWamid", () => {
  it("finds a message by a wamid recorded when it was appended", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("wamid-lookup"));
    const wamid = `wamid.msg-${Date.now()}`;
    appendWhatsAppMessage(user.id, "447900000001", "user", "hello there", [wamid]);

    const found = getWhatsAppMessageByWamid(user.id, wamid);
    expect(found?.content).toBe("hello there");
  });

  it("records every wamid for a chunked outbound reply against the same message row", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("wamid-chunks"));
    const first = `wamid.chunk1-${Date.now()}`;
    const second = `wamid.chunk2-${Date.now()}`;
    appendWhatsAppMessage(user.id, "447900000002", "assistant", "full reply text", [first, second]);

    expect(getWhatsAppMessageByWamid(user.id, first)?.content).toBe("full reply text");
    expect(getWhatsAppMessageByWamid(user.id, second)?.content).toBe("full reply text");
  });

  // Reported: a swipe on one part of a long, multi-part message (a list in the middle of a reply)
  // resolved to the whole message, and the model answered about a different part of it.
  it("remembers which part of a multi-part message each wamid was", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("wamid-parts"));
    const first = `wamid.part1-${Date.now()}`;
    const second = `wamid.part2-${Date.now()}`;
    appendWhatsAppMessage(user.id, "447900000005", "assistant", "Intro\n\n- Log Horizon\n- Megalobox", [
      { wamid: first, text: "Intro" },
      { wamid: second, text: "- Log Horizon\n- Megalobox" },
    ]);

    const found = getWhatsAppMessageByWamid(user.id, second);
    expect(found?.content).toBe("Intro\n\n- Log Horizon\n- Megalobox");
    expect(found?.partText).toBe("- Log Horizon\n- Megalobox");
    expect(getWhatsAppMessageByWamid(user.id, first)?.partText).toBe("Intro");
  });

  it("has no part text for a wamid recorded without one", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("wamid-nopart"));
    const wamid = `wamid.nopart-${Date.now()}`;
    appendWhatsAppMessage(user.id, "447900000006", "user", "hi", [wamid]);
    expect(getWhatsAppMessageByWamid(user.id, wamid)?.partText).toBeUndefined();
  });

  it("returns undefined for an unrecorded wamid", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("wamid-miss"));
    expect(getWhatsAppMessageByWamid(user.id, "wamid.never-seen")).toBeUndefined();
  });

  it("never resolves a wamid recorded under a different owner", () => {
    const owner = findOrCreateUserByEmail(uniqueEmail("wamid-owner"));
    const other = findOrCreateUserByEmail(uniqueEmail("wamid-other"));
    const wamid = `wamid.scoped-${Date.now()}`;
    appendWhatsAppMessage(owner.id, "447900000003", "user", "mine", [wamid]);

    expect(getWhatsAppMessageByWamid(other.id, wamid)).toBeUndefined();
  });

  it("appendWhatsAppMessage still works with no wamids given (existing callers)", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("wamid-optional"));
    expect(() => appendWhatsAppMessage(user.id, "447900000004", "user", "no wamid here")).not.toThrow();
  });
});

describe("getSentDocumentByWamid", () => {
  function savePhoto(ownerId: number) {
    return saveDocument(ownerId, {
      phone: "447900000009",
      filename: "bp.jpg",
      mimeType: "image/jpeg",
      storedPath: "/tmp/fake-sent-doc",
      caption: null,
      title: "Boarding pass",
      extractedText: "Flight BA123, seat 14C",
      category: "travel",
    });
  }

  it("finds a document Marlo sent back by the wamid of that send, for its owner only", () => {
    const owner = findOrCreateUserByEmail(uniqueEmail("sent-doc"));
    const other = findOrCreateUserByEmail(uniqueEmail("sent-doc-other"));
    const doc = savePhoto(owner.id);
    const wamid = `wamid.sent-doc-${Date.now()}`;
    recordSentDocumentWamid(owner.id, doc.id, wamid);

    expect(getSentDocumentByWamid(owner.id, wamid)?.extractedText).toBe("Flight BA123, seat 14C");
    expect(getSentDocumentByWamid(other.id, wamid)).toBeUndefined();
  });

  it("stops resolving once the document is deleted", () => {
    const owner = findOrCreateUserByEmail(uniqueEmail("sent-doc-deleted"));
    const doc = savePhoto(owner.id);
    const wamid = `wamid.sent-doc-del-${Date.now()}`;
    recordSentDocumentWamid(owner.id, doc.id, wamid);

    deleteDocument(owner.id, doc.id);

    expect(getSentDocumentByWamid(owner.id, wamid)).toBeUndefined();
  });
});

describe("getDocumentByWamid", () => {
  it("finds a saved document by the wamid of the WhatsApp message that carried it", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("doc-wamid"));
    const wamid = `wamid.doc-${Date.now()}`;
    const saved = saveDocument(user.id, {
      phone: "447900000005",
      filename: "photo.jpg",
      mimeType: "image/jpeg",
      storedPath: "/tmp/fake-doc-wamid",
      caption: null,
      title: "Test photo",
      extractedText: "a boarding pass for flight BA123",
      category: "travel",
      wamid,
    });

    const found = getDocumentByWamid(user.id, wamid);
    expect(found?.id).toBe(saved.id);
    expect(found?.extractedText).toBe("a boarding pass for flight BA123");
  });

  it("returns undefined when no document carries that wamid", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("doc-wamid-miss"));
    expect(getDocumentByWamid(user.id, "wamid.no-doc")).toBeUndefined();
  });

  it("never resolves a document saved under a different owner", () => {
    const owner = findOrCreateUserByEmail(uniqueEmail("doc-wamid-owner"));
    const other = findOrCreateUserByEmail(uniqueEmail("doc-wamid-other"));
    const wamid = `wamid.doc-scoped-${Date.now()}`;
    saveDocument(owner.id, {
      phone: "447900000006",
      filename: null,
      mimeType: "image/jpeg",
      storedPath: "/tmp/fake-doc-scoped",
      caption: null,
      title: null,
      extractedText: "text",
      category: null,
      wamid,
    });

    expect(getDocumentByWamid(other.id, wamid)).toBeUndefined();
  });
});
