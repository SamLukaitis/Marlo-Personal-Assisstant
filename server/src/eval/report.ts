// Builds a single self-contained HTML report from graded eval scenarios — a pass/fail summary
// bar, a fixture x variant matrix, filterable per-scenario transcripts, and a run-history trend
// — so a failure's location (which fact, which phrasing) and *why* is visible at a glance
// instead of buried in console output or a raw JSON file. No external requests, no build step,
// no server: open the file directly in a browser after `npm run eval:grounding`.

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

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
  turns?: ConversationTurn[];
  durationMs?: number;
}

export interface RunHistoryEntry {
  timestamp: string;
  passed: number;
  total: number;
}

export interface RunMeta {
  timestamp: string;
  durationMs: number;
  history?: RunHistoryEntry[];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function slug(value: string): string {
  return value.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

function cardId(fixtureId: string, variant: string): string {
  return `s-${slug(fixtureId)}-${slug(variant)}`;
}

export function buildHtmlReport(results: ScenarioReport[], meta?: RunMeta): string {
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
    return `<td class="cell ${cls}" title="${title}"><a href="#${cardId(fixtureId, variant)}">${match.pass ? "✓" : "✗"}</a></td>`;
  };

  const matrixRows = fixtureIds
    .map(
      (fid) =>
        `<tr><th class="rowhead">${escapeHtml(fid)}</th>${variants.map((v) => cell(fid, v)).join("")}</tr>`
    )
    .join("\n");

  const bubble = (turn: ConversationTurn): string =>
    `<div class="bubble ${turn.role}"><span class="role">${turn.role}</span>${escapeHtml(turn.content)}</div>`;

  const transcript = (r: ScenarioReport): string => {
    const turns: ConversationTurn[] = r.turns?.length
      ? r.turns
      : [
          { role: "user", content: r.prompt },
          { role: "assistant", content: r.reply },
        ];
    return `<div class="transcript">${turns.map(bubble).join("")}</div>`;
  };

  const cards = results
    .map((r) => {
      const cls = r.pass ? "pass" : "fail";
      const reasonList = r.reasons.length
        ? `<ul class="reasons">${r.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>`
        : `<p class="ok">No issues found.</p>`;
      const duration = r.durationMs != null ? `<span class="duration">${(r.durationMs / 1000).toFixed(1)}s</span>` : "";
      return `<div class="card ${cls}" id="${cardId(r.fixtureId, r.variant)}" data-pass="${r.pass}">
        <div class="card-head">
          <span class="badge ${cls}">${r.pass ? "PASS" : "FAIL"}</span>
          <strong>${escapeHtml(r.fixtureId)}</strong>
          <span class="variant-tag">${escapeHtml(r.variant)}</span>
          ${duration}
        </div>
        ${reasonList}
        ${transcript(r)}
      </div>`;
    })
    .join("\n");

  const historySection = meta?.history?.length
    ? `<h2>Run history</h2>
<table>
  <thead><tr><th>when</th><th>passed</th><th>rate</th></tr></thead>
  <tbody>${meta.history
    .map((h) => {
      const rate = h.total > 0 ? Math.round((h.passed / h.total) * 100) : 0;
      return `<tr><td>${escapeHtml(h.timestamp)}</td><td>${h.passed}/${h.total}</td><td>
        <div class="bar small"><div class="bar-fill" style="width:${rate}%"></div></div>${rate}%
      </td></tr>`;
    })
    .join("\n")}</tbody>
</table>`
    : "";

  const runMetaLine = meta
    ? `<p class="run-meta">Run at ${escapeHtml(meta.timestamp)} · took ${(meta.durationMs / 1000).toFixed(1)}s</p>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Grounding eval report</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 2rem; background: Canvas; color: CanvasText; }
  h1 { font-size: 1.4rem; }
  .run-meta { color: color-mix(in srgb, CanvasText 55%, transparent); font-size: 0.85rem; margin-top: -0.5rem; }
  .summary { display: flex; gap: 1.5rem; margin: 1rem 0 2rem; flex-wrap: wrap; }
  .stat { padding: 0.75rem 1.25rem; border-radius: 8px; background: color-mix(in srgb, CanvasText 6%, transparent); }
  .stat .n { font-size: 1.6rem; font-weight: 700; display: block; }
  .bar { height: 18px; border-radius: 9px; background: color-mix(in srgb, CanvasText 12%, transparent); overflow: hidden; width: 320px; margin-top: 0.5rem; }
  .bar.small { height: 10px; width: 120px; display: inline-block; vertical-align: middle; margin-right: 0.4rem; }
  .bar-fill { height: 100%; background: #2e9e5b; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 2rem; }
  th, td { border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); padding: 0.4rem 0.6rem; text-align: left; font-size: 0.9rem; vertical-align: top; }
  .cell { text-align: center; font-weight: 700; }
  .cell a { text-decoration: none; color: inherit; display: block; }
  .cell.pass { color: #2e9e5b; }
  .cell.fail { color: #d64545; background: color-mix(in srgb, #d64545 12%, transparent); }
  .cell.empty { color: color-mix(in srgb, CanvasText 40%, transparent); }
  .filters { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
  .filter-btn { padding: 0.4rem 0.9rem; border-radius: 999px; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); background: transparent; color: CanvasText; cursor: pointer; font-size: 0.85rem; }
  .filter-btn.active { background: CanvasText; color: Canvas; }
  .card { border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 10px; padding: 0.9rem 1.1rem; margin-bottom: 0.9rem; scroll-margin-top: 1rem; }
  .card.fail { background: color-mix(in srgb, #d64545 6%, transparent); border-color: color-mix(in srgb, #d64545 40%, transparent); }
  .card-head { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.5rem; }
  .badge { font-size: 0.7rem; font-weight: 700; letter-spacing: 0.04em; padding: 0.15rem 0.5rem; border-radius: 4px; }
  .badge.pass { background: #2e9e5b; color: white; }
  .badge.fail { background: #d64545; color: white; }
  .variant-tag { font-size: 0.8rem; color: color-mix(in srgb, CanvasText 55%, transparent); }
  .duration { margin-left: auto; font-size: 0.75rem; color: color-mix(in srgb, CanvasText 45%, transparent); }
  .reasons { margin: 0 0 0.6rem; padding-left: 1.1rem; color: #d64545; }
  .ok { margin: 0 0 0.6rem; color: color-mix(in srgb, CanvasText 55%, transparent); font-size: 0.85rem; }
  .transcript { display: flex; flex-direction: column; gap: 0.4rem; }
  .bubble { border-radius: 8px; padding: 0.5rem 0.7rem; font-size: 0.85rem; white-space: pre-wrap; max-width: 90%; }
  .bubble .role { display: block; font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.6; margin-bottom: 0.15rem; }
  .bubble.user { background: color-mix(in srgb, CanvasText 8%, transparent); align-self: flex-end; }
  .bubble.assistant { background: color-mix(in srgb, #2e6fd6 12%, transparent); align-self: flex-start; }
</style>
</head>
<body>
<h1>Grounding eval report</h1>
${runMetaLine}
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

${historySection}

<h2>Scenarios</h2>
<div class="filters">
  <button class="filter-btn active" data-filter="all">All (${total})</button>
  <button class="filter-btn" data-filter="fail">Failed (${failed})</button>
  <button class="filter-btn" data-filter="pass">Passed (${passed})</button>
</div>
${cards}

<script>
document.querySelectorAll(".filter-btn").forEach(function (btn) {
  btn.addEventListener("click", function () {
    document.querySelectorAll(".filter-btn").forEach(function (b) { b.classList.remove("active"); });
    btn.classList.add("active");
    var f = btn.dataset.filter;
    document.querySelectorAll(".card").forEach(function (card) {
      var isPass = card.dataset.pass === "true";
      var show = f === "all" || (f === "pass" && isPass) || (f === "fail" && !isPass);
      card.style.display = show ? "" : "none";
    });
  });
});
</script>
</body>
</html>`;
}
