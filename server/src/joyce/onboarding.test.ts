import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { composeReply as composeReplyMessages } from "./routes.js";
import { asText } from "./messages.js";
import { openFamilySessionForPhone } from "./familyDb.js";
import { listNotes, recentHistory, saveNote } from "./store.js";
import { findFamilyForPhone } from "./registry.js";

// These tests check wording; joining the messages back into text keeps them about that.
const composeReply = async (...args: Parameters<typeof composeReplyMessages>) =>
  asText(await composeReplyMessages(...args));

const here = path.dirname(fileURLToPath(import.meta.url));

// composeReply only reaches the model once someone is a named member of a family, so every step
// below runs without an API key — which is also why these are the steps worth testing here.

describe("Joyce onboarding", () => {
  it("introduces herself, sets up a family, and takes a name", async () => {
    const phone = "15551110001";

    const intro = await composeReply(phone, "hello?");
    expect(intro).toContain("I'm Joyce");
    expect(intro).toContain("family assistant");
    expect(intro).toContain("start a new family group");
    expect(intro).toContain("join an existing one");
    // Nothing is created just by saying hello.
    expect(findFamilyForPhone(phone)).toBeNull();

    const created = await composeReply(phone, "new");
    expect(created).toMatch(/JOY-[0-9A-Z]{4}-[0-9A-Z]{4}/);
    expect(created).toContain("what should I call you");
    expect(findFamilyForPhone(phone)).not.toBeNull();

    const named = await composeReply(phone, "Ana");
    expect(named).toContain("Ana");
    expect(openFamilySessionForPhone(phone)!.actor.displayName).toBe("Ana");
  });

  it("re-asks rather than guessing when the answer is unclear", async () => {
    const phone = "15551110002";
    await composeReply(phone, "hi");

    const confused = await composeReply(phone, "hmm not sure, maybe the second one?");
    expect(confused).toContain("didn't catch that");
    expect(findFamilyForPhone(phone)).toBeNull();
  });

  it("walks someone through joining with a code, then shares the family's notes", async () => {
    const owner = "15551110010";
    const joiner = "15551110011";

    await composeReply(owner, "hi");
    const created = (await composeReply(owner, "new"))!;
    const code = created.match(/JOY-[0-9A-Z]{4}-[0-9A-Z]{4}/)![0];
    await composeReply(owner, "Bea");

    saveNote(openFamilySessionForPhone(owner)!, "Bin day", "Tuesdays");

    await composeReply(joiner, "hello");
    const asked = await composeReply(joiner, "join");
    expect(asked).toContain("family ID");

    const welcomed = await composeReply(joiner, code);
    expect(welcomed!.toLowerCase()).toContain("what should i call you");
    await composeReply(joiner, "Cal");

    const joined = openFamilySessionForPhone(joiner)!;
    expect(joined.familyId).toBe(openFamilySessionForPhone(owner)!.familyId);
    expect(listNotes(joined).map((n) => n.body)).toEqual(["Tuesdays"]);
  });

  it("accepts a pasted code at the first question, without making them answer it", async () => {
    const owner = "15551110020";
    const joiner = "15551110021";
    await composeReply(owner, "hi");
    const code = (await composeReply(owner, "new"))!.match(/JOY-[0-9A-Z]{4}-[0-9A-Z]{4}/)![0];
    await composeReply(owner, "Dee");

    await composeReply(joiner, "hi");
    await composeReply(joiner, code);
    expect(findFamilyForPhone(joiner)!.familyId).toBe(findFamilyForPhone(owner)!.familyId);
  });

  it("tells someone plainly when a code isn't recognised", async () => {
    const phone = "15551110030";
    await composeReply(phone, "hi");
    await composeReply(phone, "join");
    const rejected = await composeReply(phone, "JOY-0000-0000");
    expect(rejected).toContain("don't recognise");
    expect(findFamilyForPhone(phone)).toBeNull();
  });
});

describe("Joyce is structurally separate from Marlowe", () => {
  // The isolation claim is only true for as long as nothing in src/joyce/ imports Marlowe. This
  // is cheap to check and easy to break by accident: importing ../db/store.js alone would open
  // Marlowe's app.db as a module side effect, putting both products' data in reach of one
  // request. Failing the build is the right response.
  it("imports nothing from Marlowe's modules", () => {
    const offenders: string[] = [];
    for (const file of fs.readdirSync(here).filter((f) => f.endsWith(".ts"))) {
      const source = fs.readFileSync(path.join(here, file), "utf8");
      for (const match of source.matchAll(/from\s+"(\.\.\/[^"]+)"/g)) {
        // providers/whatsapp.js is imported by the tests only, to assert the webhook guard —
        // it holds no tenant data. Everything else outside this directory is off limits.
        if (file.endsWith(".test.ts") && match[1] === "../providers/whatsapp.js") continue;
        offenders.push(`${file} imports ${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps its data under its own directory, away from app.db", () => {
    const dataDir = process.env.DATA_DIR!;
    expect(fs.existsSync(path.join(dataDir, "joyce", "registry.db"))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "joyce", "families"))).toBe(true);
  });
});

describe("how Joyce's onboarding messages are laid out", () => {
  const CODE = /^JOY-[0-9A-Z]{4}-[0-9A-Z]{4}$/;
  // Any pictographic character, which covers every emoji WhatsApp would render as one.
  const EMOJI = /\p{Extended_Pictographic}/u;

  it("introduces herself in four messages, with the choice as buttons on the last", async () => {
    const intro = await composeReplyMessages("15551120001", "hi");
    expect(intro.map((m) => m.text)).toEqual([
      "Hi, I'm Joyce. I'm a family assistant.",
      "I remember important things, help plan, and remind people about what's coming up.",
      "Whatever you tell me, your family members can ask me about. For example, many families " +
        "have me remember wifi passwords for them so they only have to ask me to find it.",
      "Would you like to start a new family group, or join an existing one?",
    ]);
    expect(intro.slice(0, 3).every((m) => !m.buttons)).toBe(true);
    expect(intro[3].buttons?.map((b) => b.title)).toEqual(["Start new", "Join existing"]);
  });

  it("starts a family when the Start new button is tapped", async () => {
    const phone = "15551120002";
    await composeReplyMessages(phone, "hi");
    // A tap reaches composeReply as the button's title.
    await composeReplyMessages(phone, "Start new");
    expect(findFamilyForPhone(phone)).not.toBeNull();
  });

  it("asks for a code when the Join existing button is tapped", async () => {
    const phone = "15551120003";
    await composeReplyMessages(phone, "hi");
    const asked = asText(await composeReplyMessages(phone, "Join existing"));
    expect(asked).toContain("Send me the family ID");
    expect(findFamilyForPhone(phone)).toBeNull();
  });

  it("shows the buttons again when the answer isn't clear", async () => {
    const phone = "15551120004";
    await composeReplyMessages(phone, "hi");
    const again = await composeReplyMessages(phone, "dunno");
    expect(again.at(-1)?.buttons?.map((b) => b.title)).toEqual(["Start new", "Join existing"]);
  });

  it("sends the family ID as a message on its own, so it can be copied", async () => {
    const phone = "15551120005";
    await composeReplyMessages(phone, "hi");
    const created = await composeReplyMessages(phone, "new");
    const codeMessages = created.filter((m) => CODE.test(m.text));
    expect(codeMessages).toHaveLength(1);
    expect(created.at(-1)?.text).toContain("what should I call you");
  });

  it("keeps the welcome, family ID and name exchange in the family's history", async () => {
    const phone = "15551120006";
    await composeReplyMessages(phone, "hi");
    const created = await composeReplyMessages(phone, "new");
    const code = created.find((m) => CODE.test(m.text))!.text;
    await composeReplyMessages(phone, "Fran");

    const history = recentHistory(openFamilySessionForPhone(phone)!);
    expect(history.map((h) => h.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(history[1].body).toContain(code);
    expect(history[2].body).toBe("Fran");
    expect(history[3].body).toContain("Lovely to meet you, Fran");
  });

  it("uses no emoji anywhere in onboarding", async () => {
    const phone = "15551120007";
    const sent = [
      ...(await composeReplyMessages(phone, "hi")),
      ...(await composeReplyMessages(phone, "dunno")),
      ...(await composeReplyMessages(phone, "new")),
      ...(await composeReplyMessages(phone, "Gil")),
    ];
    expect(sent.filter((m) => EMOJI.test(m.text)).map((m) => m.text)).toEqual([]);
  });
});
