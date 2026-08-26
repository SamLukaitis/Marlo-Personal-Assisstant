import { describe, it, expect } from "vitest";
import { buildHtmlReport, type ScenarioReport } from "./report.js";

function scenario(overrides: Partial<ScenarioReport>): ScenarioReport {
  return {
    fixtureId: "flight-change",
    variant: "direct-ask",
    prompt: "Do I have a flight booked?",
    reply: "Yes, DL1234 on 2026-09-12.",
    pass: true,
    flaky: false,
    missingFacts: [],
    deniedFacts: false,
    inventedIdentifiers: [],
    reasons: [],
    ...overrides,
  };
}

describe("buildHtmlReport", () => {
  it("embeds the pass/fail count summary", () => {
    const html = buildHtmlReport([scenario({ pass: true }), scenario({ pass: false, variant: "pushback" })]);
    expect(html).toContain("1");
    expect(html).toContain("2");
  });

  it("includes every fixture id and variant in the matrix", () => {
    const html = buildHtmlReport([
      scenario({ fixtureId: "flight-change", variant: "direct-ask", pass: true }),
      scenario({ fixtureId: "hotel-booking", variant: "multi-turn", pass: false }),
    ]);
    expect(html).toContain("flight-change");
    expect(html).toContain("hotel-booking");
    expect(html).toContain("direct-ask");
    expect(html).toContain("multi-turn");
  });

  it("surfaces failure reasons in the output", () => {
    const html = buildHtmlReport([
      scenario({ pass: false, reasons: ["reply denies the fact exists"] }),
    ]);
    expect(html).toContain("reply denies the fact exists");
  });

  it("escapes reply text so it can't break the page", () => {
    const html = buildHtmlReport([scenario({ reply: "<script>alert(1)</script>" })]);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("produces valid-looking self-contained HTML with no external requests", () => {
    const html = buildHtmlReport([scenario({})]);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html.toLowerCase()).toContain("<html");
  });

  it("handles an empty result set without throwing", () => {
    expect(() => buildHtmlReport([])).not.toThrow();
  });

  it("renders the full multi-turn transcript when provided, not just the last prompt/reply", () => {
    const html = buildHtmlReport([
      scenario({
        turns: [
          { role: "user", content: "Is there a flight change in my email?" },
          { role: "assistant", content: "Yes, DL1234 on 2026-09-12." },
          { role: "user", content: "Are you sure?" },
          { role: "assistant", content: "Yes, confirmed." },
        ],
      }),
    ]);
    expect(html).toContain("Is there a flight change in my email?");
    expect(html).toContain("Are you sure?");
  });

  it("falls back to prompt/reply as a two-turn transcript when turns isn't provided", () => {
    const html = buildHtmlReport([scenario({ prompt: "Do I have a flight?", reply: "Yes, DL1234." })]);
    expect(html).toContain("Do I have a flight?");
  });

  it("includes filter controls for passed/failed scenarios", () => {
    const html = buildHtmlReport([scenario({ pass: true }), scenario({ pass: false, variant: "pushback" })]);
    expect(html).toContain('data-filter="fail"');
    expect(html).toContain('data-filter="pass"');
  });

  it("includes run metadata and history when passed", () => {
    const html = buildHtmlReport([scenario({})], {
      timestamp: "2026-08-26T10:00:00.000Z",
      durationMs: 12345,
      history: [{ timestamp: "2026-08-25T10:00:00.000Z", passed: 8, total: 12 }],
    });
    expect(html).toContain("2026-08-26T10:00:00.000Z");
    expect(html).toContain("2026-08-25T10:00:00.000Z");
  });

  it("omits the history section when no history is passed", () => {
    const html = buildHtmlReport([scenario({})]);
    expect(html).not.toContain("Run history");
  });

  it("marks a flaky scenario distinctly from pass/fail, with its own filter button", () => {
    const html = buildHtmlReport([
      scenario({
        pass: false,
        flaky: true,
        repeats: [
          { pass: true, reasons: [], turns: [{ role: "user", content: "u1" }] },
          { pass: false, reasons: ["missing expected fact(s): DL1234"], turns: [{ role: "user", content: "u2" }] },
        ],
      }),
    ]);
    expect(html).toContain("FLAKY");
    expect(html).toContain('data-filter="flaky"');
    expect(html).toContain('data-status="flaky"');
  });

  it("does not show a flaky filter button when nothing is flaky", () => {
    const html = buildHtmlReport([scenario({ pass: true })]);
    expect(html).not.toContain('data-filter="flaky"');
  });

  it("renders each repeat's own transcript when a scenario ran more than once", () => {
    const html = buildHtmlReport([
      scenario({
        repeats: [
          { pass: true, reasons: [], turns: [{ role: "user", content: "first run question" }] },
          { pass: false, reasons: ["denied"], turns: [{ role: "user", content: "second run question" }] },
        ],
      }),
    ]);
    expect(html).toContain("first run question");
    expect(html).toContain("second run question");
    expect(html).toContain("run 1 of 2");
    expect(html).toContain("run 2 of 2");
  });

  it("does not show a per-repeat breakdown for a single-run scenario", () => {
    const html = buildHtmlReport([scenario({ repeats: [{ pass: true, reasons: [], turns: [] }] })]);
    expect(html).not.toContain("run 1 of 1");
  });
});
