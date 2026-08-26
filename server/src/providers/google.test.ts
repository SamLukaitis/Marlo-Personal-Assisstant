import { describe, it, expect } from "vitest";
import type { gmail_v1 } from "googleapis";
import { extractAttachmentMetas } from "./google.js";

describe("extractAttachmentMetas", () => {
  it("collects parts that carry both a filename and an attachmentId", () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", body: { data: "aGVsbG8" } },
        {
          mimeType: "application/pdf",
          filename: "boarding-pass.pdf",
          body: { attachmentId: "att-1", size: 12345 },
        },
      ],
    };
    expect(extractAttachmentMetas(payload)).toEqual([
      { id: "att-1", filename: "boarding-pass.pdf", mimeType: "application/pdf", size: 12345 },
    ]);
  });

  it("ignores inline parts with no filename (e.g. the text/plain body itself)", () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "text/plain",
      body: { data: "aGVsbG8" },
    };
    expect(extractAttachmentMetas(payload)).toEqual([]);
  });

  it("returns an empty array for an undefined payload", () => {
    expect(extractAttachmentMetas(undefined)).toEqual([]);
  });

  it("walks nested multipart wrappers to find an attachment alongside a multipart/alternative body", () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [{ mimeType: "text/plain", body: { data: "aGVsbG8" } }],
        },
        {
          mimeType: "image/jpeg",
          filename: "receipt.jpg",
          body: { attachmentId: "att-2", size: 500 },
        },
      ],
    };
    expect(extractAttachmentMetas(payload)).toEqual([
      { id: "att-2", filename: "receipt.jpg", mimeType: "image/jpeg", size: 500 },
    ]);
  });
});
