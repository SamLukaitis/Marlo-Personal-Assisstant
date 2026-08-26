import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { PDFParse } from "pdf-parse";
import { downloadWhatsAppMedia } from "../providers/whatsapp.js";
import { hubGetAttachment } from "./hub.js";
import {
  saveDocument,
  saveCheckin,
  saveMatchKeys,
  saveEntity,
  linkRecords,
  uploadsDir,
  DOCUMENT_CATEGORIES,
  findDocumentByEmailAttachment,
  type DocumentRow,
  type DocumentCategory,
  type DocumentSource,
} from "../db/store.js";
import { encryptBuffer } from "./crypto.js";
import { validateTravelMovement, type TravelMovement } from "./travelValidation.js";
import {
  validateExpense,
  validateBooking,
  parseAmountToMinorUnits,
  type ExpenseData,
  type BookingData,
} from "./entityValidation.js";
import { fetchPageText, type FetchFailureReason } from "./safeLinkFetcher.js";
import { checkDocumentAgainstRecentEmails, type MatchKeys } from "./reconciliation.js";
import { forwardReceiptToXero } from "./xeroForwarding.js";

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

// Like record_travel_movement, these ride the SAME single extraction call — no extra API cost.
// Content-based on purpose: whether to record a purchase/booking is decided by what's actually
// in the document, never by which category it was filed under (a hotel confirmation files under
// 'travel' but still shows money spent — it should produce both a booking and an expense).
// The model only transcribes what's printed; all arithmetic, currency, and date checking happens
// deterministically in entityValidation.ts before anything is stored.
const RECORD_PURCHASE_TOOL: Anthropic.Tool = {
  name: "record_purchase",
  description:
    "Call this if the document clearly shows money paid to a specific vendor — a receipt, invoice, or a booking confirmation that shows the amount charged. Transcribe only what is printed; never infer or compute an amount. Skip it if no total amount is legible. Call once per distinct payment shown.",
  input_schema: {
    type: "object",
    properties: {
      vendor: { type: "string", description: "Who was paid, as printed (e.g. 'Ryanair', 'Hotel Eva')" },
      amount: {
        type: "string",
        description: "The total amount exactly as printed, e.g. '18.50' or '1.234,56' — do not convert or reformat",
      },
      currency: { type: "string", description: "ISO 4217 code: GBP, EUR, USD… Infer from the printed symbol only if unambiguous." },
      date: { type: "string", description: "Payment/receipt date as YYYY-MM-DD" },
    },
    required: ["vendor", "amount", "currency", "date"],
  },
};

const RECORD_BOOKING_TOOL: Anthropic.Tool = {
  name: "record_booking",
  description:
    "Call this if the document clearly shows a reservation — a flight or hotel booking confirmation with legible dates. Transcribe only what is printed; never guess dates. Call once per distinct reservation shown (a page confirming a flight AND a hotel is two calls).",
  input_schema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["flight", "hotel"] },
      name: {
        type: "string",
        description: "Short identifying label: flight number + route for flights ('FR1234 LIS→FAO'), property name + city for hotels ('Hotel Eva, Faro')",
      },
      reference: { type: "string", description: "Confirmation/PNR code if legible. Omit if not shown." },
      startDate: { type: "string", description: "Flight date / hotel check-in, as YYYY-MM-DD" },
      endDate: { type: "string", description: "Hotel check-out as YYYY-MM-DD. Omit for flights." },
    },
    required: ["kind", "name", "startDate"],
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
          "Which bucket this document belongs in on the user's file list: 'travel' (boarding passes, tickets, itineraries, flight/hotel booking confirmations), 'id_legal' (licenses, passports, IDs, official paperwork), 'receipts' (receipts, invoices — purchases, not bookings), or 'other' for anything that genuinely doesn't fit those.",
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
// Below this length, don't even bother with the gibberish check below — too short to be a real
// text layer (e.g. a scanned/photographed PDF) — just fall back to vision, same as before.
const MIN_PDF_TEXT_LENGTH = 40;

// Cheap/fast tier — this only has to make a garbled-vs-clean call, not do real extraction.
const GIBBERISH_CHECK_MODEL = process.env.ASSISTANT_MODEL_SIMPLE ?? "claude-haiku-4-5";

// A length check alone can't tell a clean transcript from font-mangled garbage that happens to
// be long — ticket/boarding-pass PDFs often render the fields that actually matter (date, time,
// reference number) with custom or barcode fonts pdf-parse can't decode, while the surrounding
// boilerplate text extracts fine and pads the result past any length threshold. This is what
// actually catches that: a fast model reading the text and judging whether a meaningful chunk of
// it is corrupted, not just checking how many characters came out.
async function looksLikeGibberish(text: string): Promise<boolean> {
  const response = await getClient().messages.create({
    model: GIBBERISH_CHECK_MODEL,
    max_tokens: 5,
    messages: [
      {
        role: "user",
        content:
          "The following text was pulled from a PDF by an automated text-layer parser. Some " +
          "PDFs (tickets, boarding passes, etc.) render key fields like dates, times, and " +
          "reference numbers in custom or barcode fonts that this kind of parser can't decode " +
          "properly, leaving those specific fields garbled or missing even when the surrounding " +
          "text extracts fine. Judge whether a meaningful portion of THIS text shows that kind of " +
          "corruption — not just odd spacing or minor typos, but characters/sequences that don't " +
          "reflect real content. Reply with exactly one word: GIBBERISH or CLEAN.\n\n" + text,
      },
    ],
  });
  const answer = response.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text ?? "";
  return answer.toUpperCase().includes("GIBBERISH");
}

async function extractPdfTextLayer(buffer: Buffer): Promise<string | null> {
  try {
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    await parser.destroy();
    const trimmed = result.text.trim();
    if (trimmed.length < MIN_PDF_TEXT_LENGTH) return null;
    if (await looksLikeGibberish(trimmed)) {
      console.warn("documents: pdf text layer looked garbled — falling back to vision");
      return null;
    }
    return trimmed;
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
  purchases: unknown[];
  bookings: unknown[];
}

// Shared by every extraction path (image/PDF, and link text below) — calling name_document
// "before writing your extraction" doesn't guarantee the model actually continues on to write it
// in the same turn: a model that calls a tool can just as validly stop there (stop_reason
// "tool_use") with no text at all, leaving the extraction empty even though the tool calls
// themselves succeeded. A single non-looping call can't recover from that; feed the tool calls
// back as normal tool_results and let the conversation continue, same as the main assistant loop
// in ai/assistant.ts does, until the model actually produces the write-up.
async function runExtraction(initialContent: Anthropic.ContentBlockParam[]): Promise<ExtractionResult> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: initialContent }];
  let response: Anthropic.Message;
  let textBlock: Anthropic.TextBlock | undefined;
  let toolUse: Anthropic.ToolUseBlock | undefined;
  let nameUse: Anthropic.ToolUseBlock | undefined;
  let matchKeysUse: Anthropic.ToolUseBlock | undefined;
  const purchases: unknown[] = [];
  const bookings: unknown[] = [];

  for (let turn = 0; turn < 3; turn++) {
    response = await getClient().messages.create({
      model: EXTRACTION_MODEL,
      // 1024 was too tight for busier documents (e.g. a hotel booking confirmation with a full
      // pricing breakdown) — the model would hit the cap mid-sentence and silently drop whatever
      // it hadn't gotten to yet, which is exactly how dates/times went missing even though they
      // were legible in the image. 4096 gives real headroom; this is a one-time cost per upload.
      max_tokens: 4096,
      tools: [NAME_DOCUMENT_TOOL, TRAVEL_MOVEMENT_TOOL, RECORD_MATCH_KEYS_TOOL, RECORD_PURCHASE_TOOL, RECORD_BOOKING_TOOL],
      messages,
    });

    textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );
    toolUse = toolUses.find((b) => b.name === "record_travel_movement") ?? toolUse;
    nameUse = toolUses.find((b) => b.name === "name_document") ?? nameUse;
    matchKeysUse = toolUses.find((b) => b.name === "record_match_keys") ?? matchKeysUse;
    // Arrays, not single slots — one document can legitimately show several payments or
    // reservations (an itinerary confirming a flight and a hotel is two bookings).
    purchases.push(...toolUses.filter((b) => b.name === "record_purchase").map((b) => b.input));
    bookings.push(...toolUses.filter((b) => b.name === "record_booking").map((b) => b.input));

    if (textBlock || toolUses.length === 0) break;

    messages.push({ role: "assistant", content: response.content });
    messages.push({
      role: "user",
      content: toolUses.map((tu) => ({
        type: "tool_result" as const,
        tool_use_id: tu.id,
        content: "Saved. Continue with the extraction as instructed.",
      })),
    });
  }

  const nameInput = nameUse?.input as { title?: unknown; category?: unknown } | undefined;
  const rawTitle = nameInput?.title;
  const title =
    typeof rawTitle === "string" && rawTitle.trim()
      ? rawTitle.trim().slice(0, MAX_TITLE_LENGTH)
      : null;
  const category = resolveDocumentCategory(nameInput?.category);

  let text = textBlock?.text ?? "(couldn't extract any text from this file)";
  if (response!.stop_reason === "max_tokens") {
    // Surface truncation instead of silently returning a partial extraction — the model itself
    // (and the user, if they ask to see the details) should know some facts may be missing
    // rather than assuming the extraction was complete.
    console.warn("documents: extraction hit max_tokens — output may be truncated");
    text += "\n\n(Note: this extraction was cut off before finishing — some details, possibly including dates, may be missing.)";
  }

  return {
    text,
    title,
    category,
    movement: toolUse ? (toolUse.input as TravelMovement) : null,
    matchKeys: matchKeysUse ? (matchKeysUse.input as MatchKeys) : null,
    purchases,
    bookings,
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

// Deterministic gate between the model's record_purchase/record_booking transcriptions and the
// entities table — the expense/booking counterpart to applyTravelValidation. Pure on purpose
// (no DB, no API) so the whole decision table is unit-testable offline: parse the printed
// amount into minor units in code, run the hardcoded validators, and map ok→active,
// warn→needs_review (finally putting that status to work), reject→dropped entirely.
export function buildDerivedEntities(
  purchases: unknown[],
  bookings: unknown[],
  uploadedAt: Date
): Array<{ type: "expense" | "booking"; data: ExpenseData | BookingData; confidence: number; status: "active" | "needs_review" }> {
  const out: Array<{ type: "expense" | "booking"; data: ExpenseData | BookingData; confidence: number; status: "active" | "needs_review" }> = [];

  for (const raw of purchases) {
    const p = raw as { vendor?: unknown; amount?: unknown; currency?: unknown; date?: unknown };
    const currency = typeof p.currency === "string" ? p.currency.trim().toUpperCase() : "";
    const amountPence = parseAmountToMinorUnits(p.amount, currency);
    const data: ExpenseData = {
      vendor: typeof p.vendor === "string" ? p.vendor.trim() : "",
      amountPence: amountPence ?? -1,
      currency,
      date: typeof p.date === "string" ? p.date.trim() : "",
    };
    const validation = validateExpense(data, { uploadedAt });
    if (validation.severity === "reject") {
      console.warn("documents: dropping extracted purchase — failed validation", validation.issues);
      continue;
    }
    out.push({
      type: "expense",
      data,
      confidence: validation.confidence,
      status: validation.severity === "warn" ? "needs_review" : "active",
    });
  }

  for (const raw of bookings) {
    const b = raw as { kind?: unknown; name?: unknown; reference?: unknown; startDate?: unknown; endDate?: unknown };
    const data: BookingData = {
      kind: b.kind as BookingData["kind"],
      name: typeof b.name === "string" ? b.name.trim() : "",
      reference: typeof b.reference === "string" && b.reference.trim() ? b.reference.trim() : null,
      startDate: typeof b.startDate === "string" ? b.startDate.trim() : "",
      endDate: typeof b.endDate === "string" && b.endDate.trim() ? b.endDate.trim() : null,
    };
    const validation = validateBooking(data, { uploadedAt });
    if (validation.severity === "reject") {
      console.warn("documents: dropping extracted booking — failed validation", validation.issues);
      continue;
    }
    out.push({
      type: "booking",
      data,
      confidence: validation.confidence,
      status: validation.severity === "warn" ? "needs_review" : "active",
    });
  }

  return out;
}

// The storage half: one entity row + one extracted_from link per validated item. Same shape as
// the movementToCheckins/saveCheckin flow below it in the ingest functions.
function storeDerivedEntities(
  ownerId: number,
  documentId: number,
  derived: ReturnType<typeof buildDerivedEntities>
): void {
  for (const item of derived) {
    const entity = saveEntity(ownerId, {
      type: item.type,
      data: item.data,
      confidence: item.confidence,
      status: item.status,
    });
    linkRecords(ownerId, {
      relation: "extracted_from",
      from: { type: "entity", id: entity.id },
      to: { type: "document", id: documentId },
    });
  }
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
    "record_travel_movement with the departure/arrival details.\n\n" +
    "Independently of which category you file it under: if the document shows money paid " +
    "(a total amount charged), call record_purchase; if it shows a flight or hotel " +
    "reservation, call record_booking. A document can warrant both (a hotel confirmation " +
    "shows a reservation AND an amount paid) — call both. Transcribe only what is printed. " +
    "Separately, if the document shows a booking/confirmation/reference code or a flight " +
    "number, also call record_match_keys with it, so it can be cross-referenced against " +
    "email later.";

  const pdfText = mimeType === "application/pdf" ? await extractPdfTextLayer(buffer) : null;

  const base64 = buffer.toString("base64");
  const content: Anthropic.ContentBlockParam[] = pdfText
    ? [
        {
          type: "text",
          text: `Document text (extracted directly from the PDF's text layer and screened for garbling — exact, not a transcription):\n\n${pdfText}\n\n${prompt}`,
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

  return runExtraction(content);
}

// Text-only counterpart to extractDocument — for content that arrives as plain text rather than
// an image/PDF (today: a fetched web page's readable text). Reuses the same continuation loop and
// tool schemas so a saved link ends up in exactly the same shape as a saved photo/PDF, but vision
// is structurally unreachable here: this function never sees a buffer or a media type, only a
// string, so there's no way for it to accidentally spend image tokens.
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
    "Independently of what kind of page it is: if it shows money paid (a total amount " +
    "charged), call record_purchase; if it shows a flight or hotel reservation, call " +
    "record_booking. A page can warrant both — call both. Transcribe only what is printed. " +
    "Separately, if the page shows a booking/confirmation/reference code or a flight number, " +
    "also call record_match_keys with it, so it can be cross-referenced against email later.\n\n" +
    `Source URL: ${sourceUrl}` +
    (truncated ? `\n\n(Page text truncated to the first ${MAX_LINK_TEXT_CHARS} characters.)` : "") +
    `\n\nPage text:\n${bodyText}`;

  return runExtraction([{ type: "text", text: prompt }]);
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

// Shared by every "raw bytes → saved document" path (WhatsApp media, and now email attachments).
// ingestWhatsAppLink (below) has its own near-identical version because its "file" is page text,
// not a buffer — see that function's own comment for why it isn't folded in here too.
async function finalizeIngestedFile(
  ownerId: number,
  buffer: Buffer,
  mimeType: string,
  storedPath: string,
  saveMeta: {
    phone: string;
    filename: string | null;
    caption: string | null;
    source: DocumentSource;
    emailAccountId?: number | null;
    emailMessageId?: string | null;
    emailAttachmentId?: string | null;
  }
): Promise<DocumentRow> {
  const uploadedAt = new Date();
  let doc: DocumentRow;
  let storableMovement: TravelMovement | null;
  let derivedEntities: ReturnType<typeof buildDerivedEntities>;
  let matchKeys: MatchKeys | null;
  try {
    const canAnalyze = SUPPORTED_IMAGE_TYPES.has(mimeType) || mimeType === "application/pdf";
    const {
      text: extractedText,
      title,
      category,
      movement,
      matchKeys: extractedMatchKeys,
      purchases,
      bookings,
    } = canAnalyze
      ? await extractDocument(buffer, mimeType)
      : {
          text: `(file type ${mimeType} isn't supported for automatic analysis — stored for download only)`,
          title: null,
          category: null,
          movement: null,
          matchKeys: null,
          purchases: [] as unknown[],
          bookings: [] as unknown[],
        };

    const validated = applyTravelValidation(extractedText, movement, uploadedAt);
    storableMovement = validated.storableMovement;
    derivedEntities = buildDerivedEntities(purchases, bookings, uploadedAt);
    matchKeys = extractedMatchKeys;

    doc = saveDocument(ownerId, {
      phone: saveMeta.phone,
      filename: saveMeta.filename,
      mimeType,
      storedPath,
      caption: saveMeta.caption,
      title,
      extractedText: validated.finalText,
      category,
      source: saveMeta.source,
      emailAccountId: saveMeta.emailAccountId ?? null,
      emailMessageId: saveMeta.emailMessageId ?? null,
      emailAttachmentId: saveMeta.emailAttachmentId ?? null,
    });
  } catch (err) {
    // Extraction or the DB insert failed after the encrypted file already landed on disk —
    // without this, that file would be orphaned.
    fs.unlinkSync(storedPath);
    throw err;
  }

  if (storableMovement) {
    for (const c of movementToCheckins(storableMovement, doc.id)) {
      saveCheckin(ownerId, {
        country: c.country,
        city: c.city,
        checkedInAt: c.checkedInAt,
        source: "document",
        documentId: c.documentId,
      });
    }
  }
  storeDerivedEntities(ownerId, doc.id, derivedEntities);

  if (doc.category === "receipts" && derivedEntities.some((e) => e.type === "expense" && e.status === "active")) {
    void forwardReceiptToXero(ownerId, doc, buffer).catch((err) =>
      console.error("documents: xero forwarding failed", err)
    );
  }

  if (matchKeys) {
    saveMatchKeys(ownerId, doc.id, matchKeys);
    void checkDocumentAgainstRecentEmails(ownerId, doc.id, doc.title ?? "a saved document", matchKeys).catch(
      (err) => console.error("documents: reconciliation check failed", err)
    );
  }

  return doc;
}

export async function ingestWhatsAppMedia(params: {
  ownerId: number;
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

  return finalizeIngestedFile(params.ownerId, buffer, mimeType, storedPath, {
    phone: params.phone,
    filename: params.filename ?? null,
    caption: params.caption ?? null,
    source: "whatsapp",
  });
}

// New: extraction from an email attachment, reusing the exact same extract→validate→store
// pipeline as a WhatsApp upload. Dedups against a previously-extracted copy of the same
// attachment before paying for a download or an extraction call at all.
export async function ingestEmailAttachment(params: {
  ownerId: number;
  accountId: number;
  messageId: string;
  attachmentId: string;
}): Promise<
  | { ok: true; doc: DocumentRow; alreadyExtracted: boolean }
  | { ok: false; reason: "unavailable" }
> {
  const existing = findDocumentByEmailAttachment(
    params.ownerId,
    params.accountId,
    params.messageId,
    params.attachmentId
  );
  if (existing) {
    return { ok: true, doc: existing, alreadyExtracted: true };
  }

  const fetched = await hubGetAttachment(params.ownerId, params.accountId, params.messageId, params.attachmentId);
  if (!fetched) return { ok: false, reason: "unavailable" };

  const ext = EXTENSIONS[fetched.mimeType] ?? "bin";
  const storedName = `${Date.now()}-${crypto.randomUUID()}.${ext}`;
  const storedPath = path.join(uploadsDir, storedName);
  fs.writeFileSync(storedPath, encryptBuffer(fetched.data));

  const doc = await finalizeIngestedFile(params.ownerId, fetched.data, fetched.mimeType, storedPath, {
    phone: `email:${params.accountId}`,
    filename: fetched.filename,
    caption: null,
    source: "email",
    emailAccountId: params.accountId,
    emailMessageId: params.messageId,
    emailAttachmentId: params.attachmentId,
  });

  return { ok: true, doc, alreadyExtracted: false };
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

  const storedName = `${Date.now()}-${crypto.randomUUID()}.txt`;
  const storedPath = path.join(uploadsDir, storedName);
  fs.writeFileSync(storedPath, encryptBuffer(Buffer.from(fetched.text, "utf8")));

  let doc: DocumentRow;
  let storableMovement: TravelMovement | null;
  let derivedEntities: ReturnType<typeof buildDerivedEntities>;
  let matchKeys: MatchKeys | null;
  try {
    const {
      text: extractedText,
      title,
      category,
      movement,
      matchKeys: extractedMatchKeys,
      purchases,
      bookings,
    } = await extractFactsFromLinkText(fetched.text, fetched.finalUrl, uploadedAt);

    const validated = applyTravelValidation(extractedText, movement, uploadedAt);
    storableMovement = validated.storableMovement;
    derivedEntities = buildDerivedEntities(purchases, bookings, uploadedAt);
    matchKeys = extractedMatchKeys;

    doc = saveDocument(params.ownerId, {
      phone: params.phone,
      filename: null,
      mimeType: "text/plain",
      storedPath,
      caption: fetched.finalUrl,
      title,
      extractedText: validated.finalText,
      category,
    });
  } catch (err) {
    // Same orphaned-file risk as ingestWhatsAppMedia: the encrypted file is already on disk by
    // the time extraction or the DB insert could fail.
    fs.unlinkSync(storedPath);
    throw err;
  }

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
  storeDerivedEntities(params.ownerId, doc.id, derivedEntities);

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
