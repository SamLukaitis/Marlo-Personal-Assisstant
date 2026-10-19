import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "./assistant.js";
import { findOrCreateUserByEmail, upsertAccount, markAccountAuthBroken } from "../db/store.js";

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

function connect(ownerId: number, provider: "google" | "microsoft", email: string) {
  return upsertAccount(ownerId, { provider, email, accessToken: "t", refreshToken: "r", expiryDate: null });
}

describe("buildSystemPrompt with a broken connection", () => {
  it("marks the broken account, and only that one, as needing reconnecting", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("prompt-broken"));
    const broken = connect(user.id, "google", uniqueEmail("dead-gmail"));
    const healthy = connect(user.id, "microsoft", uniqueEmail("fine-outlook"));
    markAccountAuthBroken(user.id, broken.id);

    const prompt = buildSystemPrompt(user.id);

    const brokenLine = prompt.split("\n").find((l) => l.includes(broken.email))!;
    const healthyLine = prompt.split("\n").find((l) => l.includes(healthy.email))!;
    expect(brokenLine).toContain("connection expired, needs reconnecting");
    expect(healthyLine).not.toContain("connection expired");
  });

  it("tells the model not to report an empty result as 'nothing found', and to offer a reconnect link", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("prompt-broken-rule"));
    const broken = connect(user.id, "google", uniqueEmail("dead-gmail"));
    markAccountAuthBroken(user.id, broken.id);

    const prompt = buildSystemPrompt(user.id);

    expect(prompt).toMatch(/connection expired.*never say nothing was found/i);
    expect(prompt).toMatch(/connect_email/);
  });

  it("adds no broken-connection rule when every account is healthy", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("prompt-healthy"));
    connect(user.id, "google", uniqueEmail("fine-gmail"));

    expect(buildSystemPrompt(user.id)).not.toMatch(/connection expired/i);
  });
});
