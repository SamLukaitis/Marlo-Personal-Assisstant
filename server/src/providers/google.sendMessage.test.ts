import { describe, it, expect } from "vitest";
import { buildRawEmail } from "./google.js";

function decode(raw: string): string {
  return Buffer.from(raw, "base64url").toString("utf8");
}

describe("buildRawEmail", () => {
  it("builds a plain message with no attachment", () => {
    const decoded = decode(buildRawEmail("xero@example.com", "Receipt", "See attached."));
    expect(decoded).toContain("To: xero@example.com");
    expect(decoded).toContain("Subject: Receipt");
    expect(decoded).toContain("Content-Type: text/plain; charset=utf-8");
    expect(decoded).toContain("See attached.");
    expect(decoded).not.toContain("multipart/mixed");
  });

  it("builds a multipart message carrying the attachment as base64, not inline text", () => {
    const data = Buffer.from("%PDF-1.4 fake receipt bytes");
    const decoded = decode(
      buildRawEmail("xero@example.com", "Receipt", "See attached.", {
        filename: "receipt.pdf",
        mimeType: "application/pdf",
        data,
      })
    );
    expect(decoded).toContain("Content-Type: multipart/mixed");
    expect(decoded).toContain('Content-Disposition: attachment; filename="receipt.pdf"');
    expect(decoded).toContain("Content-Transfer-Encoding: base64");
    expect(decoded).toContain(data.toString("base64"));
    // The raw PDF bytes must not appear unencoded in the body.
    expect(decoded).not.toContain(data.toString("utf8"));
  });
});
