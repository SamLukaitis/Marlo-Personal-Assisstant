import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/outbound.js", () => ({ sendProactiveMessage: vi.fn(async () => {}) }));

import {
  familyLinkState,
  linkToFamily,
  listShared,
  offerLink,
  registerBridge,
  sendToFamily,
  unlinkFromFamily,
  updateLinkSettings,
} from "./index.js";
import { sendProactiveMessage } from "../services/outbound.js";
import { appendWhatsAppMessage, findOrCreateUserByPhone, getFamilyLink } from "../db/store.js";
import { createFamily, joinFamilyByCode } from "../joyce/registry.js";
import { openFamilySessionForNewMember, openFamilySessionForPhone } from "../joyce/familyDb.js";
import { handleOnboarding } from "../joyce/onboarding.js";
import { handlePendingLeave } from "../joyce/leaving.js";
import { requestLeave } from "../joyce/registry.js";
import { setFamilyHooks } from "../joyce/hooks.js";
import { listNotes, searchNotes, saveNote, setMemberName } from "../joyce/store.js";

const send = vi.mocked(sendProactiveMessage);
let counter = 0;
function freshPhone(): string {
  counter += 1;
  return `44792000${String(counter).padStart(4, "0")}`;
}

// A person with a Marlowe account (who has messaged it) and a Joyce family.
function person(name: string, opts: { joinCode?: string; messaged?: boolean } = {}) {
  const phone = freshPhone();
  const ownerId = findOrCreateUserByPhone(phone).id;
  if (opts.messaged !== false) appendWhatsAppMessage(ownerId, phone, "user", "hi");
  let joinCode = opts.joinCode;
  if (joinCode) {
    expect(joinFamilyByCode(phone, joinCode).ok).toBe(true);
    setMemberName(openFamilySessionForPhone(phone)!, name);
  } else {
    const created = createFamily(phone);
    joinCode = created.joinCode;
    setMemberName(openFamilySessionForNewMember(created.family, phone), name);
  }
  return { phone, ownerId, joinCode };
}

beforeEach(() => send.mockClear());
afterEach(() => setFamilyHooks({}));

describe("linking", () => {
  it("refuses a phone that is in no family", () => {
    const phone = freshPhone();
    const ownerId = findOrCreateUserByPhone(phone).id;
    expect(familyLinkState(ownerId, phone)).toEqual({ inFamily: false, linked: false });
    expect(linkToFamily(ownerId, phone)).toEqual({ ok: false, reason: "not_in_family" });
    expect(getFamilyLink(ownerId, phone)).toBeNull();
  });

  it("links with defaults, and a second link call only changes settings", () => {
    const a = person("Ana");
    const first = linkToFamily(a.ownerId, a.phone);
    expect(first.ok && first.link).toMatchObject({ tripsMode: "ask", availabilityOn: true });
    const again = linkToFamily(a.ownerId, a.phone, { tripsMode: "off" });
    expect(again.ok && again.link).toMatchObject({ tripsMode: "off", availabilityOn: true });
    expect(familyLinkState(a.ownerId, a.phone)).toMatchObject({ inFamily: true, linked: true, tripsMode: "off" });
  });

  it("only updates settings for someone who has linked", () => {
    const a = person("Ana");
    expect(updateLinkSettings(a.ownerId, a.phone, { availabilityOn: false })).toEqual({
      ok: false,
      reason: "not_linked",
    });
    linkToFamily(a.ownerId, a.phone);
    const r = updateLinkSettings(a.ownerId, a.phone, { availabilityOn: false });
    expect(r.ok && r.link.availabilityOn).toBe(false);
  });
});

describe("sending to the family", () => {
  it("refuses until the person has linked", () => {
    const a = person("Ana");
    expect(sendToFamily(a.ownerId, a.phone, "Builder", "01632 960000")).toEqual({ ok: false, reason: "not_linked" });
    expect(listNotes(openFamilySessionForPhone(a.phone)!)).toEqual([]);
  });

  it("puts a note in the family that another member can find, and logs the title only", () => {
    const a = person("Ana");
    const b = person("Ben", { joinCode: a.joinCode });
    linkToFamily(a.ownerId, a.phone);

    const sent = sendToFamily(a.ownerId, a.phone, "Builder", "Dave 01632 960000");
    expect(sent.ok).toBe(true);

    const found = searchNotes(openFamilySessionForPhone(b.phone)!, "builder");
    expect(found.map((n) => [n.title, n.body, n.savedByName])).toEqual([["Builder", "Dave 01632 960000", "Ana"]]);

    const log = listShared(a.ownerId, a.phone);
    expect(log.map((s) => s.label)).toEqual(["Builder"]);
    expect(JSON.stringify(log)).not.toContain("01632");
  });

  it("rejects an empty title or body", () => {
    const a = person("Ana");
    linkToFamily(a.ownerId, a.phone);
    expect(sendToFamily(a.ownerId, a.phone, "  ", "x")).toEqual({ ok: false, reason: "empty" });
    expect(sendToFamily(a.ownerId, a.phone, "x", "")).toEqual({ ok: false, reason: "empty" });
  });

  it("does not put anything in another family", () => {
    const a = person("Ana");
    const other = person("Zed");
    linkToFamily(a.ownerId, a.phone);
    sendToFamily(a.ownerId, a.phone, "Builder", "Dave");
    expect(listNotes(openFamilySessionForPhone(other.phone)!)).toEqual([]);
  });
});

describe("unlinking", () => {
  it("with removal, deletes only this person's handed-over notes", () => {
    const a = person("Ana");
    const b = person("Ben", { joinCode: a.joinCode });
    linkToFamily(a.ownerId, a.phone);
    linkToFamily(b.ownerId, b.phone);
    sendToFamily(a.ownerId, a.phone, "Builder", "Dave");
    sendToFamily(b.ownerId, b.phone, "Plumber", "Pat");
    saveNote(openFamilySessionForPhone(a.phone)!, "Wifi", "mango");

    expect(unlinkFromFamily(a.ownerId, a.phone, true)).toEqual({ removed: 1 });

    const titles = listNotes(openFamilySessionForPhone(b.phone)!).map((n) => n.title).sort();
    expect(titles).toEqual(["Plumber", "Wifi"]);
    expect(familyLinkState(a.ownerId, a.phone).linked).toBe(false);
    expect(familyLinkState(b.ownerId, b.phone).linked).toBe(true);
    expect(sendToFamily(a.ownerId, a.phone, "Again", "x")).toEqual({ ok: false, reason: "not_linked" });
  });

  it("without removal, leaves what was shared", () => {
    const a = person("Ana");
    linkToFamily(a.ownerId, a.phone);
    sendToFamily(a.ownerId, a.phone, "Builder", "Dave");
    expect(unlinkFromFamily(a.ownerId, a.phone, false)).toEqual({ removed: 0 });
    expect(listNotes(openFamilySessionForPhone(a.phone)!).map((n) => n.title)).toEqual(["Builder"]);
  });
});

describe("the offer", () => {
  it("is sent once to a Marlowe user who has messaged Marlowe", async () => {
    const a = person("Ana");
    await offerLink(a.phone);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe(a.phone);
    expect(send.mock.calls[0][1]).toMatch(/Nothing is shared unless you say yes/);
  });

  it("is not sent without a Marlowe account, without an inbound message, or once linked", async () => {
    await offerLink(freshPhone());
    const silent = person("Cy", { messaged: false });
    await offerLink(silent.phone);
    const linked = person("Di");
    linkToFamily(linked.ownerId, linked.phone);
    await offerLink(linked.phone);
    expect(send).not.toHaveBeenCalled();
  });

  it("goes out when someone starts a family on Joyce, and never breaks onboarding", async () => {
    registerBridge();
    const phone = freshPhone();
    const ownerId = findOrCreateUserByPhone(phone).id;
    appendWhatsAppMessage(ownerId, phone, "user", "hi");
    handleOnboarding(phone, "hi");
    handleOnboarding(phone, "new");
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  });

  it("does nothing, quietly, for a Joyce member with no Marlowe account", async () => {
    registerBridge();
    const phone = freshPhone();
    handleOnboarding(phone, "hi");
    expect(() => handleOnboarding(phone, "new")).not.toThrow();
    await new Promise((r) => setTimeout(r, 20));
    expect(send).not.toHaveBeenCalled();
  });
});

describe("leaving the family", () => {
  it("unlinks at once, so nothing more can be sent", () => {
    registerBridge();
    const a = person("Ana");
    person("Ben", { joinCode: a.joinCode });
    linkToFamily(a.ownerId, a.phone);
    requestLeave(a.phone);
    handlePendingLeave(a.phone, "confirm cancel");
    expect(getFamilyLink(a.ownerId, a.phone)).toBeNull();
    expect(sendToFamily(a.ownerId, a.phone, "x", "y")).toEqual({ ok: false, reason: "not_in_family" });
  });
});

describe("what may import across the products", () => {
  it("is only the bridge", () => {
    const src = path.resolve(__dirname, "..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules") walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
        const rel = path.relative(src, full).replace(/\\/g, "/");
        // Joyce's own command-line scripts (templates, message deletion) belong to Joyce.
        if (rel.startsWith("joyce/") || rel.startsWith("bridge/") || rel.startsWith("scripts/")) continue;
        const source = fs.readFileSync(full, "utf8");
        for (const m of source.matchAll(/from\s+"(\.\.?\/(?:\.\.\/)*joyce\/[^"]+)"/g)) {
          // Wiring that predates the bridge: mounting Joyce's routes, her reminder sender and the portal.
          if (["index.ts", "routes/joycePortalRoutes.ts", "providers/whatsapp.ts"].includes(rel)) continue;
          offenders.push(`${rel} imports ${m[1]}`);
        }
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });
});
