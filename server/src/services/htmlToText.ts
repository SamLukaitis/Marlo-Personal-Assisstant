// Dependency-free HTML -> readable text. Regex/string based, which is inherently imperfect on
// pathological markup — acceptable because the output feeds an LLM extractor, not a strict
// parser. Optimized for: no script/style content leaking into output, sane paragraph breaks,
// decoded entities, and never re-activating entity-encoded markup as if it were live HTML.

const BLOCK_CLOSE =
  /<\/(?:p|div|li|tr|h[1-6]|blockquote|section|article|header|footer|main|aside|table|ul|ol|dl|dd|dt|figure|figcaption|pre)\s*>/gi;
const BREAK_TAGS = /<br\s*\/?\s*>/gi;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  copy: "©", reg: "®", trade: "™",
  euro: "€", pound: "£", yen: "¥", cent: "¢", deg: "°",
};

function safeCodePoint(cp: number): string {
  try {
    return String.fromCodePoint(cp);
  } catch {
    return "�";
  }
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const cp = parseInt(body.slice(2), 16);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? safeCodePoint(cp) : whole;
    }
    if (body.startsWith("#")) {
      const cp = parseInt(body.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? safeCodePoint(cp) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

// Gmail and Outlook cap their previews at roughly 200-255 characters, so an unfinished-looking
// preview well under this is a short message that simply ends that way, not a cut-off one.
const PROVIDER_PREVIEW_MIN_TRUNCATED = 150;

// Gmail's snippet is HTML-entity-encoded ("everyone&#39;s") and both providers cut it off wherever
// their preview limit falls. Decoded, whitespace-collapsed, ended on a word boundary, and marked
// with "…" when it was cut (by the provider or here) so a truncated preview reads as one.
export function tidySnippet(snippet: string, max = 220): string {
  let text = decodeEntities(snippet).replace(/\s+/g, " ").trim();
  let cut = false;
  if (text.length > max) {
    const head = text.slice(0, max);
    const lastSpace = head.lastIndexOf(" ");
    text = (lastSpace > max / 2 ? head.slice(0, lastSpace) : head).trimEnd();
    cut = true;
  }
  const looksUnfinished = !/[.!?…)"'”’]$/.test(text);
  return text && looksUnfinished && (cut || text.length >= PROVIDER_PREVIEW_MIN_TRUNCATED) ? `${text}…` : text;
}

export function htmlToText(html: string): string {
  let s = html;

  // 1. Comments first — they can wrap otherwise-live markup.
  s = s.replace(/<!--[\s\S]*?-->/g, " ");

  // 2. Drop content-bearing-noise elements entirely, BEFORE generic tag stripping — their inner
  // text must never leak into the output (a <script> body full of JS is not page content).
  s = s.replace(/<(script|style|noscript|template|iframe|object|embed|svg)\b[\s\S]*?<\/\1\s*>/gi, " ");
  s = s.replace(/<(script|style|noscript|iframe)\b[^>]*\/>/gi, " ");

  // 3. Capture <title> for context, then discard the rest of <head> (meta/link/style tags
  // carry nothing readable).
  const titleMatch = s.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, " ").trim() : "";
  s = s.replace(/<head\b[\s\S]*?<\/head\s*>/gi, " ");

  // 4. Structural tags become newlines so paragraphs survive as paragraphs.
  s = s.replace(BLOCK_CLOSE, "\n");
  s = s.replace(BREAK_TAGS, "\n");

  // 5. Strip every remaining tag.
  s = s.replace(/<[^>]*>/g, " ");

  // 6. Decode entities AFTER tag stripping, so an entity-encoded decoy like "&lt;script&gt;"
  // becomes inert visible text rather than ever being live markup at any point.
  s = decodeEntities(s);

  // 7. Normalize whitespace: collapse runs within a line, trim each line, collapse runs of
  // blank lines down to a single blank line.
  const lines = s
    .split("\n")
    .map((l) => l.replace(/[ \t\r\f\v ]+/g, " ").trim())
    .filter((l, i, arr) => l.length > 0 || (i > 0 && arr[i - 1].length > 0));

  let text = lines.join("\n").trim();
  if (title && !text.startsWith(title)) {
    text = title + "\n\n" + text;
  }
  return text;
}
