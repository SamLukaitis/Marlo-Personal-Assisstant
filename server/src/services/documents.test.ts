import { describe, it, expect } from "vitest";
import { resolveDocumentCategory, parseExtractionResponse } from "./documents.js";
import type Anthropic from "@anthropic-ai/sdk";

// Minimal fake shaped like an Anthropic.Message — only the fields parseExtractionResponse
// actually reads (content, stop_reason) are populated; cast past the rest of the real SDK type's
// required fields, which don't matter for this pure parsing logic.
function fakeResponse(content: Anthropic.Message["content"], stopReason = "end_turn"): Anthropic.Message {
  return { content, stop_reason: stopReason } as unknown as Anthropic.Message;
}

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

describe("parseExtractionResponse — match keys", () => {
  it("extracts matchKeys when the model calls record_match_keys", () => {
    const response = fakeResponse([
      { type: "tool_use", id: "1", name: "name_document", input: { title: "Delta Boarding Pass", category: "travel" } },
      { type: "tool_use", id: "2", name: "record_match_keys", input: { referenceCode: "K4X9QP", flightNumber: "DL1234" } },
      { type: "text", text: "Boarding pass for DL1234." },
    ]);
    const result = parseExtractionResponse(response);
    expect(result.matchKeys).toEqual({ referenceCode: "K4X9QP", flightNumber: "DL1234" });
  });

  it("returns null matchKeys when the model doesn't call record_match_keys", () => {
    const response = fakeResponse([
      { type: "tool_use", id: "1", name: "name_document", input: { title: "Amazon Receipt", category: "receipts_bookings" } },
      { type: "text", text: "A receipt with no travel identifiers." },
    ]);
    const result = parseExtractionResponse(response);
    expect(result.matchKeys).toBeNull();
  });
});
