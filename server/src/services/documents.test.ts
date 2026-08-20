import { describe, it, expect } from "vitest";
import { resolveDocumentCategory } from "./documents.js";

describe("resolveDocumentCategory", () => {
  it("accepts each known category", () => {
    expect(resolveDocumentCategory("travel")).toBe("travel");
    expect(resolveDocumentCategory("id_legal")).toBe("id_legal");
    expect(resolveDocumentCategory("receipts_bookings")).toBe("receipts_bookings");
    expect(resolveDocumentCategory("other")).toBe("other");
  });

  it("falls back to null for a value outside the fixed set", () => {
    expect(resolveDocumentCategory("receipt")).toBeNull();
  });

  it("falls back to null when missing entirely", () => {
    expect(resolveDocumentCategory(undefined)).toBeNull();
  });
});
