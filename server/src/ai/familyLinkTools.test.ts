import { describe, expect, it } from "vitest";
import { buildToolsForOwner, runTool } from "./assistant.js";
import { appendWhatsAppMessage, findOrCreateUserByPhone } from "../db/store.js";
import { createFamily, joinFamilyByCode } from "../joyce/registry.js";
import { openFamilySessionForNewMember, openFamilySessionForPhone } from "../joyce/familyDb.js";
import { listNotes, setMemberName } from "../joyce/store.js";

const FAMILY_TOOLS = ["family_link_status", "link_family", "update_family_link", "unlink_family", "send_to_family", "answer_trip_question"];
const names = (tools: ReturnType<typeof buildToolsForOwner>) =>
  tools.flatMap((t) => ("name" in t ? [t.name] : []));

let counter = 0;
function member(name: string, joinCode?: string) {
  counter += 1;
  const phone = `44793000${String(counter).padStart(4, "0")}`;
  const ownerId = findOrCreateUserByPhone(phone).id;
  appendWhatsAppMessage(ownerId, phone, "user", "hi");
  if (joinCode) {
    joinFamilyByCode(phone, joinCode);
    setMemberName(openFamilySessionForPhone(phone)!, name);
    return { phone, ownerId, joinCode };
  }
  const created = createFamily(phone);
  setMemberName(openFamilySessionForNewMember(created.family, phone), name);
  return { phone, ownerId, joinCode: created.joinCode };
}

describe("which turns get the Joyce link tools", () => {
  it("only a WhatsApp turn from someone who is in a family", () => {
    const a = member("Ana");
    const loner = findOrCreateUserByPhone("447930009999");

    expect(names(buildToolsForOwner(a.ownerId, undefined, a.phone))).toEqual(expect.arrayContaining(FAMILY_TOOLS));
    // The web chat has no phone.
    expect(names(buildToolsForOwner(a.ownerId))).not.toContain("send_to_family");
    // A number in no family.
    expect(names(buildToolsForOwner(loner.id, undefined, "447930009999"))).not.toContain("send_to_family");
  });

  it("no tool takes a family or member argument", () => {
    const a = member("Ana");
    for (const t of buildToolsForOwner(a.ownerId, undefined, a.phone)) {
      if (!("name" in t) || !FAMILY_TOOLS.includes(t.name)) continue;
      const props = Object.keys((t as { input_schema: { properties?: object } }).input_schema.properties ?? {});
      expect(props.filter((p) => /family|member|owner|phone/i.test(p))).toEqual([]);
    }
  });
});

describe("running them", () => {
  it("refuses every one without a phone, or with someone else's phone", async () => {
    const a = member("Ana");
    const b = member("Ben");
    for (const name of FAMILY_TOOLS) {
      expect(await runTool(a.ownerId, name, { title: "x", body: "y", remove_shared: true })).toHaveProperty("error");
      expect(await runTool(a.ownerId, name, { title: "x", body: "y", remove_shared: true }, b.phone)).toHaveProperty(
        "error"
      );
    }
  });

  it("will not send before linking, then sends, then unlinking removes it", async () => {
    const a = member("Ana");
    const b = member("Ben", a.joinCode);

    expect(await runTool(a.ownerId, "send_to_family", { title: "Builder", body: "Dave" }, a.phone)).toHaveProperty("error");

    expect(await runTool(a.ownerId, "link_family", { trips: "auto" }, a.phone)).toMatchObject({
      ok: true,
      trips: "auto",
      availability: true,
    });
    expect(await runTool(a.ownerId, "send_to_family", { title: "Builder", body: "Dave" }, a.phone)).toEqual({ ok: true });
    expect(listNotes(openFamilySessionForPhone(b.phone)!).map((n) => n.title)).toEqual(["Builder"]);

    const status = (await runTool(a.ownerId, "family_link_status", {}, a.phone)) as { linked: boolean; shared: unknown[] };
    expect(status.linked).toBe(true);
    expect(status.shared).toHaveLength(1);

    expect(await runTool(a.ownerId, "unlink_family", { remove_shared: true }, a.phone)).toEqual({ ok: true, removed: 1 });
    expect(listNotes(openFamilySessionForPhone(b.phone)!)).toEqual([]);
  });
});
