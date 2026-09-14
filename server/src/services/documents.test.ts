import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const mockHubGetAttachment = vi.fn();
const mockHubGetMessage = vi.fn();
vi.mock("../services/hub.js", () => ({
  hubGetAttachment: (...args: unknown[]) => mockHubGetAttachment(...args),
  hubGetMessage: (...args: unknown[]) => mockHubGetMessage(...args),
}));

const mockSendWhatsAppMediaFromBuffer = vi.fn();
vi.mock("../providers/whatsapp.js", () => ({
  downloadWhatsAppMedia: vi.fn(),
  sendWhatsAppMediaFromBuffer: (...args: unknown[]) => mockSendWhatsAppMediaFromBuffer(...args),
}));

const mockExtractRawText = vi.fn();
vi.mock("mammoth", () => ({
  default: { extractRawText: (...args: unknown[]) => mockExtractRawText(...args) },
}));

const { findOrCreateUserByEmail, saveDocument, getDocumentByWamid, uploadsDir } = await import("../db/store.js");
const { encryptBuffer } = await import("./crypto.js");
const { downloadWhatsAppMedia } = await import("../providers/whatsapp.js");
const {
  resolveDocumentCategory,
  buildDerivedEntities,
  extractDocxText,
  ingestEmailAttachment,
  ingestWhatsAppMedia,
  sendSavedDocumentFile,
} = await import("./documents.js");

describe("resolveDocumentCategory", () => {
  it("accepts each known category", () => {
    expect(resolveDocumentCategory("travel")).toBe("travel");
    expect(resolveDocumentCategory("id_legal")).toBe("id_legal");
    expect(resolveDocumentCategory("receipts")).toBe("receipts");
    expect(resolveDocumentCategory("other")).toBe("other");
  });

  it("falls back to null for a value outside the fixed set", () => {
    expect(resolveDocumentCategory("receipt")).toBeNull();
  });

  it("falls back to null when missing entirely", () => {
    expect(resolveDocumentCategory(undefined)).toBeNull();
  });
});

// The deterministic gate between the model's record_purchase/record_booking transcriptions and
// the entities table — pure, so the whole decision table runs offline with no API in the loop.
describe("extractDocxText", () => {
  beforeEach(() => {
    mockExtractRawText.mockReset();
  });

  it("trims mammoth's extracted text", async () => {
    mockExtractRawText.mockResolvedValue({ value: "  Hello from a Word doc  \n" });
    expect(await extractDocxText(Buffer.from("fake docx bytes"))).toBe("Hello from a Word doc");
  });

  it("returns null for a docx with no extractable text", async () => {
    mockExtractRawText.mockResolvedValue({ value: "   " });
    expect(await extractDocxText(Buffer.from("fake docx bytes"))).toBeNull();
  });

  it("returns null instead of throwing when mammoth can't parse the file", async () => {
    mockExtractRawText.mockRejectedValue(new Error("not a valid zip"));
    expect(await extractDocxText(Buffer.from("not actually a docx"))).toBeNull();
  });
});

describe("buildDerivedEntities", () => {
  const UPLOAD = new Date("2026-06-12T10:00:00Z");

  it("turns a clean printed purchase into an active expense with parsed minor units", () => {
    const [entity] = buildDerivedEntities(
      [{ vendor: "Hotel Eva", amount: "18,50", currency: "eur", date: "2026-06-12" }],
      [],
      UPLOAD
    );
    expect(entity.type).toBe("expense");
    expect(entity.status).toBe("active");
    expect(entity.data).toEqual({ vendor: "Hotel Eva", amountPence: 1850, currency: "EUR", date: "2026-06-12" });
  });

  it("drops a purchase whose amount can't be parsed", () => {
    expect(
      buildDerivedEntities([{ vendor: "X", amount: "unknown", currency: "EUR", date: "2026-06-12" }], [], UPLOAD)
    ).toHaveLength(0);
  });

  it("drops a purchase with a hallucinated currency", () => {
    expect(
      buildDerivedEntities([{ vendor: "X", amount: "5.00", currency: "EURO", date: "2026-06-12" }], [], UPLOAD)
    ).toHaveLength(0);
  });

  it("marks a doubtful-but-plausible extraction needs_review instead of dropping it", () => {
    const [entity] = buildDerivedEntities(
      [{ vendor: "X", amount: "5.00", currency: "EUR", date: "2025-06-12" }], // ~a year off upload
      [],
      UPLOAD
    );
    expect(entity.status).toBe("needs_review");
    expect(entity.confidence).toBeLessThan(1);
  });

  it("handles one document yielding both a booking and an expense", () => {
    const out = buildDerivedEntities(
      [{ vendor: "Hotel Eva", amount: "300.00", currency: "EUR", date: "2026-06-12" }],
      [{ kind: "hotel", name: "Hotel Eva, Faro", reference: "ABC123", startDate: "2026-06-12", endDate: "2026-06-15" }],
      UPLOAD
    );
    expect(out.map((e) => e.type).sort()).toEqual(["booking", "expense"]);
  });

  it("drops a booking with swapped dates but keeps a valid sibling", () => {
    const out = buildDerivedEntities(
      [],
      [
        { kind: "hotel", name: "Bad Hotel", startDate: "2026-06-15", endDate: "2026-06-12" },
        { kind: "flight", name: "FR1234 LIS→FAO", startDate: "2026-06-12" },
      ],
      UPLOAD
    );
    expect(out).toHaveLength(1);
    expect(out[0].data).toMatchObject({ kind: "flight", reference: null, endDate: null });
  });
});

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

beforeEach(() => {
  mockHubGetAttachment.mockReset();
  mockHubGetMessage.mockReset();
  mockSendWhatsAppMediaFromBuffer.mockReset();
  vi.mocked(downloadWhatsAppMedia).mockReset();
});

describe("ingestWhatsAppMedia", () => {
  it("stores the inbound message's wamid on the saved document, resolvable by getDocumentByWamid", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("ingest-media-wamid"));
    vi.mocked(downloadWhatsAppMedia).mockResolvedValue({
      buffer: Buffer.from("fake-zip-bytes"),
      mimeType: "application/zip",
    });
    const wamid = `wamid.media-${Date.now()}`;

    const doc = await ingestWhatsAppMedia({
      ownerId: user.id,
      phone: "447900000099",
      mediaId: "media-1",
      mimeType: "application/zip",
      wamid,
    });

    expect(doc.wamid).toBe(wamid);
    expect(getDocumentByWamid(user.id, wamid)?.id).toBe(doc.id);
  });
});

describe("ingestEmailAttachment", () => {
  it("short-circuits on a previously-extracted attachment without calling hubGetAttachment", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("ingest-dedup"));
    const existing = saveDocument(user.id, {
      phone: "email:3",
      filename: "receipt.pdf",
      mimeType: "application/pdf",
      storedPath: "/tmp/fake-existing",
      caption: null,
      title: "Existing Receipt",
      extractedText: "text",
      category: "receipts",
      source: "email",
      emailAccountId: 3,
      emailMessageId: "msg-1",
      emailAttachmentId: "att-1",
    });
    mockHubGetMessage.mockResolvedValue({
      attachments: [{ id: "att-1", filename: "receipt.pdf", mimeType: "application/pdf", size: 100 }],
    });

    const result = await ingestEmailAttachment({
      ownerId: user.id,
      accountId: 3,
      messageId: "msg-1",
      attachmentIndex: 1,
    });

    expect(result).toEqual({ ok: true, doc: existing, alreadyExtracted: true });
    expect(mockHubGetAttachment).not.toHaveBeenCalled();
  });

  it("reports 'unavailable' when the attachment can't be downloaded", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("ingest-unavailable"));
    mockHubGetMessage.mockResolvedValue({
      attachments: [{ id: "att-2", filename: "ticket.pdf", mimeType: "application/pdf", size: 100 }],
    });
    mockHubGetAttachment.mockResolvedValue(null);

    const result = await ingestEmailAttachment({
      ownerId: user.id,
      accountId: 4,
      messageId: "msg-2",
      attachmentIndex: 1,
    });

    expect(result).toEqual({ ok: false, reason: "unavailable" });
    expect(mockHubGetAttachment).toHaveBeenCalledWith(user.id, 4, "msg-2", "att-2");
  });

  it("reports 'invalid_index' without calling hubGetAttachment when the index is out of range", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("ingest-bad-index"));
    mockHubGetMessage.mockResolvedValue({
      attachments: [{ id: "att-3", filename: "ticket.pdf", mimeType: "application/pdf", size: 100 }],
    });

    const result = await ingestEmailAttachment({
      ownerId: user.id,
      accountId: 5,
      messageId: "msg-3",
      attachmentIndex: 2,
    });

    expect(result).toEqual({ ok: false, reason: "invalid_index" });
    expect(mockHubGetAttachment).not.toHaveBeenCalled();
  });
});

describe("sendSavedDocumentFile", () => {
  it("decrypts the stored file and sends it as WhatsApp media", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("send-doc"));
    const plaintext = Buffer.from("fake-jpeg-bytes");
    const storedPath = path.join(uploadsDir, `test-send-${Date.now()}.jpg`);
    fs.writeFileSync(storedPath, encryptBuffer(plaintext));
    const doc = saveDocument(user.id, {
      phone: "44700",
      filename: "license.jpg",
      mimeType: "image/jpeg",
      storedPath,
      caption: null,
      title: "Driving License",
      extractedText: "text",
      category: "id_legal",
    });
    mockSendWhatsAppMediaFromBuffer.mockResolvedValue(undefined);

    const result = await sendSavedDocumentFile(user.id, "44700", doc.id);

    expect(result).toEqual({ ok: true });
    expect(mockSendWhatsAppMediaFromBuffer).toHaveBeenCalledWith("44700", plaintext, "image/jpeg", "license.jpg");
    fs.unlinkSync(storedPath);
  });

  it("reports no_original_file for a document saved as text (link/email body, no real photo)", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("send-doc-text"));
    const storedPath = path.join(uploadsDir, `test-send-${Date.now()}.txt`);
    fs.writeFileSync(storedPath, encryptBuffer(Buffer.from("hello")));
    const doc = saveDocument(user.id, {
      phone: "44700",
      filename: null,
      mimeType: "text/plain",
      storedPath,
      caption: "https://example.com",
      title: "Some Link",
      extractedText: "text",
      category: "other",
    });

    const result = await sendSavedDocumentFile(user.id, "44700", doc.id);

    expect(result).toEqual({ ok: false, reason: "no_original_file" });
    expect(mockSendWhatsAppMediaFromBuffer).not.toHaveBeenCalled();
    fs.unlinkSync(storedPath);
  });

  it("reports not_found for an id that doesn't belong to this owner", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("send-doc-missing"));
    const result = await sendSavedDocumentFile(user.id, "44700", 999999);
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("reports send_failed when the WhatsApp send itself throws", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("send-doc-fail"));
    const storedPath = path.join(uploadsDir, `test-send-${Date.now()}.jpg`);
    fs.writeFileSync(storedPath, encryptBuffer(Buffer.from("bytes")));
    const doc = saveDocument(user.id, {
      phone: "44700",
      filename: "photo.jpg",
      mimeType: "image/jpeg",
      storedPath,
      caption: null,
      title: "A Photo",
      extractedText: "text",
      category: "other",
    });
    mockSendWhatsAppMediaFromBuffer.mockRejectedValue(new Error("boom"));

    const result = await sendSavedDocumentFile(user.id, "44700", doc.id);

    expect(result).toEqual({ ok: false, reason: "send_failed" });
    fs.unlinkSync(storedPath);
  });
});
