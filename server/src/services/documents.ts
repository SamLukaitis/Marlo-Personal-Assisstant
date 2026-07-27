import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { downloadWhatsAppMedia } from "../providers/whatsapp.js";
import { saveDocument, uploadsDir, type DocumentRow } from "../db/store.js";

// Extraction is a one-time cost per uploaded file — worth the richer tier since a wrong digit
// in a transcribed code/number is worse than the marginal savings of a cheaper model.
const EXTRACTION_MODEL = process.env.ASSISTANT_MODEL_COMPLEX ?? "claude-sonnet-5";

const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

async function extractText(buffer: Buffer, mimeType: string): Promise<string> {
  const prompt =
    "This is a photo or document the user saved for later reference (e.g. a boarding pass, " +
    "license, ticket, receipt, or ID). Extract: (1) what kind of document this is, (2) every " +
    "important fact visible — dates, names, reference/confirmation/license codes, numbers, " +
    "locations — transcribed exactly as shown, (3) a one-sentence plain-English summary. Be " +
    "thorough and factual; never guess at anything not actually visible.";

  const base64 = buffer.toString("base64");
  const content: Anthropic.ContentBlockParam[] = SUPPORTED_IMAGE_TYPES.has(mimeType)
    ? [
        {
          type: "image",
          source: { type: "base64", media_type: mimeType as "image/jpeg", data: base64 },
        },
        { type: "text", text: prompt },
      ]
    : [
        {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: base64 },
        },
        { type: "text", text: prompt },
      ];

  const response = await getClient().messages.create({
    model: EXTRACTION_MODEL,
    max_tokens: 1024,
    messages: [{ role: "user", content }],
  });
  const text = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  return text?.text ?? "(couldn't extract any text from this file)";
}

export async function ingestWhatsAppMedia(params: {
  phone: string;
  mediaId: string;
  mimeType: string;
  filename?: string;
  caption?: string;
}): Promise<DocumentRow> {
  const { buffer, mimeType: downloadedMimeType } = await downloadWhatsAppMedia(params.mediaId);
  const mimeType = params.mimeType || downloadedMimeType;

  const ext = EXTENSIONS[mimeType] ?? "bin";
  const storedName = `${Date.now()}-${crypto.randomUUID()}.${ext}`;
  const storedPath = path.join(uploadsDir, storedName);
  fs.writeFileSync(storedPath, buffer);

  const canAnalyze = SUPPORTED_IMAGE_TYPES.has(mimeType) || mimeType === "application/pdf";
  const extractedText = canAnalyze
    ? await extractText(buffer, mimeType)
    : `(file type ${mimeType} isn't supported for automatic analysis — stored for download only)`;

  return saveDocument({
    phone: params.phone,
    filename: params.filename ?? null,
    mimeType,
    storedPath,
    caption: params.caption ?? null,
    extractedText,
  });
}
