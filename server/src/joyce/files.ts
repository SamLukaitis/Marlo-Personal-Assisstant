import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import mammoth from "mammoth";
import type { FamilyData, FamilySession } from "./familyDb.js";
import { decryptBufferFor, encryptBufferFor } from "./familyKey.js";
import { FAMILY_FILES_DIR } from "./registry.js";
import { getDocument, saveDocument } from "./store.js";
import { recordJoyceUsage } from "./adminRecords.js";

// Photos and files family members send Joyce: stored, read, and searchable by the whole family.
//
// The same barriers as the family database apply to the bytes on disk. Each family's files sit in
// their own folder, named by the family id from the session, and each file is encrypted with that
// family's own key. The documents table stores only a bare filename, never a path, and the folder
// is always rebuilt from the session — so a document row can't point at another family's folder,
// and if one somehow did, decrypting it with this family's key would throw rather than leak.
//
// This is Joyce's own lean take on Marlo's services/documents.ts, not an import of it (see the
// boundary test in onboarding.test.ts). Marlo's version also pulls travel dates, receipts and
// bookings out of each file; Joyce just needs the family to be able to find things again.

const MODEL = process.env.JOYCE_MODEL ?? "claude-sonnet-5";

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const PDF = "application/pdf";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  [PDF]: "pdf",
  [DOCX]: "docx",
  "text/plain": "txt",
};

const READ_PROMPT =
  "A family member sent this to their family's shared assistant so everyone can find it later " +
  "(e.g. a school letter, appointment card, passport, insurance document, receipt, recipe or " +
  "manual). Start with one line saying what it is. Then transcribe every important fact exactly " +
  "as shown: names, dates, times, reference numbers, amounts, addresses, phone numbers. Never " +
  "guess at anything not actually visible, and ignore phone screenshot chrome like the status bar.";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

function familyFolder(session: FamilyData): string {
  const dir = path.join(FAMILY_FILES_DIR, session.familyId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Turns a file into searchable text. Word documents and plain text are read directly; photos and
 * PDFs go to the model. Other types (zips, spreadsheets, audio) are kept but not read.
 */
async function readFile(buffer: Buffer, mimeType: string): Promise<string> {
  if (mimeType === "text/plain") return buffer.toString("utf8");

  if (mimeType === DOCX) {
    const { value } = await mammoth.extractRawText({ buffer });
    return value.trim() || "(this Word document has no text in it)";
  }

  const isImage = IMAGE_TYPES.has(mimeType);
  if (!isImage && mimeType !== PDF) {
    return `(a ${mimeType} file — kept for the family, but I can't read this type of file)`;
  }

  const data = buffer.toString("base64");
  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: [
          isImage
            ? { type: "image", source: { type: "base64", media_type: mimeType as "image/jpeg", data } }
            : { type: "document", source: { type: "base64", media_type: PDF, data } },
          { type: "text", text: READ_PROMPT },
        ],
      },
    ],
  });
  recordJoyceUsage(MODEL, "joyce_file_reading", response.usage);
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  return text || "(couldn't make out anything in this file)";
}

export interface SavedFile {
  documentId: number;
  extractedText: string;
}

/**
 * Encrypts the file to disk, reads it, and records it in the family's documents. A file that
 * can't be read is still kept: the family sent it to be kept, and they can still ask for it back.
 */
export async function saveFamilyFile(
  session: FamilySession,
  file: { buffer: Buffer; mimeType: string; filename?: string; caption?: string }
): Promise<SavedFile> {
  const storedName = `${crypto.randomUUID()}.${EXTENSIONS[file.mimeType] ?? "bin"}`;
  const storedPath = path.join(familyFolder(session), storedName);
  fs.writeFileSync(storedPath, encryptBufferFor(session.key, file.buffer));

  let extractedText: string;
  try {
    extractedText = await readFile(file.buffer, file.mimeType);
  } catch (err) {
    console.error("joyce: reading a saved file failed", err);
    extractedText = "(couldn't read this file automatically — it's saved, but not searchable)";
  }

  try {
    const documentId = saveDocument(session, {
      filename: file.filename,
      caption: file.caption || undefined,
      mimeType: file.mimeType,
      storedName,
      extractedText,
    });
    return { documentId, extractedText };
  } catch (err) {
    // Without the row nothing could ever find this file again.
    fs.unlinkSync(storedPath);
    throw err;
  }
}

/**
 * The original bytes of one of this family's saved files, or null if there's no such document or
 * its file is gone. `documentId` is only ever looked up inside the session's own database.
 */
export function loadFamilyFile(
  session: FamilySession,
  documentId: number
): { buffer: Buffer; mimeType: string; filename: string } | null {
  const doc = getDocument(session, documentId);
  if (!doc) return null;
  // basename: the folder always comes from the session, never from what's stored in the row.
  const onDisk = path.join(familyFolder(session), path.basename(doc.storedName));
  if (!fs.existsSync(onDisk)) return null;
  return {
    buffer: decryptBufferFor(session.key, fs.readFileSync(onDisk)),
    mimeType: doc.mimeType,
    filename: doc.filename ?? `family-file-${doc.id}.${EXTENSIONS[doc.mimeType] ?? "bin"}`,
  };
}

/**
 * Removes a document's encrypted file from disk. The row itself is removed by the caller
 * (provenance.ts). A file already gone is not an error — the goal is that it doesn't exist.
 */
export function deleteFamilyFileFromDisk(family: FamilyData, storedName: string): void {
  const onDisk = path.join(familyFolder(family), path.basename(storedName));
  fs.rmSync(onDisk, { force: true });
}
