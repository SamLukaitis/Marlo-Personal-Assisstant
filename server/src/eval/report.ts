// Builds a single self-contained HTML report from graded eval scenarios — a pass/fail summary
// bar plus a fixture x variant matrix, so a failure's location (which fact, which phrasing) is
// visible at a glance instead of buried in console output. No external requests, no build step:
// open the file directly in a browser.

export interface ScenarioReport {
  fixtureId: string;
  variant: string;
  prompt: string;
  reply: string;
  pass: boolean;
  missingFacts: string[];
  deniedFacts: boolean;
  inventedIdentifiers: string[];
  reasons: string[];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildHtmlReport(results: ScenarioReport[]): string {
  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  const failed = total - passed;
  const passRate = total > 0 ? Math.round((passed / total) * 100) : 0;

  const fixtureIds = [...new Set(results.map((r) => r.fixtureId))];
  const variants = [...new Set(results.map((r) => r.variant))];

  const cell = (fixtureId: string, variant: string): string => {
    const match = results.find((r) => r.fixtureId === fixtureId && r.variant === variant);
    if (!match) return `<td class="cell empty">—</td>`;
    const cls = match.pass ? "pass" : "fail";
    const title = match.pass ? "passed" : escapeHtml(match.reasons.join("; ") || "failed");
    return `<td class="cell ${cls}" title="${title}">${match.pass ? "✓" : "✗"}</td>`;
  };

  const matrixRows = fixtureIds
    .map(
      (fid) =>
        `<tr><th class="rowhead">${escapeHtml(fid)}</th>${variants.map((v) => cell(fid, v)).join("")}</tr>`
    )
    .join("\n");

  const detailRows = results
    .map((r) => {
      const cls = r.pass ? "pass" : "fail";
      const reasonList = r.reasons.length
        ? `<ul class="reasons">${r.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>`
        : "";
      return `<tr class="${cls}">
        <td>${escapeHtml(r.fixtureId)}</td>
        <td>${escapeHtml(r.variant)}</td>
        <td>${r.pass ? "✓ pass" : "✗ fail"}</td>
        <td class="prompt">${escapeHtml(r.prompt)}</td>
        <td class="reply">${escapeHtml(r.reply)}</td>
        <td>${reasonList}</td>
      </tr>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Grounding eval report</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 2rem; background: Canvas; color: CanvasText; }
  h1 { font-size: 1.4rem; }
  .summary { display: flex; gap: 1.5rem; margin: 1rem 0 2rem; }
  .stat { padding: 0.75rem 1.25rem; border-radius: 8px; background: color-mix(in srgb, CanvasText 6%, transparent); }
  .stat .n { font-size: 1.6rem; font-weight: 700; display: block; }
  .bar { height: 18px; border-radius: 9px; background: color-mix(in srgb, CanvasText 12%, transparent); overflow: hidden; width: 320px; margin-top: 0.5rem; }
  .bar-fill { height: 100%; background: #2e9e5b; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 2rem; }
  th, td { border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); padding: 0.4rem 0.6rem; text-align: left; font-size: 0.9rem; vertical-align: top; }
  .cell { text-align: center; font-weight: 700; }
  .cell.pass { color: #2e9e5b; }
  .cell.fail { color: #d64545; background: color-mix(in srgb, #d64545 12%, transparent); }
  .cell.empty { color: color-mix(in srgb, CanvasText 40%, transparent); }
  tr.fail { background: color-mix(in srgb, #d64545 8%, transparent); }
  .reasons { margin: 0; padding-left: 1.1rem; }
  .prompt, .reply { max-width: 320px; }
</style>
</head>
<body>
<h1>Grounding eval report</h1>
<div class="summary">
  <div class="stat"><span class="n">${total}</span>scenarios</div>
  <div class="stat"><span class="n">${passed}</span>passed</div>
  <div class="stat"><span class="n">${failed}</span>failed</div>
  <div class="stat">${passRate}% pass rate
    <div class="bar"><div class="bar-fill" style="width:${passRate}%"></div></div>
  </div>
</div>

<h2>Fixture &times; variant matrix</h2>
<table>
  <thead><tr><th>fixture</th>${variants.map((v) => `<th>${escapeHtml(v)}</th>`).join("")}</tr></thead>
  <tbody>${matrixRows}</tbody>
</table>

<h2>Details</h2>
<table>
  <thead><tr><th>fixture</th><th>variant</th><th>result</th><th>prompt</th><th>reply</th><th>reasons</th></tr></thead>
  <tbody>${detailRows}</tbody>
</table>
</body>
</html>`;
}
