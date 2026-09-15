import { describe, it, expect } from "vitest";
import { isPlausibleName } from "./plausibleName.js";

describe("isPlausibleName", () => {
  it("accepts ordinary one-to-three-word names", () => {
    expect(isPlausibleName("Sam")).toBe(true);
    expect(isPlausibleName("Mary Jane")).toBe(true);
    expect(isPlausibleName("Jean-Paul")).toBe(true);
    expect(isPlausibleName("O'Brien")).toBe(true);
    expect(isPlausibleName("  Sam  ")).toBe(true);
  });

  it("rejects a frustrated re-answer to a repeated question", () => {
    // The real bug: asked "what should I call you?" twice, the user replied "I already said
    // Sam" the second time, and that whole sentence got stored as the display name.
    expect(isPlausibleName("I already said Sam")).toBe(false);
  });

  it("rejects long or sentence-shaped text", () => {
    expect(isPlausibleName("please stop asking me this")).toBe(false);
    expect(isPlausibleName("a".repeat(41))).toBe(false);
    expect(isPlausibleName("Sam, again?")).toBe(false);
    expect(isPlausibleName("Sam123")).toBe(false);
  });

  it("rejects blank input", () => {
    expect(isPlausibleName("")).toBe(false);
    expect(isPlausibleName("   ")).toBe(false);
  });
});
