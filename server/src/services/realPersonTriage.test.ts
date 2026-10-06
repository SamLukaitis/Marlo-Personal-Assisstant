import { describe, it, expect } from "vitest";
import { buildTriagePrompt, parseTriageSkips, parseTriageGists } from "./realPersonTriage.js";

describe("buildTriagePrompt", () => {
  it("lists each email and the recently sent alerts", () => {
    const prompt = buildTriagePrompt(
      [{ index: 0, from: "cusco <cusco@hostel.example>", subject: "Your reservation", snippet: "It&#39;s booked" }],
      ["✅ Sam, Your reservation at *Wild Rover Cusco* is confirmed."]
    );
    expect(prompt).toContain("[0] From: cusco <cusco@hostel.example>");
    expect(prompt).toContain("It's booked");
    expect(prompt).toContain("Wild Rover Cusco");
    expect(prompt).toContain("already-sent alerts");
  });

  it("omits the earlier-alerts section when there are none", () => {
    const prompt = buildTriagePrompt([{ index: 0, from: "a@b.c", subject: "s", snippet: "x" }], []);
    expect(prompt).not.toContain("Alerts the user was already sent");
  });
});

describe("parseTriageSkips", () => {
  it("keeps well-formed entries and drops malformed ones", () => {
    const skips = parseTriageSkips([
      { index: 0, reason: "not_personal" },
      { index: 2, reason: "duplicate" },
      { index: 3, reason: "whatever" },
      { reason: "duplicate" },
      null,
    ]);
    expect([...skips]).toEqual([
      [0, "not_personal"],
      [2, "duplicate"],
    ]);
  });

  it("treats a non-array as no skips", () => {
    expect(parseTriageSkips(undefined).size).toBe(0);
  });
});

describe("parseTriageGists", () => {
  it("keeps well-formed gists and drops the rest", () => {
    const gists = parseTriageGists([
      { index: 0, gist: "wants to move Thursday's call to Friday", needs_reply: true },
      { index: 1, gist: "" },
      { index: "2", gist: "x" },
      { index: 3, gist: "sent the signed contract" },
    ]);
    expect(gists.get(0)).toEqual({ gist: "wants to move Thursday's call to Friday", needsReply: true });
    expect(gists.has(1)).toBe(false);
    expect(gists.has(2)).toBe(false);
    expect(gists.get(3)).toEqual({ gist: "sent the signed contract", needsReply: false });
  });

  it("asks for a gist of what the sender wants", () => {
    expect(buildTriagePrompt([{ index: 0, from: "a", subject: "b", snippet: "c" }], [])).toMatch(/gist/);
  });
});
