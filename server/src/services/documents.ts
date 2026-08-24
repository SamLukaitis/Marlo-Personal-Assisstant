import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { PDFParse } from "pdf-parse";
import { downloadWhatsAppMedia } from "../providers/whatsapp.js";
import {
  saveDocument,
  saveCheckin,
  saveMatchKeys,
  uploadsDir,
  DOCUMENT_CATEGORIES,
  type DocumentRow,
  type DocumentCategory,
} from "../db/store.js";
import { encryptBuffer } from "./crypto.js";
import { validateTravelMovement, type TravelMovement } from "./travelValidation.js";
import { fetchPageText, type FetchFailureReason } from "./safeLinkFetcher.js";
import { checkDocumentAgainstRecentEmails, type MatchKeys } from "./reconciliation.js";

// Pure on purpose — the one bit of category logic worth its own unit test is "what happens when
// the model's tool call doesn't give us a valid category," and that doesn't need an Anthropic
// call in the loop to verify.
export function resolveDocumentCategory(raw: unknown): DocumentCategory | null {
  return typeof raw === "string" && (DOCUMENT_CATEGORIES as string[]).includes(raw)
    ? (raw as DocumentCategory)
    : null;
}

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

// Optional — the model only calls this if the document contains an identifier actually worth
// indexing for later cross-referencing against email. Folded into the same extraction call as
// name_document/record_travel_movement, so this costs nothing extra — see
// docs/superpowers/specs/2026-08-24-document-email-cross-referencing-design.md.
const RECORD_MATCH_KEYS_TOOL: Anthropic.Tool = {
  name: "record_match_keys",
  description:
    "Call this only if the document contains a machine-checkable identifier worth cross-" +
    "referencing against email later — a booking/confirmation/reference code, a flight number, " +
    "or a clear vendor name with a specific date. Skip it entirely if none of these are actually " +
    "present and legible; never guess or invent one.",
  input_schema: {
    type: "object",
    properties: {
      referenceCode: { type: "string", description: "Booking/confirmation/reference code exactly as shown" },
      flightNumber: { type: "string", description: "e.g. DL1234" },
      vendor: { type: "string", description: "Airline/hotel/company name, e.g. Delta, Hilton" },
      eventDate: { type: "string", description: "ISO 8601 date, e.g. 2026-09-12" },
    },
  },
};

// Named by the same call that extracts the facts, so titling costs nothing extra. A tool rather
// than a "start your reply with TITLE:" convention because the title has to survive intact —
// parsing it back out of prose breaks the moment the model reformats its own output.
const NAME_DOCUMENT_TOOL: Anthropic.Tool = {
  name: "name_document",
  description:
    "Give this document a short title for the user's file list. Always call this exactly once, for every document, before writing your extraction.",
  input_schema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description:
          "A specific 3-6 word title naming what this document is, in title case, with no trailing punctuation. Prefer concrete identifying detail over a generic category: 'Ryanair Boarding Pass, Faro' beats 'Boarding Pass'; 'Hilton Lisbon Booking' beats 'Hotel Confirmation'. Never include the user's own words from their message — describe the document itself.",
      },
      category: {
        type: "string",
        enum: DOCUMENT_CATEGORIES,
        description:
          "Which bucket this document belongs in on the user's file list: 'travel' (boarding passes, tickets, itineraries), 'id_legal' (licenses, passports, IDs, official paperwork), 'receipts_bookings' (receipts, invoices, hotel/booking confirmations), or 'other' for anything that genuinely doesn't fit those.",
      },
    },
    required: ["title", "category"],
  },
};

// Long enough to stay specific, short enough to sit on one line in the file list.
const MAX_TITLE_LENGTH = 60;

// A real digital PDF (not a scan/photo saved as PDF) has an embedded text layer pdf-parse can
// read exactly, for free, with zero risk of a misread digit — strictly better than vision for
// that case: cheaper (no image tokens) and more accurate (guaranteed-correct source text).
// Below this length, treat it as having no usable text layer (e.g. a scanned/photographed PDF)
// and fall back to vision, same as before.
const MIN_PDF_TEXT_LENGTH = 40;

async function extractPdfTextLayer(buffer: Buffer): Promise<string | null> {
  try {
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    await parser.destroy();
    const trimmed = result.text.trim();
    return trimmed.length >= MIN_PDF_TEXT_LENGTH ? trimmed : null;
  } catch (err) {
    console.warn("documents: pdf-parse failed, falling back to vision", err);
    return null;
  }
}

// Pure on purpose, exported for its own unit tests — same reasoning as resolveDocumentCategory.
interface ExtractionResult {
  text: string;
  title: string | null;
  category: DocumentCategory | null;
  movement: TravelMovement | null;
  matchKeys: MatchKeys | null;
}

// Shared by every extraction path (image/PDF today; link/voice-transcript text below) — the
// tool-call schemas and this response-parsing tail are the one part all of them have in common,
// so it's factored out rather than copied. Everything upstream of this (how the content blocks
// get built — vision, PDF text layer, plain text) stays specific to each source.
export function parseExtractionResponse(response: Anthropic.Message): ExtractionResult {
  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "record_travel_movement"
  );
  const nameUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "name_document"
  );
  const matchKeysUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "record_match_keys"
  );

  const nameInput = nameUse?.input as { title?: unknown; category?: unknown } | undefined;
  const rawTitle = nameInput?.title;
  const title =
    typeof rawTitle === "string" && rawTitle.trim()
      ? rawTitle.trim().slice(0, MAX_TITLE_LENGTH)
      : null;
  const category = resolveDocumentCategory(nameInput?.category);

  let text = textBlock?.text ?? "(couldn't extract any text from this file)";
  if (response.stop_reason === "max_tokens") {
    console.warn("documents: extraction hit max_tokens — output may be truncated");
    text += "\n\n(Note: this extraction was cut off before finishing — some details, possibly including dates, may be missing.)";
  }

  return {
    text,
    title,
    category,
    movement: toolUse ? (toolUse.input as TravelMovement) : null,
    matchKeys: matchKeysUse ? (matchKeysUse.input as MatchKeys) : null,
  };
}

// Deterministic guardrail applied identically wherever an extraction call can surface a travel
// movement (image/PDF, link) — see travelValidation.ts for why (hallucinated/misread dates are
// the top complaint here, and a single bad date silently corrupts the day-count log). A "reject"
// means the movement is dropped entirely (never stored as a checkin); "warn" still stores it
// (it's probably right) but the reasoning is appended to the document's text so it's visible to
// the user and to the assistant answering day-count questions, rather than hidden.
function applyTravelValidation(
  extractedText: string,
  movement: TravelMovement | null,
  uploadedAt: Date
): { finalText: string; storableMovement: TravelMovement | null } {
  if (!movement) return { finalText: extractedText, storableMovement: null };

  const validation = validateTravelMovement(movement, uploadedAt);
  if (validation.severity === "reject") {
    console.warn("documents: dropping extracted travel movement — failed validation", validation.issues);
    return {
      finalText:
        extractedText +
        `\n\n(A travel date/place in this document looked wrong and was not recorded: ` +
        `${validation.issues.join(" ")})`,
      storableMovement: null,
    };
  }
  if (validation.severity === "warn") {
    return {
      finalText:
        extractedText +
        `\n\n(Note: extracted travel details for this document are flagged for review — ` +
        `confidence ${Math.round(validation.confidence * 100)}%. ${validation.issues.join(" ")})`,
      storableMovement: movement,
    };
  }
  return { finalText: extractedText, storableMovement: movement };
}

async function extractDocument(buffer: Buffer, mimeType: string): Promise<ExtractionResult> {
  const uploadedAt = new Date().toISOString();
  const prompt =
    "Call name_document first to title this file, then do the extraction below.\n\n" +
    "This is a photo or document the user saved for later reference (e.g. a boarding pass, " +
    "license, ticket, receipt, booking confirmation, or ID). Extract: (1) what kind of " +
    "document this is, (2) every important fact actually part of the document — dates, names, " +
    "reference/confirmation/license codes, numbers, locations — transcribed exactly as shown, " +
    "(3) a one-sentence plain-English summary. Be thorough and factual about the document " +
    "itself; never guess at anything not actually visible. Ignore incidental phone/screenshot " +
    "chrome that isn't part of the document — status bar clock, battery/signal icons, " +
    "notification banners, browser or app UI — none of that is a document fact and none of it " +
    "should appear in the extraction.\n\n" +
    `This file was uploaded around ${uploadedAt}. If the document shows travel (e.g. a ` +
    "boarding pass) but a date has no year printed on it, infer the year from that upload " +
    "time — boarding passes are almost always saved on or near the day of travel — and call " +
    "record_travel_movement with the departure/arrival details.";

  const pdfText = mimeType === "application/pdf" ? await extractPdfTextLayer(buffer) : null;

  const base64 = buffer.toString("base64");
  const content: Anthropic.ContentBlockParam[] = pdfText
    ? [
        {
          type: "text",
          text: `Document text (extracted directly from the PDF's text layer — exact, not a transcription):\n\n${pdfText}\n\n${prompt}`,
        },
      ]
    : SUPPORTED_IMAGE_TYPES.has(mimeType)
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
    // 1024 was too tight for busier documents (e.g. a hotel booking confirmation with a full
    // pricing breakdown) — the model would hit the cap mid-sentence and silently drop whatever
    // it hadn't gotten to yet, which is exactly how dates/times went missing even though they
    // were legible in the image. 4096 gives real headroom; this is a one-time cost per upload.
    max_tokens: 4096,
    tools: [NAME_DOCUMENT_TOOL, TRAVEL_MOVEMENT_TOOL, RECORD_MATCH_KEYS_TOOL],
    messages: [{ role: "user", content }],
  });

  return parseExtractionResponse(response);
}

// Text-only counterpart to extractDocument — for content that arrives as plain text rather than
// an image/PDF (today: a fetched web page's readable text). Reuses the same tool schemas and
// response parsing so a saved link ends up in exactly the same shape as a saved photo/PDF, but
// vision is structurally unreachable here: this function never sees a buffer or a media type,
// only a string, so there's no way for it to accidentally spend image tokens.
const MAX_LINK_TEXT_CHARS = 12_000;

async function extractFactsFromLinkText(
  pageText: string,
  sourceUrl: string,
  uploadedAt: Date
): Promise<ExtractionResult> {
  const truncated = pageText.length > MAX_LINK_TEXT_CHARS;
  const bodyText = truncated ? pageText.slice(0, MAX_LINK_TEXT_CHARS) : pageText;

  const prompt =
    "Call name_document first to title this, then do the extraction below.\n\n" +
    "This is the readable text of a web page the user sent a link to via WhatsApp (e.g. a " +
    "flight/hotel booking confirmation, an event page, a receipt page). Extract: (1) what kind " +
    "of page this is, (2) every important fact actually part of the page — dates, names, " +
    "reference/confirmation codes, amounts, locations — transcribed exactly as shown, (3) a " +
    "one-sentence plain-English summary. Be thorough and factual; never guess at anything not " +
    "actually present in the text. Ignore navigation menus, cookie banners, ads, and other page " +
    "chrome that isn't the actual page content — none of that is a page fact and none of it " +
    "should appear in the extraction.\n\n" +
    `This link was opened around ${uploadedAt.toISOString()}. If the page shows travel dates ` +
    "without a year, infer the year from that time and call record_travel_movement with the " +
    "departure/arrival details, the same way you would for an uploaded boarding pass.\n\n" +
    `Source URL: ${sourceUrl}` +
    (truncated ? `\n\n(Page text truncated to the first ${MAX_LINK_TEXT_CHARS} characters.)` : "") +
    `\n\nPage text:\n${bodyText}`;

  const response = await getClient().messages.create({
    model: EXTRACTION_MODEL,
    max_tokens: 4096,
    tools: [NAME_DOCUMENT_TOOL, TRAVEL_MOVEMENT_TOOL, RECORD_MATCH_KEYS_TOOL],
    messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
  });

  return parseExtractionResponse(response);
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
  ownerId: number;
  phone: string;
  mediaId: string;
  mimeType: string;
  filename?: string;
  caption?: string;
}): Promise<DocumentRow> {
  const uploadedAt = new Date();
  const { buffer, mimeType: downloadedMimeType } = await downloadWhatsAppMedia(params.mediaId);
  const mimeType = params.mimeType || downloadedMimeType;

  const ext = EXTENSIONS[mimeType] ?? "bin";
  const storedName = `${Date.now()}-${crypto.randomUUID()}.${ext}`;
  const storedPath = path.join(uploadsDir, storedName);
  fs.writeFileSync(storedPath, encryptBuffer(buffer));

  const canAnalyze = SUPPORTED_IMAGE_TYPES.has(mimeType) || mimeType === "application/pdf";
  const {
    text: extractedText,
    title,
    category,
    movement,
    matchKeys,
  } = canAnalyze
    ? await extractDocument(buffer, mimeType)
    : {
        text: `(file type ${mimeType} isn't supported for automatic analysis — stored for download only)`,
        title: null,
        category: null,
        movement: null,
        matchKeys: null,
      };

  const { finalText, storableMovement } = applyTravelValidation(extractedText, movement, uploadedAt);

  const doc = saveDocument(params.ownerId, {
    phone: params.phone,
    filename: params.filename ?? null,
    mimeType,
    storedPath,
    caption: params.caption ?? null,
    title,
    extractedText: finalText,
    category,
  });

  if (storableMovement) {
    for (const c of movementToCheckins(storableMovement, doc.id)) {
      saveCheckin(params.ownerId, {
        country: c.country,
        city: c.city,
        checkedInAt: c.checkedInAt,
        source: "document",
        documentId: c.documentId,
      });
    }
  }

  if (matchKeys) {
    saveMatchKeys(params.ownerId, doc.id, matchKeys);
    // Fire-and-forget: this must never delay the "document saved" confirmation the user is
    // waiting on. Any match notification arrives as a separate follow-up message.
    void checkDocumentAgainstRecentEmails(params.ownerId, doc.id, doc.title ?? "a saved document", matchKeys).catch(
      (err) => console.error("documents: reconciliation check failed", err)
    );
  }

  return doc;
}

// "Save this link" path — a WhatsApp text message that's just a URL (see
// safeLinkFetcher.findSaveableUrl for the detection heuristic). Mirrors ingestWhatsAppMedia's
// shape (fetch/download -> extract -> validate travel facts -> store) but the "file" being
// stored is the page's cleaned, readable text rather than the raw source bytes — smaller and
// more directly useful if it's ever downloaded again than the original HTML would be, and it's
// exactly the same text the extraction call itself saw, so there's no mismatch between what's
// stored and what was analyzed.
export async function ingestWhatsAppLink(params: {
  ownerId: number;
  phone: string;
  url: string;
}): Promise<{ ok: true; doc: DocumentRow } | { ok: false; reason: FetchFailureReason }> {
  const uploadedAt = new Date();

  const fetched = await fetchPageText(params.url);
  if (!fetched.ok) {
    console.warn(`documents: link fetch failed (${fetched.reason})`, fetched.detail);
    return { ok: false, reason: fetched.reason };
  }

  const {
    text: extractedText,
    title,
    category,
    movement,
    matchKeys,
  } = await extractFactsFromLinkText(fetched.text, fetched.finalUrl, uploadedAt);

  const { finalText, storableMovement } = applyTravelValidation(extractedText, movement, uploadedAt);

  const storedName = `${Date.now()}-${crypto.randomUUID()}.txt`;
  const storedPath = path.join(uploadsDir, storedName);
  fs.writeFileSync(storedPath, encryptBuffer(Buffer.from(fetched.text, "utf8")));

  const doc = saveDocument(params.ownerId, {
    phone: params.phone,
    filename: null,
    mimeType: "text/plain",
    storedPath,
    caption: fetched.finalUrl,
    title,
    extractedText: finalText,
    category,
  });

  if (storableMovement) {
    for (const c of movementToCheckins(storableMovement, doc.id)) {
      saveCheckin(params.ownerId, {
        country: c.country,
        city: c.city,
        checkedInAt: c.checkedInAt,
        source: "document",
        documentId: c.documentId,
      });
    }
  }

  if (matchKeys) {
    saveMatchKeys(params.ownerId, doc.id, matchKeys);
    // Fire-and-forget: this must never delay the "document saved" confirmation the user is
    // waiting on. Any match notification arrives as a separate follow-up message.
    void checkDocumentAgainstRecentEmails(params.ownerId, doc.id, doc.title ?? "a saved document", matchKeys).catch(
      (err) => console.error("documents: reconciliation check failed", err)
    );
  }

  return { ok: true, doc };
}
