import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  const MockAnthropic = vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  });
  return { __esModule: true, default: MockAnthropic };
});

import {
  maybeExtractMemory,
  applyMemoryOperations,
  buildExtractionPrompt,
  EXTRACTION_BATCH_SIZE,
} from "./memoryExtraction.js";
import {
  findOrCreateUserByEmail,
  addPhoneNumberForUser,
  appendWhatsAppMessage,
  addFact,
  findOrCreateEntity,
  addEntityAlias,
  findEntityByName,
  listMemoryNotes,
  listCoreProfile,
  listEntityRelations,
  getMemoryExtractionCursor,
  listRecentApiUsage,
  listEntities,
} from "../db/store.js";

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}
function uniquePhone(): string {
  counter += 1;
  return `4475${String(Date.now() + counter).slice(-8)}`;
}

function setup(messageCount: number) {
  const user = findOrCreateUserByEmail(uniqueEmail("extract"));
  const phone = uniquePhone();
  addPhoneNumberForUser(user.id, phone);
  const ids: number[] = [];
  for (let i = 0; i < messageCount; i++) {
    ids.push(appendWhatsAppMessage(user.id, phone, i % 2 === 0 ? "user" : "assistant", `message ${i}`));
  }
  return { user, phone, ids };
}

function toolResponse(operations: unknown[]) {
  return {
    content: [{ type: "tool_use", id: "t1", name: "record_memory", input: { operations } }],
    usage: { input_tokens: 100, output_tokens: 20 },
  };
}

beforeEach(() => {
  mockCreate.mockReset();
  process.env.ANTHROPIC_API_KEY = "test-key";
});

describe("maybeExtractMemory", () => {
  it("does nothing below the batch size", async () => {
    const { phone } = setup(EXTRACTION_BATCH_SIZE - 1);
    await maybeExtractMemory(phone);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("applies extracted facts, advances the cursor, and records usage", async () => {
    const { user, phone, ids } = setup(EXTRACTION_BATCH_SIZE);
    mockCreate.mockResolvedValueOnce(
      toolResponse([
        { op: "add_fact", content: "The user's name is Sam", kind: "core" },
        { op: "add_fact", content: "Sarah is the user's accountant", kind: "fact", entity: { name: "Sarah", type: "person" } },
      ])
    );

    await maybeExtractMemory(phone);

    expect(listCoreProfile(user.id).map((f) => f.content)).toEqual(["The user's name is Sam"]);
    const sarah = findEntityByName(user.id, "Sarah");
    expect(listMemoryNotes(user.id).find((f) => f.entityId === sarah?.id)?.source).toBe("extracted");
    expect(getMemoryExtractionCursor(phone)).toBe(ids[ids.length - 1]);
    expect(listRecentApiUsage(50).some((r) => r.ownerId === user.id && r.purpose === "memory_extraction")).toBe(true);
  });

  it("leaves the cursor unchanged when the API call fails", async () => {
    const { phone } = setup(EXTRACTION_BATCH_SIZE);
    mockCreate.mockRejectedValueOnce(new Error("overloaded"));
    await expect(maybeExtractMemory(phone)).resolves.toBeUndefined();
    expect(getMemoryExtractionCursor(phone)).toBeNull();
  });

  it("advances the cursor even when every operation is invalid", async () => {
    const { phone, ids } = setup(EXTRACTION_BATCH_SIZE);
    mockCreate.mockResolvedValueOnce(toolResponse([{ op: "explode" }, { nonsense: true }]));
    await maybeExtractMemory(phone);
    expect(getMemoryExtractionCursor(phone)).toBe(ids[ids.length - 1]);
  });

  it("does not run twice concurrently for the same phone", async () => {
    const { phone } = setup(EXTRACTION_BATCH_SIZE);
    let release: (v: unknown) => void = () => {};
    mockCreate.mockReturnValueOnce(new Promise((r) => (release = r)));
    const first = maybeExtractMemory(phone);
    await maybeExtractMemory(phone);
    release(toolResponse([]));
    await first;
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("starts a never-extracted phone at the recent window, not at its oldest message", async () => {
    const { phone, ids } = setup(40);
    mockCreate.mockResolvedValue(toolResponse([]));
    await maybeExtractMemory(phone);
    const prompt = mockCreate.mock.calls[0][0].messages[0].content as string;
    expect(prompt).not.toContain("message 0\n");
    expect(prompt).toContain(`message ${40 - 24}`);
    expect(getMemoryExtractionCursor(phone)).toBe(ids[40 - 24 + EXTRACTION_BATCH_SIZE - 1]);
  });

  it("ignores a phone that belongs to no one", async () => {
    await maybeExtractMemory("449999999999");
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe("applyMemoryOperations", () => {
  it("honours supersedes_id only for shown candidates, but still adds the fact", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("apply-supersede"));
    const shown = addFact(user.id, { content: "Lives in Paris", kind: "core" });
    const hidden = addFact(user.id, { content: "Works at Acme", kind: "core" });

    applyMemoryOperations(
      user.id,
      [
        { op: "add_fact", content: "Lives in London", kind: "core", supersedes_id: shown.id },
        { op: "add_fact", content: "Works at Globex", kind: "core", supersedes_id: hidden.id },
      ],
      new Set([shown.id])
    );

    expect(listCoreProfile(user.id).map((f) => f.content)).toEqual(["Works at Acme", "Lives in London", "Works at Globex"]);
  });

  it("skips invalid ops individually and applies valid siblings", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("apply-invalid"));
    const result = applyMemoryOperations(
      user.id,
      [
        { op: "add_fact", content: "", kind: "fact" },
        { op: "add_fact", content: "x".repeat(501), kind: "fact" },
        { op: "add_fact", content: "Valid", kind: "bogus" },
        { op: "unknown" },
        null,
        { op: "add_fact", content: "Likes jazz", kind: "preference" },
      ],
      new Set()
    );
    expect(result).toEqual({ applied: 1, skipped: 5 });
    expect(listMemoryNotes(user.id).map((f) => f.content)).toEqual(["Likes jazz"]);
  });

  it("reuses an entity via its alias and never creates entities from link/alias ops", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("apply-entities"));
    const sarah = findOrCreateEntity(user.id, "person", "Sarah");
    addEntityAlias(user.id, sarah.id, "Sarah Jones");

    applyMemoryOperations(
      user.id,
      [
        { op: "add_fact", content: "Sarah Jones prefers email", kind: "preference", entity: { name: "Sarah Jones", type: "person" } },
        { op: "add_fact", content: "Acme is a client", kind: "fact", entity: { name: "Acme", type: "organisation" } },
        { op: "link", from: "Sarah", relation: "works_at", to: "Acme" },
        { op: "link", from: "Sarah", relation: "knows", to: "Nobody" },
        { op: "alias", entity: "Ghost", alias: "Casper" },
        { op: "alias", entity: "Acme", alias: "Acme Ltd" },
      ],
      new Set()
    );

    expect(listMemoryNotes(user.id).find((f) => f.content === "Sarah Jones prefers email")?.entityId).toBe(sarah.id);
    expect(listEntityRelations(user.id, sarah.id).map((r) => `${r.relation}:${r.entity.name}`)).toEqual(["works_at:Acme"]);
    expect(findEntityByName(user.id, "Nobody")).toBeNull();
    expect(findEntityByName(user.id, "Ghost")).toBeNull();
    expect(findEntityByName(user.id, "Acme Ltd")?.data.name).toBe("Acme");
  });

  it("adds the fact with no entity for a reserved entity type, instead of polluting the typed entities table", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("apply-reserved-type"));

    const result = applyMemoryOperations(
      user.id,
      [{ op: "add_fact", content: "Booked the Hilton for the trip", kind: "fact", entity: { name: "Hilton", type: "booking" } }],
      new Set()
    );

    expect(result).toEqual({ applied: 1, skipped: 0 });
    const fact = listMemoryNotes(user.id).find((f) => f.content === "Booked the Hilton for the trip");
    expect(fact?.entityId).toBeNull();
    expect(listEntities(user.id, { type: "booking" })).toEqual([]);
  });
});

describe("buildExtractionPrompt", () => {
  it("states the durability, confirmation, core and secrets rules and lists candidates with ids", () => {
    const prompt = buildExtractionPrompt({
      context: [],
      batch: [{ id: 1, phone: "44", role: "user", content: "hi", createdAt: 0 }],
      candidates: [{ id: 7, content: "Lives in Paris", createdAt: 0, triggerAt: null, lastSurfacedAt: null, gaveUpAt: null, entityId: null, kind: "core", source: "told" }],
      entities: [{ id: 3, type: "person", name: "Sarah", aliases: ["Sarah Jones"], updatedAt: 0 }],
    });
    expect(prompt).toContain("[#7] (core) Lives in Paris");
    expect(prompt).toContain("Sarah (person; also: Sarah Jones)");
    expect(prompt).toMatch(/password/i);
    expect(prompt).toMatch(/confirmed/i);
    expect(prompt).toMatch(/durable/i);
  });
});
