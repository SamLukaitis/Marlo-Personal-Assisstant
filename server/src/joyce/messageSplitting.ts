// Splits a reply into several WhatsApp-message-sized chunks so a long answer reads as a few
// natural bubbles instead of one wall of text, with a short pause between them so it reads as
// someone typing. Purely string processing on text the model already produced.
//
// A copy of Marlo's services/messageSplitting.ts, kept in step by hand. Joyce can't import it:
// nothing in src/joyce/ may import Marlo's modules (isolation.test.ts enforces this). If you
// change the splitting rules in one, change them in the other.
const MAX_CHUNK_LENGTH = 600;

// How long to pause before sending the NEXT chunk after this one, so multiple bubbles read as
// someone typing rather than a burst — lightly scaled by length, floor and cap keep it from ever
// feeling instant or dragging out for a max-length chunk. See joyce/routes.ts's sendJoyceReply.
const DELAY_FLOOR_MS = 400;
const DELAY_CAP_MS = 1500;
const DELAY_MS_PER_CHAR = 4;

export function delayForChunk(chunk: string): number {
  return Math.min(DELAY_CAP_MS, DELAY_FLOOR_MS + chunk.length * DELAY_MS_PER_CHAR);
}

export function splitIntoChunks(text: string): string[] {
  const paragraphs = text
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const chunks: string[] = [];
  for (const paragraph of paragraphs) {
    chunks.push(...splitLongParagraph(paragraph));
  }
  return chunks;
}

// A paragraph within the cap passes through untouched (the common case — this keeps
// single-paragraph replies byte-identical to before this feature existed). A longer one is
// packed line-by-line up to the cap first, so a markdown list (bullets joined by single \n, all
// one "paragraph" as far as the blank-line split above is concerned) never gets cut in the middle
// of a bullet — a chunk boundary always falls between lines, never inside one. Only a single line
// that's itself over the cap falls through to sentence-boundary packing, and only a single
// sentence that's still over the cap falls through further to word-boundary splitting, so nothing
// ever gets cut mid-word.
function splitLongParagraph(paragraph: string): string[] {
  if (paragraph.length <= MAX_CHUNK_LENGTH) return [paragraph];

  const lines = paragraph.split("\n");
  if (lines.length > 1) {
    return packUnits(lines, "\n", splitLongParagraph);
  }

  const sentences = paragraph.split(/(?<=[.!?])\s+/);
  if (sentences.length > 1) {
    return packUnits(sentences, " ", splitByWords);
  }

  return splitByWords(paragraph);
}

function splitByWords(text: string): string[] {
  // An individual word longer than the cap (e.g. a long URL) is left oversized rather than cut
  // mid-word — same as before this fix.
  return packUnits(text.split(/\s+/), " ", (word) => [word]);
}

// Greedily packs `units` (joined by `joiner`) into chunks up to MAX_CHUNK_LENGTH. A unit that's
// itself over the cap is handed to `splitOversized` for finer-grained splitting.
function packUnits(units: string[], joiner: string, splitOversized: (unit: string) => string[]): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const unit of units) {
    const candidate = current ? `${current}${joiner}${unit}` : unit;
    if (candidate.length <= MAX_CHUNK_LENGTH) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    if (unit.length <= MAX_CHUNK_LENGTH) {
      current = unit;
    } else {
      chunks.push(...splitOversized(unit));
      current = "";
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
