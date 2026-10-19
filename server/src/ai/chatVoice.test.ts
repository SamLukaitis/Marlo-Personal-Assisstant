import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "./assistant.js";
import { CHAT_VOICE } from "./chatVoice.js";
import { findOrCreateUserByEmail, setSetting } from "../db/store.js";

let counter = 0;
function newUser() {
  counter += 1;
  return findOrCreateUserByEmail(`chat-voice-${Date.now()}-${counter}@example.com`);
}

describe("chat voice in the system prompt", () => {
  it("is sent with every chat message", () => {
    expect(buildSystemPrompt(newUser().id)).toContain(CHAT_VOICE);
  });

  it("still carries the user's own description of how to behave, which it defers to", () => {
    const user = newUser();
    setSetting(user.id, "persona", "Be chatty and use emoji.");
    const prompt = buildSystemPrompt(user.id);
    expect(prompt).toContain("Be chatty and use emoji.");
    expect(CHAT_VOICE).toContain("follow that over these defaults");
  });
});
