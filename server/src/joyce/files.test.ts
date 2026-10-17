import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createFamily, requestLeave, FAMILY_FILES_DIR } from "./registry.js";
import { openFamilySessionForNewMember, openFamilySessionForPhone } from "./familyDb.js";
import { decryptBufferFor } from "./familyKey.js";
import { listDocuments, searchDocuments, setMemberName } from "./store.js";
import { loadFamilyFile, saveFamilyFile } from "./files.js";
import { composeMediaReply as composeMediaReplyMessages } from "./routes.js";
import { asText } from "./messages.js";
import { extractJoyceMessages } from "./whatsapp.js";
import { NOT_CONFIRMED_MESSAGE } from "./leaving.js";

// These tests check wording; joining the messages back into text keeps them about that.
const composeMediaReply = async (...args: Parameters<typeof composeMediaReplyMessages>) =>
  asText(await composeMediaReplyMessages(...args));

// Plain-text files are read without the model, so everything here runs with no API key. The
// photo/PDF path differs only in where the text comes from.

function familyOf(phone: string, name: string | null) {
  const { family } = createFamily(phone);
  const s = openFamilySessionForNewMember(family, phone);
  if (name) setMemberName(s, name);
  return openFamilySessionForPhone(phone)!;
}

const textFile = (body: string) => ({
  buffer: Buffer.from(body, "utf8"),
  mimeType: "text/plain",
  filename: "notes.txt",
});

describe("saving a family's files", () => {
  it("stores the file encrypted, makes it searchable, and gives back the original", async () => {
    const session = familyOf("15552220001", "Ana");
    const saved = await saveFamilyFile(session, {
      ...textFile("Dentist on 14 Oct at 3pm, ref D-8812"),
      caption: "for the dentist",
    });

    const folder = path.join(FAMILY_FILES_DIR, session.familyId);
    const [onDisk] = fs.readdirSync(folder);
    expect(fs.readFileSync(path.join(folder, onDisk)).toString("utf8")).not.toContain("D-8812");

    const hit = searchDocuments(session, "d-8812");
    expect(hit.map((d) => d.id)).toEqual([saved.documentId]);
    expect(hit[0].sentByName).toBe("Ana");
    expect(hit[0].caption).toBe("for the dentist");

    const back = loadFamilyFile(session, saved.documentId)!;
    expect(back.buffer.toString("utf8")).toBe("Dentist on 14 Oct at 3pm, ref D-8812");
    expect(back.filename).toBe("notes.txt");
  });

  it("finds a file from a question in different words than the file itself", async () => {
    const session = familyOf("15552220008", "Fin");
    await saveFamilyFile(session, textFile("Bin collection: recycling every other Tuesday"));
    const trip = await saveFamilyFile(session, {
      ...textFile("Year 4 trip. Cost £12.50, pay by 9 October."),
      caption: "school trip letter for Leo",
    });
    // No document contains this phrase, but the trip letter has the most of its words.
    expect(searchDocuments(session, "when to pay for Leo's trip")[0].id).toBe(trip.documentId);
    expect(searchDocuments(session, "passport")).toEqual([]);
  });

  it("keeps a file it can't read, rather than dropping it", async () => {
    const session = familyOf("15552220002", "Ben");
    const saved = await saveFamilyFile(session, {
      buffer: Buffer.from([1, 2, 3]),
      mimeType: "application/zip",
    });
    expect(saved.extractedText).toContain("can't read this type of file");
    expect(loadFamilyFile(session, saved.documentId)!.buffer).toEqual(Buffer.from([1, 2, 3]));
  });
});

describe("one family's files are out of another's reach", () => {
  it("keeps each family's files in its own folder, under its own key", async () => {
    const a = familyOf("15552220003", "Cara");
    const b = familyOf("15552220004", "Dev");
    const saved = await saveFamilyFile(a, textFile("passport number 123456789"));

    // Same document id, other family: their database has no such row.
    expect(loadFamilyFile(b, saved.documentId)).toBeNull();
    expect(listDocuments(b)).toEqual([]);

    // And the bytes on disk can't be opened with the other family's key — it throws, not leaks.
    const folder = path.join(FAMILY_FILES_DIR, a.familyId);
    const [onDisk] = fs.readdirSync(folder);
    const bytes = fs.readFileSync(path.join(folder, onDisk));
    expect(() => decryptBufferFor(b.key, bytes)).toThrow();
    expect(decryptBufferFor(a.key, bytes).toString("utf8")).toBe("passport number 123456789");
  });
});

describe("photos and files arriving on WhatsApp", () => {
  it("reads photos and documents out of the webhook, caption and all", () => {
    const messages = extractJoyceMessages({
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: "joyce" },
                messages: [
                  {
                    from: "1",
                    id: "w1",
                    type: "image",
                    image: { id: "m1", mime_type: "image/jpeg", caption: "school photo day" },
                  },
                  {
                    from: "1",
                    id: "w2",
                    type: "document",
                    document: { id: "m2", mime_type: "application/pdf", filename: "letter.pdf" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(messages).toEqual([
      {
        from: "1",
        messageId: "w1",
        text: "school photo day",
        media: { mediaId: "m1", mimeType: "image/jpeg" },
        toPhoneNumberId: "joyce",
      },
      {
        from: "1",
        messageId: "w2",
        text: "",
        media: { mediaId: "m2", mimeType: "application/pdf", filename: "letter.pdf" },
        toPhoneNumberId: "joyce",
      },
    ]);
  });

  it("doesn't download anything from someone who isn't in a family", async () => {
    let downloaded = false;
    const reply = await composeMediaReply("15552220005", {
      caption: "",
      mimeType: "image/jpeg",
      download: async () => {
        downloaded = true;
        return Buffer.from("x");
      },
    });
    expect(downloaded).toBe(false);
    expect(reply).toContain("once you're in a family group");
    expect(reply).toContain("I'm Joyce");
  });

  it("saves the file and still asks the name of someone who hasn't given one", async () => {
    const session = familyOf("15552220006", null);
    const reply = await composeMediaReply("15552220006", {
      caption: "",
      mimeType: "text/plain",
      download: async () => Buffer.from("bin day is Tuesday"),
    });
    expect(reply).toContain("what should I call you");
    expect(searchDocuments(session, "bin day")).toHaveLength(1);
  });

  it("spends a pending leave request without keeping the file", async () => {
    const session = familyOf("15552220007", "Eve");
    requestLeave("15552220007");
    const reply = await composeMediaReply("15552220007", {
      caption: "",
      mimeType: "text/plain",
      download: async () => Buffer.from("anything"),
    });
    expect(reply).toContain(NOT_CONFIRMED_MESSAGE);
    expect(listDocuments(session)).toEqual([]);
    // Still in the family — no caption can't be a confirmation.
    expect(openFamilySessionForPhone("15552220007")).not.toBeNull();
  });
});

describe("sending a file back", () => {
  it("has no way to choose who receives it", () => {
    const source = fs.readFileSync(new URL("./assistant.ts", import.meta.url), "utf8");
    const tool = source.slice(source.indexOf('name: "send_document"'));
    const schema = tool.slice(0, tool.indexOf("},\n  },"));
    // The only input is which document; the recipient is always the phone the turn came from.
    expect(schema).toContain("properties: { document_id: { type: \"integer\" } }");
    expect(source).toContain("sendJoyceMedia(ctx.normalizedPhone,");
  });
});
