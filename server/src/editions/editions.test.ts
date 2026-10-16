import { describe, it, expect } from "vitest";
import { findOrCreateUserByEmail, setUserEdition } from "../db/store.js";
import { getEdition, isToolExcluded } from "./index.js";
import { buildToolsForOwner, buildSystemPrompt } from "../ai/assistant.js";

let n = 0;
const user = (edition: "general" | "business") => {
  const u = findOrCreateUserByEmail(`ed-${Date.now()}-${++n}@example.com`);
  setUserEdition(u.id, edition);
  return u.id;
};
const names = (ownerId: number) =>
  buildToolsForOwner(ownerId)
    .map((t) => ("name" in t ? t.name : ""))
    .filter(Boolean);

describe("edition registry", () => {
  it("general users get the general edition and the full tool list", () => {
    const id = user("general");
    expect(getEdition(id).id).toBe("general");
    expect(names(id)).toContain("get_news");
    expect(names(id)).toContain("create_trip");
  });

  it("business users lose travel, news, markets and the old expense tools", () => {
    const id = user("business");
    const tools = names(id);
    for (const t of ["get_news", "get_markets", "create_trip", "link_to_trip", "get_trip_contents", "list_expenses", "undo_expense"]) {
      expect(tools).not.toContain(t);
      expect(isToolExcluded(id, t)).toBe(true);
    }
    expect(tools).toContain("create_calendar_event");
    expect(tools).toContain("set_reminder");
  });

  it("keeps exactly one cache breakpoint, on the last tool, for business users", () => {
    const tools = buildToolsForOwner(user("business"));
    expect((tools[tools.length - 1] as { cache_control?: unknown }).cache_control).toBeDefined();
    expect(tools.filter((t) => (t as { cache_control?: unknown }).cache_control).length).toBe(1);
  });

  it("adds the business section to the system prompt only for business users", () => {
    expect(buildSystemPrompt(user("business"))).toContain("BUSINESS EDITION");
    expect(buildSystemPrompt(user("general"))).not.toContain("BUSINESS EDITION");
  });
});
