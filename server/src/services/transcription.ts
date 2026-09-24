// Speech-to-text for WhatsApp voice notes — Claude has no audio input, so a voice note is turned
// into text here and then handled exactly like a typed message (see whatsappRoutes.ts's
// handleAudio). One plain fetch to OpenAI, same no-SDK style as providers/whatsapp.ts's Graph calls.

const TRANSCRIPTION_URL = "https://api.openai.com/v1/audio/transcriptions";
export const TRANSCRIPTION_MODEL = process.env.TRANSCRIPTION_MODEL ?? "gpt-4o-mini-transcribe";

// A cost/abuse guard well under OpenAI's 25 MB upload limit: a WhatsApp voice note is opus at
// roughly 16–32 kbps, so 5 MB is ~20+ minutes of voice — anything bigger is almost certainly a
// forwarded recording nobody wants transcribed in full.
export const MAX_AUDIO_BYTES = 5 * 1024 * 1024;

// OpenAI picks the decoder from the uploaded filename's extension, so the MIME type WhatsApp
// reports has to be mapped to one it accepts. WhatsApp can also send audio/amr and audio/aac,
// which OpenAI doesn't read — those fail fast rather than burning an upload on a certain error.
const EXTENSION_BY_MIME: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/opus": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "webm",
  "audio/flac": "flac",
};

export class TranscriptionError extends Error {}

export interface TranscriptionResult {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

interface TranscriptionResponse {
  text?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export function isTranscriptionConfigured(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

export async function transcribeAudio(buffer: Buffer, mimeType: string): Promise<TranscriptionResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new TranscriptionError("OPENAI_API_KEY is not set");

  if (buffer.length > MAX_AUDIO_BYTES) {
    throw new TranscriptionError(`Audio too long to transcribe (${buffer.length} bytes)`);
  }

  // "audio/ogg; codecs=opus" → "audio/ogg"
  const baseMime = mimeType.split(";")[0].trim().toLowerCase();
  const extension = EXTENSION_BY_MIME[baseMime];
  if (!extension) throw new TranscriptionError(`Unsupported audio format: ${mimeType}`);

  const form = new FormData();
  form.append("model", TRANSCRIPTION_MODEL);
  form.append("file", new Blob([new Uint8Array(buffer)], { type: baseMime }), `voice-note.${extension}`);

  const res = await fetch(TRANSCRIPTION_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    throw new TranscriptionError(`Transcription failed (${res.status}): ${await res.text()}`);
  }

  const data = (await res.json()) as TranscriptionResponse;
  const text = data.text?.trim() ?? "";
  if (!text) throw new TranscriptionError("Transcription came back empty");

  return {
    text,
    model: TRANSCRIPTION_MODEL,
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
  };
}
