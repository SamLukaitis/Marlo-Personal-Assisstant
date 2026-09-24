import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { transcribeAudio, isTranscriptionConfigured, MAX_AUDIO_BYTES, TranscriptionError } from "./transcription.js";

const originalFetch = global.fetch;
const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.OPENAI_API_KEY = "sk-test";
});

afterEach(() => {
  global.fetch = originalFetch;
  process.env = { ...originalEnv };
});

function mockFetchJson(status: number, body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe("isTranscriptionConfigured", () => {
  it("is false without an OpenAI key", () => {
    delete process.env.OPENAI_API_KEY;
    expect(isTranscriptionConfigured()).toBe(false);
  });

  it("is true with an OpenAI key", () => {
    expect(isTranscriptionConfigured()).toBe(true);
  });
});

describe("transcribeAudio", () => {
  it("posts the audio to OpenAI and returns the transcript with token usage", async () => {
    const fetchMock = mockFetchJson(200, {
      text: "  Remind me to call mum at six.  ",
      usage: { type: "tokens", input_tokens: 120, output_tokens: 9, total_tokens: 129 },
    });

    const result = await transcribeAudio(Buffer.from("fake-ogg"), "audio/ogg; codecs=opus");

    expect(result).toEqual({
      text: "Remind me to call mum at six.",
      model: "gpt-4o-mini-transcribe",
      inputTokens: 120,
      outputTokens: 9,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(init.headers.Authorization).toBe("Bearer sk-test");
    const form = init.body as FormData;
    expect(form.get("model")).toBe("gpt-4o-mini-transcribe");
    // OpenAI detects the format from the filename's extension, not the part's content type.
    expect((form.get("file") as File).name).toBe("voice-note.ogg");
  });

  it("throws without calling OpenAI when no key is set", async () => {
    delete process.env.OPENAI_API_KEY;
    const fetchMock = mockFetchJson(200, { text: "x" });

    await expect(transcribeAudio(Buffer.from("a"), "audio/ogg")).rejects.toThrow(TranscriptionError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses audio over the size cap without uploading it", async () => {
    const fetchMock = mockFetchJson(200, { text: "x" });

    await expect(transcribeAudio(Buffer.alloc(MAX_AUDIO_BYTES + 1), "audio/ogg")).rejects.toThrow(/too long/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a format OpenAI can't read (e.g. WhatsApp's AMR) without uploading it", async () => {
    const fetchMock = mockFetchJson(200, { text: "x" });

    await expect(transcribeAudio(Buffer.from("a"), "audio/amr")).rejects.toThrow(TranscriptionError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws a TranscriptionError on a non-ok response", async () => {
    mockFetchJson(500, { error: { message: "boom" } });

    await expect(transcribeAudio(Buffer.from("a"), "audio/ogg")).rejects.toThrow(TranscriptionError);
  });

  it("throws on an empty transcript (silence, or nothing recognisable)", async () => {
    mockFetchJson(200, { text: "   " });

    await expect(transcribeAudio(Buffer.from("a"), "audio/ogg")).rejects.toThrow(/empty/);
  });
});
