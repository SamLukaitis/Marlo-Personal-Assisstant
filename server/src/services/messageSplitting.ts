// Splits an already-generated assistant reply into several WhatsApp-message-sized chunks so a
// long reply reads as a few natural bubbles instead of one wall of text — purely string
// processing on text the model already produced, so this never costs an extra API call. See
// whatsappReply.ts's sendAssistantReply, the only caller.
const MAX_CHUNK_LENGTH = 600;

// How long to pause before sending the NEXT chunk after this one, so multiple bubbles read as
// someone typing rather than a burst — lightly scaled by length, floor and cap keep it from ever
// feeling instant or dragging out for a max-length chunk. See whatsappReply.ts's sendAssistantReply.
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
// packed sentence-by-sentence up to the cap; a "sentence" that's itself over the cap (no
// terminating punctuation) falls through to word-boundary splitting instead of cutting mid-word.
function splitLongParagraph(paragraph: string): string[] {
  if (paragraph.length <= MAX_CHUNK_LENGTH) return [paragraph];

  const sentences = paragraph.split(/(?<=[.!?])\s+/);
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length <= MAX_CHUNK_LENGTH) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    if (sentence.length <= MAX_CHUNK_LENGTH) {
      current = sentence;
    } else {
      chunks.push(...splitByWords(sentence));
      current = "";
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function splitByWords(text: string): string[] {
  const words = text.split(/\s+/);
  const chunks: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= MAX_CHUNK_LENGTH) {
      current = candidate;
    } else {
      if (current) chunks.push(current);
      current = word;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
