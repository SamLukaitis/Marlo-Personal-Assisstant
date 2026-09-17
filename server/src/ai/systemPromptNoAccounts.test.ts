import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "./assistant.js";
import { findOrCreateUserByPhone } from "../db/store.js";

let counter = 0;
function freshPhone(): string {
  counter += 1;
  return `44791000${String(counter).padStart(4, "0")}`;
}

describe("buildSystemPrompt with no connected accounts", () => {
  it("tells the model to offer connecting an inbox in chat, not to point at the website", () => {
    const user = findOrCreateUserByPhone(freshPhone());

    const prompt = buildSystemPrompt(user.id);

    expect(prompt).toContain("none connected");
    // The old copy sent WhatsApp-only users to a "Setup page" they have no way to reach.
    expect(prompt).not.toContain("Setup page");
    expect(prompt.toLowerCase()).toContain("offer to connect");
  });
});
