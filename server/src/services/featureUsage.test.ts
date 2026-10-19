import { describe, it, expect } from "vitest";
import { summariseFeatureUsage, type FeatureUsageInputRow } from "./featureUsage.js";
import {
  findOrCreateUserByEmail,
  recordFeatureMessage,
  listFeatureMessages,
  deleteUserCompletely,
} from "../db/store.js";

function row(messageId: number, ownerId: number, toolName: string | null, uses = 1, createdAt = 1000): FeatureUsageInputRow {
  return { messageId, ownerId, createdAt, toolName, uses: toolName ? uses : null };
}

describe("summariseFeatureUsage", () => {
  const catalog = [
    { name: "search_messages", switchedOn: true },
    { name: "create_email_draft", switchedOn: true },
    { name: "set_reminder", switchedOn: true },
    { name: "find_places", switchedOn: false },
    { name: "get_current_time", switchedOn: true },
  ];

  it("counts a message once per area however many of its tools it used", () => {
    const s = summariseFeatureUsage(
      [row(1, 10, "search_messages", 3), row(1, 10, "create_email_draft"), row(2, 11, "search_messages")],
      catalog
    );
    const email = s.areas.find((a) => a.area === "email")!;
    expect(email).toMatchObject({ messages: 2, people: 2 });
    expect(s.tools.find((t) => t.tool === "search_messages")).toMatchObject({ uses: 4, messages: 2, people: 2 });
  });

  it("counts messages with no tools, or only helper tools, as just conversation", () => {
    const s = summariseFeatureUsage([row(1, 10, null), row(2, 10, "get_current_time")], catalog);
    expect(s.totals).toEqual({ messages: 2, people: 1, messagesWithTools: 0 });
    expect(s.areas[0]).toMatchObject({ area: "chat", messages: 2 });
  });

  it("lists unused tools and areas with zero, and marks tools the server isn't set up for", () => {
    const s = summariseFeatureUsage([row(1, 10, "search_messages")], catalog);
    expect(s.tools.find((t) => t.tool === "set_reminder")).toMatchObject({ uses: 0, lastUsedAt: null });
    expect(s.tools.find((t) => t.tool === "find_places")).toMatchObject({ uses: 0, switchedOn: false });
    expect(s.areas.find((a) => a.area === "reminders")).toMatchObject({ messages: 0 });
  });

  it("includes recorded things outside the catalog, like a voice note", () => {
    const s = summariseFeatureUsage([row(1, 10, "unsupported:audio")], catalog);
    expect(s.tools.find((t) => t.tool === "unsupported:audio")).toMatchObject({
      label: "Sent a voice note",
      area: "unsupported",
      uses: 1,
    });
  });

  it("gives each person's busiest areas, busiest first", () => {
    const s = summariseFeatureUsage(
      [row(1, 10, "set_reminder"), row(2, 10, "search_messages"), row(3, 10, "search_messages", 1, 5000)],
      catalog
    );
    expect(s.people).toEqual([
      {
        ownerId: 10,
        messages: 3,
        topAreas: [
          { label: "Email", messages: 2 },
          { label: "Reminders", messages: 1 },
        ],
        lastActiveAt: 5000,
      },
    ]);
  });
});

describe("recordFeatureMessage", () => {
  it("stores a message and its tools, and deleting the user removes them", () => {
    const user = findOrCreateUserByEmail(`feature-store-${Date.now()}@example.com`);
    recordFeatureMessage(user.id, "whatsapp", new Map([["search_messages", 2]]));
    recordFeatureMessage(user.id, "web", new Map());

    const mine = listFeatureMessages(0).filter((r) => r.ownerId === user.id);
    expect(mine.map((r) => [r.channel, r.toolName, r.uses])).toEqual([
      ["whatsapp", "search_messages", 2],
      ["web", null, null],
    ]);

    deleteUserCompletely(user.id);
    expect(listFeatureMessages(0).filter((r) => r.ownerId === user.id)).toEqual([]);
  });
});
