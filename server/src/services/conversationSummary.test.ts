import { describe, it, expect } from "vitest";
import {
  buildSummaryPrompt,
  maybeUpdateConversationSummary,
  SUMMARY_BATCH_THRESHOLD,
  RAW_HISTORY_WINDOW,
} from "./conversationSummary.js";
import { appendWhatsAppMessage, findOrCreateUserByEmail, getConversationSummary, type WhatsAppMessageRow } from "../db/store.js";

function msg(id: number, role: "user" | "assistant", content: string): WhatsAppMessageRow {
  return { id, phone: "447000000001", role, content, createdAt: Date.now() };
}

describe("buildSummaryPrompt", () => {
  it("includes the previous summary when one exists", () => {
    const prompt = buildSummaryPrompt("The user asked about their Lisbon trip.", [msg(1, "user", "hi")]);
    expect(prompt).toContain("The user asked about their Lisbon trip.");
  });

  it("says this is the start of the conversation when there is no previous summary", () => {
    const prompt = buildSummaryPrompt(null, [msg(1, "user", "hi")]);
    expect(prompt).toContain("start of the conversation");
  });

  it("renders each message with its role and content, in order", () => {
    const prompt = buildSummaryPrompt(null, [
      msg(1, "user", "my flight got delayed"),
      msg(2, "assistant", "sorry to hear that, what's the new time?"),
    ]);
    const userIdx = prompt.indexOf("my flight got delayed");
    const assistantIdx = prompt.indexOf("sorry to hear that");
    expect(userIdx).toBeGreaterThan(-1);
    expect(assistantIdx).toBeGreaterThan(userIdx);
  });
});

describe("thresholds", () => {
  it("exports a positive batch threshold and raw window size", () => {
    expect(SUMMARY_BATCH_THRESHOLD).toBeGreaterThan(0);
    expect(RAW_HISTORY_WINDOW).toBeGreaterThan(0);
  });
});

// maybeUpdateConversationSummary's LLM-calling path isn't unit-tested — this repo has no
// precedent for mocking the Anthropic SDK (see importantEmailClassifier.ts). The below-threshold
// no-op path needs no LLM call at all, so it's covered directly against the real store.
describe("maybeUpdateConversationSummary — below threshold", () => {
  it("does nothing when the backlog hasn't reached the batch threshold yet", async () => {
    const user = findOrCreateUserByEmail(`summary-below-threshold-${Date.now()}@example.com`);
    const phone = `447000${Date.now()}`;
    // Well under both RAW_HISTORY_WINDOW and SUMMARY_BATCH_THRESHOLD, so the backlog is empty.
    appendWhatsAppMessage(user.id, phone, "user", "hi");
    appendWhatsAppMessage(user.id, phone, "assistant", "hello");

    await maybeUpdateConversationSummary(phone);

    expect(getConversationSummary(phone)).toBeNull();
  });
});

// The summary is read back on every later message. Undated, it stated week-old plans as current.
describe("buildSummaryPrompt — staleness", () => {
  it("dates each message and tells the model to date anything time-bound and keep only corrected versions", () => {
    const row: WhatsAppMessageRow = {
      id: 1,
      phone: "447000000001",
      role: "user",
      content: "cheapest car hire in Mendoza today until tomorrow",
      createdAt: Date.UTC(2026, 10, 10, 15, 47),
    };
    const prompt = buildSummaryPrompt("Earlier summary.", [row]);

    expect(prompt).toContain("[2026-11-10] User: cheapest car hire in Mendoza today until tomorrow");
    expect(prompt).toMatch(/Never write today, tomorrow, currently/);
    expect(prompt).toMatch(/keep only the final, corrected version/);
    expect(prompt).toMatch(/the new batch wins/);
  });
});
