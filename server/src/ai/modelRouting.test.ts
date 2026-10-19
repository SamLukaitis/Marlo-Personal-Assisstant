import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  MODEL_FAST,
  MODEL_STRONG,
  routeModel,
  recordReplyModel,
  startSticky,
  looksLikePushback,
  isFastFirstEnabled,
  supportsDynamicWebSearch,
  __resetRoutingStateForTests,
} from "./modelRouting.js";
import { findOrCreateUserByEmail, setUserAdmin } from "../db/store.js";

let counter = 0;
function newUser(prefix: string): number {
  counter += 1;
  return findOrCreateUserByEmail(`${prefix}-${Date.now()}-${counter}@example.com`).id;
}

const savedMode = process.env.ASSISTANT_FAST_FIRST;
beforeEach(() => {
  __resetRoutingStateForTests();
  process.env.ASSISTANT_FAST_FIRST = "all";
});
afterEach(() => {
  if (savedMode === undefined) delete process.env.ASSISTANT_FAST_FIRST;
  else process.env.ASSISTANT_FAST_FIRST = savedMode;
});

describe("fast-first switch", () => {
  it("defaults to admins only", () => {
    delete process.env.ASSISTANT_FAST_FIRST;
    const admin = newUser("route-admin");
    setUserAdmin(admin, true);
    expect(isFastFirstEnabled(admin)).toBe(true);
    expect(isFastFirstEnabled(newUser("route-plain"))).toBe(false);
  });

  it("'off' keeps legacy keyword routing even for admins", () => {
    process.env.ASSISTANT_FAST_FIRST = "off";
    const admin = newUser("route-off");
    setUserAdmin(admin, true);
    expect(routeModel(admin, "what live music is on in leeds").reason).toBe("legacy");
  });
});

describe("routeModel", () => {
  it("sends ordinary messages to the fast model", () => {
    expect(routeModel(newUser("r1"), "what live music events happen in leeds on a saturday")).toEqual({
      model: MODEL_FAST,
      reason: "fast",
    });
  });

  it("sends obvious heavy tasks straight to the strong model", () => {
    expect(routeModel(newUser("r2"), "draft a reply to my landlord")).toEqual({ model: MODEL_STRONG, reason: "heavy-task" });
  });

  it("steps up when the user pushes back on a fast-model reply, then stays up", () => {
    const id = newUser("r3");
    recordReplyModel(id, MODEL_FAST);
    expect(routeModel(id, "that's wrong")).toEqual({ model: MODEL_STRONG, reason: "pushback" });
    recordReplyModel(id, MODEL_STRONG);
    expect(routeModel(id, "ok and on sunday?").reason).toBe("sticky");
  });

  it("doesn't treat pushback after a strong-model reply as a reason to switch", () => {
    const id = newUser("r4");
    recordReplyModel(id, MODEL_STRONG);
    expect(routeModel(id, "that's wrong").model).toBe(MODEL_FAST);
  });

  it("stays on the strong model for 4 messages after an escalation, then goes back", () => {
    const id = newUser("r5");
    startSticky(id);
    for (let i = 0; i < 4; i++) expect(routeModel(id, "and then?").reason).toBe("sticky");
    expect(routeModel(id, "and then?").reason).toBe("fast");
  });

  it("ends the sticky window after 30 minutes", () => {
    const id = newUser("r6");
    const now = Date.now();
    startSticky(id, now);
    expect(routeModel(id, "hi", now + 31 * 60 * 1000).reason).toBe("fast");
  });
});

describe("looksLikePushback", () => {
  it.each(["no", "No.", "no, I meant the other one", "that's wrong", "not what I asked", "try again", "??", "you didn't answer the question", "I already said Tuesday", "more detail please"])(
    "counts %j",
    (m) => expect(looksLikePushback(m)).toBe(true)
  );
  it.each(["no thanks", "no, that's fine", "no worries", "no problem", "thanks!", "what about sunday", "know any good pubs?"])(
    "doesn't count %j",
    (m) => expect(looksLikePushback(m)).toBe(false)
  );
});

describe("supportsDynamicWebSearch", () => {
  it("is Sonnet/Opus only", () => {
    expect(supportsDynamicWebSearch("claude-sonnet-5")).toBe(true);
    expect(supportsDynamicWebSearch("claude-sonnet-5-5")).toBe(true);
    expect(supportsDynamicWebSearch("claude-haiku-5-5")).toBe(false);
  });
});
