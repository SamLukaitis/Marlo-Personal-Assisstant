// The /a/:code landing page. WhatsApp only makes https links tappable, so Marlowe's links land
// here: it lists the steps in plain words, then hands off to the Shortcut. Pure HTML, no session.
import type { PhoneActionView } from "./phoneActions.js";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const STYLE = `body{font:17px/1.45 -apple-system,system-ui,sans-serif;margin:0;padding:24px 16px;background:#faf9f7;color:#1c1b19}
main{max-width:420px;margin:0 auto}h1{font-size:22px;margin:0 0 12px}ul{padding-left:20px}
a.run{display:block;text-align:center;background:#1c1b19;color:#fff;padding:14px;border-radius:12px;text-decoration:none;font-weight:600;margin:20px 0}
.small{font-size:14px;color:#6b6760}@media (prefers-color-scheme:dark){body{background:#151413;color:#ece9e4}a.run{background:#ece9e4;color:#151413}.small{color:#a29d95}}`;

function page(title: string, body: string, script = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main>${script}</body></html>`;
}

export function renderActionPage(view: PhoneActionView): string {
  const install = view.installUrl
    ? `<p class="small">Don't have the Marlowe Shortcut yet? <a href="${esc(view.installUrl)}">Add it</a> (one time), then come back and tap Run.</p>`
    : "";
  if (view.state === "gone") {
    return page("Link expired", `<h1>This link has expired or was already used</h1><p>Ask Marlowe again for a fresh one.</p>${install}`);
  }
  const steps = view.summary.map((s) => `<li>${esc(s)}</li>`).join("");
  // Opening the Shortcut straight away saves a tap; the button is there if iOS blocks the jump.
  // JSON.stringify doesn't escape "<" (so "</script>" in the URL would end the tag early) or the
  // two line separators (which end a JS string literal in older engines). The "\u" in source is
  // the six-character escape, so the emitted JS carries the text \u003c, not a bare "<".
  const jsString = JSON.stringify(view.runUrl)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  const script = `<script>setTimeout(function(){location.href=${jsString}},300)</script>`;
  return page(
    view.label,
    `<h1>${esc(view.label)}</h1><p>Marlowe will:</p><ul>${steps}</ul><a class="run" href="${esc(view.runUrl)}">Run in Shortcuts</a>${install}`,
    script
  );
}
