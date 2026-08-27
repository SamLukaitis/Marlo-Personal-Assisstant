import { describe, it, expect } from "vitest";
import {
  getConversationSummary,
  saveConversationSummary,
  appendWhatsAppMessage,
  findOrCreateUserByEmail,
  getWhatsAppBacklogForSummary,
} from "./store.js";

let counter = 0;
function uniquePhone(prefix: string): string {
  counter += 1;
  return `44${prefix}${Date.now()}${counter}`;
}

describe("conversation summary storage", () => {
  it("returns null when no summary has been saved for a phone", () => {
    expect(getConversationSummary(uniquePhone("none"))).toBeNull();
  });

  it("saves a summary and reads it back", () => {
    const phone = uniquePhone("save");
    saveConversationSummary(phone, "The user asked about their Lisbon trip.", 5);

    const row = getConversationSummary(phone);
    expect(row).toEqual({
      phone,
      summary: "The user asked about their Lisbon trip.",
      summarizedThroughId: 5,
      updatedAt: expect.any(Number),
    });
  });

  it("overwrites the previous summary for the same phone rather than duplicating rows", () => {
    const phone = uniquePhone("overwrite");
    saveConversationSummary(phone, "First version", 5);
    saveConversationSummary(phone, "Second version", 12);

    const row = getConversationSummary(phone);
    expect(row?.summary).toBe("Second version");
    expect(row?.summarizedThroughId).toBe(12);
  });
});

describe("getWhatsAppBacklogForSummary", () => {
  it("returns an empty array when total history already fits inside the raw window", () => {
    const user = findOrCreateUserByEmail(`backlog-fits-${Date.now()}@example.com`);
    const phone = uniquePhone("fits");
    appendWhatsAppMessage(user.id, phone, "user", "hi");
    appendWhatsAppMessage(user.id, phone, "assistant", "hello");

    expect(getWhatsAppBacklogForSummary(phone, 0, 24)).toEqual([]);
  });

  it("returns only the messages older than the raw window, oldest first, excluding already-summarized ones", () => {
    const user = findOrCreateUserByEmail(`backlog-batch-${Date.now()}@example.com`);
    const phone = uniquePhone("batch");
    const ids: number[] = [];
    for (let i = 0; i < 6; i++) {
      appendWhatsAppMessage(user.id, phone, "user", `msg ${i}`);
    }
    const rows = getWhatsAppBacklogForSummary(phone, 0, 2); // keep only the most recent 2 in the raw window
    expect(rows.map((r) => r.content)).toEqual(["msg 0", "msg 1", "msg 2", "msg 3"]);
    // Now simulate having already summarized through the first two of those.
    const afterFirstTwo = rows[1].id;
    const remaining = getWhatsAppBacklogForSummary(phone, afterFirstTwo, 2);
    expect(remaining.map((r) => r.content)).toEqual(["msg 2", "msg 3"]);
  });
});
