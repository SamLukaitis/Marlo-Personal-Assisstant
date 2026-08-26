import { describe, it, expect, vi, beforeEach } from "vitest";

const mockHubGetAttachment = vi.fn();
vi.mock("../services/hub.js", () => ({
  hubGetAttachment: (...args: unknown[]) => mockHubGetAttachment(...args),
}));

const { findOrCreateUserByEmail, saveDocument } = await import("../db/store.js");
const { resolveDocumentCategory, buildDerivedEntities, ingestEmailAttachment } = await import("./documents.js");

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

    const result = await ingestEmailAttachment({
      ownerId: user.id,
      accountId: 3,
      messageId: "msg-1",
      attachmentId: "att-1",
    });

    expect(result).toEqual({ ok: true, doc: existing, alreadyExtracted: true });
    expect(mockHubGetAttachment).not.toHaveBeenCalled();
  });

  it("reports 'unavailable' when the attachment can't be downloaded", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("ingest-unavailable"));
    mockHubGetAttachment.mockResolvedValue(null);

    const result = await ingestEmailAttachment({
      ownerId: user.id,
      accountId: 4,
      messageId: "msg-2",
      attachmentId: "att-2",
    });

    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });
});
