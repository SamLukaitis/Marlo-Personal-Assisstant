import { describe, expect, it } from "vitest";
import { scenes } from "./script";

describe("the conversation script", () => {
  it("tells email first, then documents, then trips", () => {
    expect(scenes.map((s) => s.id)).toEqual(["email", "documents", "trips"]);
  });

  it("alternates between you and Marlo, starting with you, in every scene", () => {
    for (const scene of scenes) {
      scene.messages.forEach((m, i) => {
        expect(m.from, `${scene.id} message ${i}`).toBe(i % 2 === 0 ? "you" : "marlo");
      });
    }
  });

  it("keeps Marlo concise, calm and professional", () => {
    for (const m of scenes.flatMap((s) => s.messages).filter((m) => m.from === "marlo")) {
      expect(m.text.length, m.text).toBeLessThanOrEqual(220);
      expect(m.text, m.text).not.toContain("!");
      expect(m.text, m.text).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });

  it("gives every message a clock time", () => {
    for (const m of scenes.flatMap((s) => s.messages)) {
      expect(m.time).toMatch(/^\d{1,2}:\d{2}$/);
    }
  });

  it("has a few messages in every scene", () => {
    for (const scene of scenes) {
      expect(scene.messages.length, scene.id).toBeGreaterThanOrEqual(4);
      expect(scene.messages.length, scene.id).toBeLessThanOrEqual(6);
    }
  });
});
