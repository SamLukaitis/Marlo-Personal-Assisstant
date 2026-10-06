import { describe, it, expect } from "vitest";
import {
  IMPORTANT_EMAIL_CATEGORIES,
  CATEGORY_INFO,
  buildClassifyPrompt,
  parseClassifyMatches,
} from "./importantEmailClassifier.js";

describe("IMPORTANT_EMAIL_CATEGORIES / CATEGORY_INFO", () => {
  it("has exactly the 8 categories from the spec, in order", () => {
    expect(IMPORTANT_EMAIL_CATEGORIES).toEqual([
      "flight_change",
      "reservation_confirmed",
      "invoice_due",
      "government_mail",
      "delivery_notification",
      "security_alert",
      "subscription_renewal",
      "refund_dispute",
    ]);
  });

  it("has a complete, non-empty emoji/label/description for every category", () => {
    for (const category of IMPORTANT_EMAIL_CATEGORIES) {
      const info = CATEGORY_INFO[category as keyof typeof CATEGORY_INFO];
      expect(info).toBeDefined();
      expect(info.emoji.length).toBeGreaterThan(0);
      expect(info.label.length).toBeGreaterThan(0);
      expect(info.description.length).toBeGreaterThan(0);
    }
  });
});

describe("buildClassifyPrompt", () => {
  it("includes every category key and description", () => {
    const prompt = buildClassifyPrompt([]);
    for (const category of IMPORTANT_EMAIL_CATEGORIES) {
      expect(prompt).toContain(category);
      expect(prompt).toContain(CATEGORY_INFO[category as keyof typeof CATEGORY_INFO].description);
    }
  });

  it("tells the classifier not to match invoice_due against the user's own outgoing invoices", () => {
    // A user running their own business (e.g. sending invoices to their own clients) will have
    // automated notification mail like "your invoice to [client] was sent/paid/viewed" — that's
    // the user being paid, not owing payment, and must never trigger the same Xero-forward-offer
    // flow as a bill they actually owe.
    const prompt = buildClassifyPrompt([]);
    expect(prompt).toContain("Does NOT include a notification/copy/receipt for an invoice the user's own business issued");
  });

  // The classifier's summary IS the WhatsApp alert body (see formatImportantEmailAlert in
  // importantEmailAlerts.ts) — it has to read like a complete, human sentence with the key
  // specifics standing out, not a robotic fragment.
  it("instructs the model to bold key specifics in WhatsApp asterisk syntax and speak directly to the user", () => {
    const prompt = buildClassifyPrompt([]);
    expect(prompt).toMatch(/bold/i);
    expect(prompt).toContain("*text*");
    expect(prompt).toMatch(/\byour\b/i);
  });

  it("includes each candidate's index, subject, and snippet", () => {
    const prompt = buildClassifyPrompt([
      { index: 0, subject: "Your flight changed", snippet: "Gate moved to B12" },
      { index: 1, subject: "Invoice #4471", snippet: "£120 due 1 Sep" },
    ]);
    expect(prompt).toContain("[0]");
    expect(prompt).toContain("Your flight changed");
    expect(prompt).toContain("Gate moved to B12");
    expect(prompt).toContain("[1]");
    expect(prompt).toContain("Invoice #4471");
    expect(prompt).toContain("£120 due 1 Sep");
  });
});

describe("parseClassifyMatches", () => {
  it("returns a Map of index to category+summary for well-formed matches", () => {
    const result = parseClassifyMatches([
      { index: 0, category: "flight_change", summary: "Your gate moved to B12." },
      { index: 2, category: "invoice_due", summary: "£120 is due 1 Sep." },
    ]);
    expect(result).toEqual(
      new Map([
        [0, { category: "flight_change", summary: "Your gate moved to B12.", needsAction: false }],
        [2, { category: "invoice_due", summary: "£120 is due 1 Sep.", needsAction: false }],
      ])
    );
  });

  it("defaults summary to an empty string when missing or non-string", () => {
    const result = parseClassifyMatches([{ index: 0, category: "flight_change" }]);
    expect(result.get(0)).toEqual({ category: "flight_change", summary: "", needsAction: false });
  });

  it("skips entries with an unknown category", () => {
    const result = parseClassifyMatches([{ index: 0, category: "not_a_real_category" }]);
    expect(result.size).toBe(0);
  });

  it("skips entries with a non-numeric index", () => {
    const result = parseClassifyMatches([{ index: "zero", category: "flight_change" }]);
    expect(result.size).toBe(0);
  });

  it("returns an empty Map for non-array input", () => {
    expect(parseClassifyMatches(undefined).size).toBe(0);
    expect(parseClassifyMatches(null).size).toBe(0);
    expect(parseClassifyMatches("nope").size).toBe(0);
  });
});

describe("needs_action", () => {
  it("parses needs_action, defaulting to false", () => {
    const parsed = parseClassifyMatches([
      { index: 0, category: "delivery_notification", summary: "x", needs_action: true },
      { index: 1, category: "delivery_notification", summary: "y" },
    ]);
    expect(parsed.get(0)?.needsAction).toBe(true);
    expect(parsed.get(1)?.needsAction).toBe(false);
  });

  it("asks the model whether the user must do something", () => {
    expect(buildClassifyPrompt([{ index: 0, subject: "s", snippet: "t" }])).toMatch(/needs_action/);
  });
});
