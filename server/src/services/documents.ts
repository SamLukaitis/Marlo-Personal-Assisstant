import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { downloadWhatsAppMedia } from "../providers/whatsapp.js";
import { saveDocument, saveCheckin, uploadsDir, type DocumentRow } from "../db/store.js";
import { encryptBuffer } from "./crypto.js";

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

// Optional — the model only calls this if the document clearly shows travel between two
// specific places on legible dates. Folding this into the same extraction call (rather than a
// second API call) keeps the cost the same as before; the day-counting math itself still
// happens deterministically in travelDays.ts, not here — this only supplies raw facts.
const TRAVEL_MOVEMENT_TOOL: Anthropic.Tool = {
  name: "record_travel_movement",
  description:
    "Call this only if the document clearly shows travel between two specific places on specific, legible dates (e.g. a boarding pass, ticket, or itinerary) — never guess or invent dates/places that aren't actually legible. Always include the arrival leg; include the departure leg too if the document also shows where the traveler came from (most boarding passes do).",
  input_schema: {
    type: "object",
    properties: {
      departureCountry: { type: "string" },
      departureCity: { type: "string" },
      departureDateTime: {
        type: "string",
        description: "ISO 8601 datetime, e.g. 2026-07-10T20:45:00. Omit if not shown.",
      },
      arrivalCountry: { type: "string" },
      arrivalCity: { type: "string" },
      arrivalDateTime: { type: "string", description: "ISO 8601 datetime" },
    },
    required: ["arrivalCountry", "arrivalCity", "arrivalDateTime"],
  },
};

interface TravelMovement {
  departureCountry?: string;
  departureCity?: string;
  departureDateTime?: string;
  arrivalCountry: string;
  arrivalCity: string;
  arrivalDateTime: string;
}

async function extractDocument(
  buffer: Buffer,
  mimeType: string
): Promise<{ text: string; movement: TravelMovement | null }> {
  const uploadedAt = new Date().toISOString();
  const prompt =
    "This is a photo or document the user saved for later reference (e.g. a boarding pass, " +
    "license, ticket, receipt, or ID). Extract: (1) what kind of document this is, (2) every " +
    "important fact visible — dates, names, reference/confirmation/license codes, numbers, " +
    "locations — transcribed exactly as shown, (3) a one-sentence plain-English summary. Be " +
    "thorough and factual; never guess at anything not actually visible.\n\n" +
    `This file was uploaded around ${uploadedAt}. If the document shows travel (e.g. a ` +
    "boarding pass) but a date has no year printed on it, infer the year from that upload " +
    "time — boarding passes are almost always saved on or near the day of travel — and call " +
    "record_travel_movement with the departure/arrival details.";

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
    tools: [TRAVEL_MOVEMENT_TOOL],
    messages: [{ role: "user", content }],
  });

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "record_travel_movement"
  );

  return {
    text: textBlock?.text ?? "(couldn't extract any text from this file)",
    movement: toolUse ? (toolUse.input as TravelMovement) : null,
  };
}

function movementToCheckins(
  movement: TravelMovement,
  documentId: number
): Array<{ country: string; city: string; checkedInAt: number; documentId: number }> {
  const checkins: Array<{ country: string; city: string; checkedInAt: number; documentId: number }> = [];

  if (movement.departureCountry && movement.departureCity && movement.departureDateTime) {
    const t = new Date(movement.departureDateTime).getTime();
    if (Number.isFinite(t)) {
      checkins.push({
        country: movement.departureCountry,
        city: movement.departureCity,
        checkedInAt: t,
        documentId,
      });
    }
  }

  const arrivalTime = new Date(movement.arrivalDateTime).getTime();
  if (Number.isFinite(arrivalTime)) {
    checkins.push({
      country: movement.arrivalCountry,
      city: movement.arrivalCity,
      checkedInAt: arrivalTime,
      documentId,
    });
  }

  return checkins;
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
  fs.writeFileSync(storedPath, encryptBuffer(buffer));

  const canAnalyze = SUPPORTED_IMAGE_TYPES.has(mimeType) || mimeType === "application/pdf";
  const { text: extractedText, movement } = canAnalyze
    ? await extractDocument(buffer, mimeType)
    : {
        text: `(file type ${mimeType} isn't supported for automatic analysis — stored for download only)`,
        movement: null,
      };

  const doc = saveDocument({
    phone: params.phone,
    filename: params.filename ?? null,
    mimeType,
    storedPath,
    caption: params.caption ?? null,
    extractedText,
  });

  if (movement) {
    for (const c of movementToCheckins(movement, doc.id)) {
      saveCheckin({
        country: c.country,
        city: c.city,
        checkedInAt: c.checkedInAt,
        source: "document",
        documentId: c.documentId,
      });
    }
  }

  return doc;
}
