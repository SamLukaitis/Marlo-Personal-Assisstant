import { describe, it, expect } from "vitest";
import { SA103_CATEGORIES, isCategoryKey } from "./categories.js";
import { buildCategorisePrompt, parseCategoryGuess } from "./categorise.js";

describe("categories", () => {
  it("covers the SA103 expense boxes", () => {
    expect(SA103_CATEGORIES.map((c) => c.key)).toEqual([
      "cost_of_goods",
      "car_van_travel",
      "staff",
      "premises",
      "repairs",
      "phone_office",
      "advertising",
      "finance_charges",
      "professional_fees",
      "other",
    ]);
    expect(isCategoryKey("repairs")).toBe(true);
    expect(isCategoryKey("entertainment")).toBe(false);
  });
});

describe("buildCategorisePrompt", () => {
  it("includes every category, the item and the business description", () => {
    const p = buildCategorisePrompt({ counterparty: "Screwfix", amountPence: 4820 }, "plumber");
    for (const c of SA103_CATEGORIES) expect(p).toContain(c.key);
    expect(p).toContain("Screwfix");
    expect(p).toContain("£48.20");
    expect(p).toContain("plumber");
  });
});

describe("parseCategoryGuess", () => {
  it("accepts a valid guess", () => {
    expect(parseCategoryGuess({ category: "repairs", business_use: "business" })).toEqual({
      category: "repairs",
      businessUse: "business",
    });
  });
  it("rejects unknown categories or uses", () => {
    expect(parseCategoryGuess({ category: "entertainment", business_use: "business" })).toBeNull();
    expect(parseCategoryGuess({ category: "repairs", business_use: "maybe" })).toBeNull();
    expect(parseCategoryGuess(undefined)).toBeNull();
  });
});
