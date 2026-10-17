import { describe, it, expect } from "vitest";
import { splitIntoChunks, delayForChunk } from "./messageSplitting.js";

describe("splitIntoChunks", () => {
  it("returns a single chunk unchanged for a one-paragraph reply", () => {
    expect(splitIntoChunks("Sure, done.")).toEqual(["Sure, done."]);
  });

  it("splits on a blank line into separate paragraph chunks", () => {
    const text = "First paragraph.\n\nSecond paragraph.";
    expect(splitIntoChunks(text)).toEqual(["First paragraph.", "Second paragraph."]);
  });

  it("collapses multiple blank lines and trims each chunk", () => {
    const text = "  First.  \n\n\n\n   Second.  ";
    expect(splitIntoChunks(text)).toEqual(["First.", "Second."]);
  });

  it("drops empty paragraphs produced by leading/trailing blank lines", () => {
    const text = "\n\nOnly paragraph.\n\n";
    expect(splitIntoChunks(text)).toEqual(["Only paragraph."]);
  });

  it("returns no chunks for blank input", () => {
    expect(splitIntoChunks("   \n\n  ")).toEqual([]);
  });

  it("hard-splits a single paragraph longer than the cap, on sentence boundaries", () => {
    const sentence = "This is one sentence that repeats a fair bit to build up length. ";
    const longParagraph = sentence.repeat(12).trim(); // well over 600 chars, no blank lines
    const chunks = splitIntoChunks(longParagraph);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(600);
    }
    // No words lost or reordered in the split.
    expect(chunks.join(" ")).toBe(longParagraph);
  });

  it("never splits in the middle of a list line, even when the list overflows the cap", () => {
    // Reproduces a real Marlowe reply: a markdown bullet list (single \n between items, so it's
    // one "paragraph") long enough to need splitting. Each bullet ends with a sentence and then a
    // trailing Map link — sentence-boundary packing alone can land a chunk break between a
    // bullet's prose and its own link, or glue a link onto the next bullet.
    const lines = [
      '- *Garota de Ipanema* — classic Brazilian, the famous spot the "Girl from Ipanema" was written about, just a block from the beach. One reviewer noted it\'s "located literally a block away from the Ipanema beach in Ipanema Food is great and because it\'s close to the beach it\'s got that vibe". [Map](https://www.google.com/maps/search/?api=1&query=Garota+de+Ipanema+Rio+de+Janeiro)',
      '- *Zazá Bistrô Tropical* — Brazilian/tropical fusion, popular bistro. [Map](https://www.google.com/maps/search/?api=1&query=Zaz%C3%A1+Bistr%C3%B4+Tropical+Rio+de+Janeiro)',
      "- *Teva Ipanema* — good for starting an evening out, known for a high-quality cocktail menu, the kind of place you'd begin a big Ipanema night out. [Map](https://www.google.com/maps/search/?api=1&query=Teva+Ipanema+Rio+de+Janeiro)",
      "- *Braseiro* — classic churrasco/grilled meats spot.",
    ];
    const text = lines.join("\n");
    expect(text.length).toBeGreaterThan(600); // sanity: this must actually require splitting

    const chunks = splitIntoChunks(text);
    for (const line of lines) {
      expect(chunks.some((chunk) => chunk.includes(line))).toBe(true);
    }
  });

  it("hard-splits on word boundaries when a run has no sentence-ending punctuation", () => {
    const longRun = Array.from({ length: 120 }, (_, i) => `word${i}`).join(" "); // no punctuation
    const chunks = splitIntoChunks(longRun);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(600);
    }
    expect(chunks.join(" ")).toBe(longRun);
  });
});

describe("delayForChunk", () => {
  it("scales up with chunk length", () => {
    expect(delayForChunk("hi")).toBeLessThan(delayForChunk("a".repeat(200)));
  });

  it("never returns less than the floor", () => {
    expect(delayForChunk("")).toBeGreaterThanOrEqual(400);
  });

  it("caps out for a very long chunk instead of growing unbounded", () => {
    expect(delayForChunk("a".repeat(600))).toBe(1500);
    expect(delayForChunk("a".repeat(6000))).toBe(1500);
  });
});
