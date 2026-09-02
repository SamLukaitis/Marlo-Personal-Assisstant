# Searchable WhatsApp conversation history Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the assistant search the full raw WhatsApp transcript on demand, reaching past the 24-message window and the rolling summary, the same way `search_memory` already does for remembered notes.

**Architecture:** An FTS5 external-content index (`whatsapp_messages_fts`) mirrors the existing `memory_notes_fts` pattern over the existing `whatsapp_messages` table — no schema change to that table. A new store function `searchWhatsAppHistory` queries it, scoped by both `phone` and `owner_id`. A new tool `search_conversation_history`, gated on `phone` exactly like `send_document`, exposes it to the model, with a system-prompt rule telling it when to reach for the tool instead of guessing.

**Tech Stack:** TypeScript, better-sqlite3 (FTS5), Anthropic tool-use, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-02-whatsapp-conversation-search-design.md`

## Global Constraints

- No schema change to `whatsapp_messages` itself — only a new virtual table + triggers, same as `memory_notes_fts`.
- `searchWhatsAppHistory` filters by both `phone` and `owner_id` (defense in depth), matching `searchMemoryNotes`'s convention.
- No confirm-gate: read-only and fully reversible, like `search_memory`. Do not add `search_conversation_history` to `CONFIRM_REQUIRED_TOOLS`.
- Empty/no-match results return `[]`, never an error.
- Gated on `phone` at runtime exactly like `send_document` (not excluded from the tool list — always offered, refused at dispatch time when `phone` is absent).
- Don't export the module-level `db` handle from `store.ts` just for a test — `searchWhatsAppHistory`'s own behavior (append a message, search for it) is sufficient proof the FTS table and triggers work, without widening that module's public surface.

---

### Task 1: `whatsapp_messages_fts` index + `searchWhatsAppHistory` store function

**Files:**
- Modify: `server/src/db/store.ts`
  - FTS table/triggers/backfill: insert after the existing `memory_notes_fts` setup block (`store.ts:694-710`, i.e. right before the `// When a number last sent us a message` comment)
  - `searchWhatsAppHistory` function: insert right after `appendWhatsAppMessage` (`store.ts:1112-1121`)
- Test: Create `server/src/db/whatsappHistorySearchStore.test.ts`

**Interfaces:**
- Consumes: the existing `whatsapp_messages` table (`id`, `owner_id`, `phone`, `role`, `content`, `created_at` — post-migration schema, `store.ts:447-454`); the existing `WhatsAppMessageRow` interface (`store.ts:1090-1096`); `appendWhatsAppMessage(ownerId, phone, role, content)` and `findOrCreateUserByEmail(email)`, both already exported from `store.ts`.
- Produces: `export function searchWhatsAppHistory(ownerId: number, phone: string, query: string, limit = 20): WhatsAppMessageRow[]` — consumed by Task 2's tool dispatch.

- [ ] **Step 1: Write the failing tests**

Create `server/src/db/whatsappHistorySearchStore.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { findOrCreateUserByEmail, appendWhatsAppMessage, searchWhatsAppHistory } from "./store.js";

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}
function uniquePhone(prefix: string): string {
  counter += 1;
  return `44${prefix}${Date.now()}${counter}`;
}

describe("searchWhatsAppHistory", () => {
  it("finds a message containing the query term (proves the FTS index and its insert trigger both work)", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("wa-search-hit"));
    const phone = uniquePhone("hit");
    appendWhatsAppMessage(user.id, phone, "user", "My passport number is X1234567");
    appendWhatsAppMessage(user.id, phone, "assistant", "Got it, noted.");

    const results = searchWhatsAppHistory(user.id, phone, "passport");
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain("X1234567");
  });

  it("returns no results when nothing matches", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("wa-search-miss"));
    const phone = uniquePhone("miss");
    appendWhatsAppMessage(user.id, phone, "user", "What's the weather like");

    expect(searchWhatsAppHistory(user.id, phone, "passport")).toHaveLength(0);
  });

  it("scopes results to the given phone — a match on another thread doesn't leak in", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("wa-search-phone-scope"));
    const phoneA = uniquePhone("a");
    const phoneB = uniquePhone("b");
    appendWhatsAppMessage(user.id, phoneA, "user", "My passport number is X1234567");

    expect(searchWhatsAppHistory(user.id, phoneB, "passport")).toHaveLength(0);
  });

  it("scopes results to the owner — a match under another owner doesn't leak in", () => {
    const userA = findOrCreateUserByEmail(uniqueEmail("wa-search-owner-a"));
    const userB = findOrCreateUserByEmail(uniqueEmail("wa-search-owner-b"));
    const phone = uniquePhone("owner-scope");
    appendWhatsAppMessage(userA.id, phone, "user", "My passport number is X1234567");

    expect(searchWhatsAppHistory(userB.id, phone, "passport")).toHaveLength(0);
  });

  it("returns an empty array for a blank query instead of matching everything", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("wa-search-blank"));
    const phone = uniquePhone("blank");
    appendWhatsAppMessage(user.id, phone, "user", "hello there");

    expect(searchWhatsAppHistory(user.id, phone, "   ")).toHaveLength(0);
  });

  it("doesn't throw on FTS special characters in the query", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("wa-search-special"));
    const phone = uniquePhone("special");
    appendWhatsAppMessage(user.id, phone, "user", "hello there");

    expect(() => searchWhatsAppHistory(user.id, phone, '"quoted" OR NOT * weird:query')).not.toThrow();
  });

  it("respects the limit parameter", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("wa-search-limit"));
    const phone = uniquePhone("limit");
    for (let i = 0; i < 5; i++) {
      appendWhatsAppMessage(user.id, phone, "user", `trip message ${i}`);
    }

    expect(searchWhatsAppHistory(user.id, phone, "trip", 2)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `server/`): `npx vitest run src/db/whatsappHistorySearchStore.test.ts`
Expected: FAIL — `searchWhatsAppHistory` is not exported from `./store.js` (import error), since neither the function nor the FTS table exist yet.

- [ ] **Step 3: Implement the FTS table, triggers, and backfill**

In `server/src/db/store.ts`, immediately after the closing of the `memory_notes_fts` block (right after the line `if (!ftsExistedBefore) { db.exec(...) }` at `store.ts:708-710`, before the `// When a number last sent us a message` comment), insert:

```ts
// Full-text index over the raw WhatsApp transcript, backing searchWhatsAppHistory() below — the
// system prompt only ever includes the most recent MAX_HISTORY_MESSAGES messages plus a rolling
// summary of whatever fell out of that window (services/conversationSummary.ts). This is how the
// assistant reaches a specific older fact on demand instead of relying on the summary having kept
// it. External-content FTS5 table (content='whatsapp_messages') so the indexed text isn't
// duplicated in the DB; triggers keep it in sync with inserts/deletes (no update trigger —
// whatsapp_messages rows are never content-edited, only inserted or removed, e.g. by
// deleteUserCompletely).
const whatsappFtsExistedBefore = !!db
  .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'whatsapp_messages_fts'`)
  .get();
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS whatsapp_messages_fts USING fts5(
    content, content='whatsapp_messages', content_rowid='id'
  );
  CREATE TRIGGER IF NOT EXISTS whatsapp_messages_fts_ai AFTER INSERT ON whatsapp_messages BEGIN
    INSERT INTO whatsapp_messages_fts(rowid, content) VALUES (new.id, new.content);
  END;
  CREATE TRIGGER IF NOT EXISTS whatsapp_messages_fts_ad AFTER DELETE ON whatsapp_messages BEGIN
    INSERT INTO whatsapp_messages_fts(whatsapp_messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
  END;
`);
if (!whatsappFtsExistedBefore) {
  db.exec(`INSERT INTO whatsapp_messages_fts(rowid, content) SELECT id, content FROM whatsapp_messages`);
}
```

This must stay positioned after the `whatsapp_messages` migration block (`store.ts:446-464`, which drops and recreates the table) — placing it right after `memory_notes_fts`'s own block guarantees that, since that block is already positioned after all migrations.

- [ ] **Step 4: Implement `searchWhatsAppHistory`**

In `server/src/db/store.ts`, immediately after `appendWhatsAppMessage` (ends at `store.ts:1121`), add:

```ts
// Reaches the full raw transcript, not just the MAX_HISTORY_MESSAGES window the assistant sees by
// default — same tokenize-and-MATCH approach as searchMemoryNotes (store.ts:1040) above. Filters
// by both phone (the natural key for "this conversation thread") and owner_id (defense in depth,
// matching searchMemoryNotes's convention) — phone alone should already be unique per owner, but
// scoping by both means a lookup can never cross an owner boundary even if that ever stopped
// holding. Terms are ANDed, same reasoning as searchMemoryNotes: keeps multi-word queries from
// over-matching on any single common word.
export function searchWhatsAppHistory(
  ownerId: number,
  phone: string,
  query: string,
  limit = 20
): WhatsAppMessageRow[] {
  const terms = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (terms.length === 0) return [];

  const matchQuery = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" AND ");
  return db
    .prepare(
      `SELECT w.id, w.phone, w.role, w.content, w.created_at AS createdAt
       FROM whatsapp_messages_fts f
       JOIN whatsapp_messages w ON w.id = f.rowid
       WHERE f.whatsapp_messages_fts MATCH ? AND w.phone = ? AND w.owner_id = ?
       ORDER BY rank
       LIMIT ?`
    )
    .all(matchQuery, phone, ownerId, limit) as WhatsAppMessageRow[];
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/db/whatsappHistorySearchStore.test.ts`
Expected: PASS (all 7 tests) — the first test alone proves the FTS table, its insert trigger, and the store function all work together; there's no separate schema-only test.

- [ ] **Step 6: Commit**

```bash
git add server/src/db/store.ts server/src/db/whatsappHistorySearchStore.test.ts
git commit -m "feat: add whatsapp_messages_fts index and searchWhatsAppHistory"
```

---

### Task 2: `search_conversation_history` tool

**Files:**
- Modify: `server/src/ai/assistant.ts`
  - Import `searchWhatsAppHistory` (add to the `from "../db/store.js"` import block, `assistant.ts:2-29`)
  - Add `SEARCH_CONVERSATION_HISTORY_DEFAULT_LIMIT` constant (near `SEARCH_MEMORY_DEFAULT_LIMIT`, `assistant.ts:102`)
  - Add the tool definition to `ALWAYS_ON_TOOLS`, right after the `send_document` entry (`assistant.ts:466-477`)
  - Add the `runTool` dispatch case, right after the `send_document` case (`assistant.ts:865-879`)
  - Add a system-prompt rule to `buildRules`'s `base` array, right after the `send_document` rule (`assistant.ts:1166`)
- Test: `server/src/ai/assistant.test.ts`
  - Add `appendWhatsAppMessage` to the existing `from "../db/store.js"` import block (`assistant.test.ts:20-29`)
  - Add a new `describe` block

**Interfaces:**
- Consumes: `searchWhatsAppHistory(ownerId, phone, query, limit?)` (Task 1); the existing `runTool(ownerId, name, input, phone?)` signature and dispatch `switch` (`assistant.ts:762-772`); the existing `buildToolsForOwner(ownerId)` (`assistant.ts:706`).
- Produces: the `search_conversation_history` tool, always present in `buildToolsForOwner`'s output (same as `send_document` — not gated by `ToolKey`/`getEnabledTools`, only by `phone` at dispatch time).

- [ ] **Step 1: Write the failing tests**

In `server/src/ai/assistant.test.ts`, add `appendWhatsAppMessage` to the existing import from `"../db/store.js"` (alongside `findOrCreateUserByEmail`, `setToolEnabled`, etc. at `assistant.test.ts:20-29`), then add this `describe` block (near the existing `describe("send_document dispatch", ...)` block):

```ts
describe("search_conversation_history tool", () => {
  it("is always available, same as send_document", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("search-history-toollist"));
    const names = buildToolsForOwner(user.id).map((t) => t.name);
    expect(names).toContain("search_conversation_history");
  });

  it("refuses without a phone (web chat/eval callers)", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("search-history-no-phone"));

    const result = await runTool(user.id, "search_conversation_history", { query: "passport" });

    expect(result).toEqual({ error: expect.stringContaining("WhatsApp conversation") });
  });

  it("finds an older message outside the visible window, scoped to the calling phone", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("search-history-hit"));
    const phone = "447700000123";
    // Seed directly via the store's own append path used by the WhatsApp route, not runTool —
    // there's no "send a WhatsApp message" tool; messages land in the table via the webhook.
    appendWhatsAppMessage(user.id, phone, "user", "My passport number is X1234567");

    const result = (await runTool(user.id, "search_conversation_history", { query: "passport" }, phone)) as unknown[];

    expect(result).toHaveLength(1);
  });

  it("returns an empty array, not an error, when nothing matches", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("search-history-miss"));
    const phone = "447700000124";

    const result = await runTool(user.id, "search_conversation_history", { query: "nonexistent-topic" }, phone);

    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `server/`): `npx vitest run src/ai/assistant.test.ts -t "search_conversation_history"`
Expected: FAIL — `buildToolsForOwner`'s output doesn't include `search_conversation_history`; the `runTool` switch has no matching case (falls through to whatever the `default`/unhandled-case behavior is), so none of the four assertions match.

- [ ] **Step 3: Add the import and constant**

In `server/src/ai/assistant.ts`, change line 7 from:

```ts
  searchMemoryNotes,
```

to:

```ts
  searchMemoryNotes,
  searchWhatsAppHistory,
```

Change line 102 from:

```ts
export const SEARCH_MEMORY_DEFAULT_LIMIT = 10;
```

to:

```ts
export const SEARCH_MEMORY_DEFAULT_LIMIT = 10;
export const SEARCH_CONVERSATION_HISTORY_DEFAULT_LIMIT = 20;
```

- [ ] **Step 4: Add the tool definition**

In `server/src/ai/assistant.ts`, right after the `send_document` tool entry closes (`assistant.ts:477`, the `},` right before `{ name: "extract_email_attachment", ...`), insert:

```ts
  {
    name: "search_conversation_history",
    description:
      "Search the full WhatsApp conversation history with the user, not just the recent messages " +
      "and the rolling summary already in your context — call this when the user references " +
      "something they told you earlier (a name, a decision, a date, a specific fact) that isn't in " +
      "what you can currently see, instead of saying you don't have it or guessing. Only available " +
      "in a WhatsApp conversation.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keyword(s) to search for" },
        limit: { type: "number", description: "Max messages to return, default 20" },
      },
      required: ["query"],
    },
  },
```

- [ ] **Step 5: Add the `runTool` dispatch case**

In `server/src/ai/assistant.ts`, right after the `send_document` case closes (`assistant.ts:879`, the `}` right before `case "extract_email_attachment": {`), insert:

```ts
    case "search_conversation_history": {
      if (!phone) {
        return { error: "Searching conversation history is only available in a WhatsApp conversation." };
      }
      return searchWhatsAppHistory(
        ownerId,
        phone,
        input.query as string,
        (input.limit as number | undefined) ?? SEARCH_CONVERSATION_HISTORY_DEFAULT_LIMIT
      );
    }
```

- [ ] **Step 6: Add the system-prompt rule**

In `server/src/ai/assistant.ts`, in `buildRules`'s `base` array, right after the `send_document` rule (`assistant.ts:1166`), insert:

```ts
    "- Use search_conversation_history when the user references something they told you earlier (a name, a decision, a date, a specific fact) that isn't in your current context — the visible recent messages or the conversation summary above — instead of saying you don't have it or guessing. WhatsApp-only, same as send_document.",
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run src/ai/assistant.test.ts -t "search_conversation_history"`
Expected: PASS (all 4 tests)

- [ ] **Step 8: Run the full test suite**

Run: `npx vitest run`
Expected: PASS — no regressions in `buildToolsForOwner`'s existing tests (tool count/order assumptions) or `send_document`'s tests.

- [ ] **Step 9: Commit**

```bash
git add server/src/ai/assistant.ts server/src/ai/assistant.test.ts
git commit -m "feat: add search_conversation_history tool"
```

---

## Self-Review Notes

- **Spec coverage:** FTS table + backfill ✓ (Task 1, Steps 3/6); store function with phone+owner scoping ✓ (Task 1, Step 4); WhatsApp-only tool gated on phone like `send_document`, system-prompt rule ✓ (Task 2, Steps 4-6); no confirm-gate, empty-array behavior ✓ (Global Constraints + Task 1/2 tests); store-level hit/miss/owner-scoping tests, `runTool` dispatch test, web-chat-omits-phone error-path test ✓ (Task 1 Step 1, Task 2 Step 1).
- **Type consistency:** `searchWhatsAppHistory(ownerId: number, phone: string, query: string, limit = 20): WhatsAppMessageRow[]` is the same signature and return type used consistently in Task 1's implementation, Task 2's dispatch call, and every test.
- **Placeholder scan:** none found — every step carries real code, not a description of what to write.
