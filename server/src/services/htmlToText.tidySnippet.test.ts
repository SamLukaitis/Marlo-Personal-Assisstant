import { describe, it, expect } from "vitest";
import { tidySnippet } from "./htmlToText.js";

describe("tidySnippet", () => {
  // Reported: a raw "everyone&#39;s" reached the user's WhatsApp.
  it("decodes the HTML entities Gmail leaves in its snippets", () => {
    expect(tidySnippet("products everyone&#39;s talking about &amp; more.")).toBe(
      "products everyone's talking about & more."
    );
  });

  it("collapses whitespace and line breaks", () => {
    expect(tidySnippet("Room type:\n  Pod-Style \t Hostel.")).toBe("Room type: Pod-Style Hostel.");
  });

  it("marks a provider-truncated preview with an ellipsis, but not a short message that just ends", () => {
    const truncated = "Your reservation is confirmed and we look forward to welcoming you ".repeat(3).trim().slice(0, 190);
    expect(tidySnippet(truncated).endsWith("…")).toBe(true);
    expect(tidySnippet("£120 due 1 Sep")).toBe("£120 due 1 Sep");
    expect(tidySnippet("Your reservation is confirmed.")).toBe("Your reservation is confirmed.");
  });

  it("cuts an over-long preview on a word boundary rather than mid-word", () => {
    const out = tidySnippet("alpha beta gamma delta epsilon", 14);
    expect(out).toBe("alpha beta…");
  });

  it("returns an empty string for an empty snippet", () => {
    expect(tidySnippet("  ")).toBe("");
  });
});
