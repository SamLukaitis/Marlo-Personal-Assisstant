# Personal Memory Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Marlowe robust, cost-efficient memory: facts are extracted automatically from WhatsApp chat into a structured fact store linked to remembered entities; a small stable core profile is always in the cached system prompt; facts relevant to the current message are retrieved and injected outside the cached prefix; the user can correct and forget via chat.

**Architecture:** `memory_notes` becomes the single fact store (new columns: `entity_id`, `kind`, `source`, `superseded_*`, `forgotten_at`); remembered entities in `entities` become `{ name, aliases }` and their old `data.notes[]` move into `memory_notes`. A Haiku job (`services/memoryExtraction.ts`) turns each 8-message WhatsApp batch into validated add/supersede/link/alias operations. `ai/memoryRetrieval.ts` does pure-SQLite retrieval (entity-name match + OR/BM25 FTS) per call; `runAssistantChat` injects that block into the latest user message and adds a 4th cache breakpoint on the message before it.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Node, better-sqlite3 + FTS5, `@anthropic-ai/sdk`, vitest. All commands run from `server/`.

**Spec:** `docs/superpowers/specs/2026-09-23-personal-memory-graph-design.md`

## Global Constraints

- Test runner: `npx vitest run <file>` from `server/`; full suite `npm test`; typecheck/build `npm run build`.
- Tests use a real temp SQLite DB (`src/test/setup.ts` sets `DATA_DIR`); every test creates its own user via `findOrCreateUserByEmail(uniqueEmail(...))` — never share users across tests.
- Anthropic SDK is mocked in tests exactly like `src/ai/assistant.cacheBreakpoint.test.ts` (`vi.mock("@anthropic-ai/sdk", ...)` with a shared `mockCreate`).
- Active fact = `superseded_at IS NULL AND forgotten_at IS NULL`.
- `kind` ∈ `core | fact | preference`; `source` ∈ `told | extracted`.
- `memory_notes.entity_id` has **no** `REFERENCES` clause.
- Core profile cap 40 (raised from 20 after review); retrieval caps: 3 entities, 5 facts/entity, 8 FTS hits, 12 facts total, 1,500 chars.
- Extraction: batch size 8, 2 context messages, 30 candidate facts, 50 candidate entities, fact content ≤ 500 chars, model `process.env.ASSISTANT_MODEL_SIMPLE ?? "claude-haiku-4-5"`, usage purpose `"memory_extraction"`.
- Cache breakpoints: at most 4 per request (tools, system, stable-history message, last message).
- Code style: match surrounding code — explanatory `//` comments on non-obvious decisions, no new dependencies.
- Commits end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01XHM9Se4yf8ESfvagvPrkpE
  ```

## Review Focus

1. **Legacy duplicate notes during migration** — the old `remember` wrote each entity note to *both* `memory_notes` and `data.notes[]`; migrating naively would duplicate every entity fact. Expected: the existing flat row is adopted (gets `entity_id`), no duplicate. Test in Task 1.
2. **Name substrings in retrieval** — an entity named "Sam" must not match "Samsung", and regex metacharacters in names ("C++ Guild", "Dr. Who") must not throw. Test in Task 5.
3. **First extraction on a long-lived account** — a user with months of history must not have ancient messages extracted first (they could supersede newer facts). Expected: first run starts at the recent raw window, not id 0. Test in Task 7.
4. **Model returns garbage ops** — unknown `op`, missing fields, `supersedes_id` of another owner's fact, over-long content. Expected: skipped individually, valid siblings still applied, cursor advances. Test in Task 7.
5. **Superseding/forgetting across owners** — `replaces_id` / `forget_memory` with another user's fact id must do nothing. Test in Tasks 2 and 4.

---

## File Structure

| File | Responsibility |
|---|---|
| Create `server/src/db/migrations/memoryGraph.ts` | Idempotent schema migration: new `memory_notes` columns + indexes, `memory_extraction_cursors` table, move `entities.data.notes[]` into `memory_notes`. |
| Create `server/src/db/migrations/memoryGraph.test.ts` | In-memory-DB tests for the migration. |
| Modify `server/src/db/store.ts` | Call migration; fact API (`addFact`, `forgetFacts`, `listCoreProfile`, `listActiveFactsForEntity`, `listNewestActiveFacts`, `searchActiveFacts`); remembered-entity API (`aliases`, `addEntityAlias`, `listRememberedEntities`, `linkEntitiesOnce`, `listEntityRelations`); extraction cursor + message-window helpers; `inTransaction`; `deleteUserCompletely` clears cursors. Remove `appendEntityNote`, `listRecentMemoryNotes`. |
| Create `server/src/db/memoryFacts.test.ts` | Store tests for the fact API. |
| Modify `server/src/db/entities.test.ts` | Update remembered-entity tests for aliases shape. |
| Create `server/src/ai/memoryRetrieval.ts` | `retrieveRelevantMemory(ownerId, text)` and `mentionsName(text, name)`. |
| Create `server/src/ai/memoryRetrieval.test.ts` | Retrieval tests. |
| Modify `server/src/ai/assistant.ts` | Tool schemas/cases (`remember`, `recall_entity`, `search_memory`, new `forget_memory`), rules, core profile in `buildSystemPrompt`, injection + 4th breakpoint in `runAssistantChat`. |
| Modify `server/src/ai/assistant.test.ts`, `server/src/ai/assistant.cacheBreakpoint.test.ts` | Updated and new tool/prompt/cache tests. |
| Create `server/src/services/memoryExtraction.ts` | Batch loading, candidate selection, Haiku call, op validation/apply, cursor. |
| Create `server/src/services/memoryExtraction.test.ts` | Extraction tests with mocked SDK. |
| Modify `server/src/routes/whatsappRoutes.ts` | Fire-and-forget `maybeExtractMemory`. |
| Modify `server/src/routes/whatsappRoutes.test.ts`, `server/src/routes/onboarding.e2e.test.ts` | Mock `memoryExtraction.js` next to the existing `conversationSummary.js` mock. |
| Modify `server/src/db/deleteUserCompletely.test.ts` | Cursor cleared on delete. |

---

### Task 1: Schema migration

**Files:**
- Create: `server/src/db/migrations/memoryGraph.ts`
- Create: `server/src/db/migrations/memoryGraph.test.ts`
- Modify: `server/src/db/store.ts` (import at top next to `migrateReplayParkMarker`; call right after the `memory_notes_fts` block, i.e. after `if (!ftsExistedBefore) { ... }` ~line 905)

**Interfaces:**
- Consumes: nothing.
- Produces: `migrateMemoryGraph(db: Database.Database): void`; columns `memory_notes.entity_id/kind/source/superseded_at/superseded_by/forgotten_at`; table `memory_extraction_cursors(phone TEXT PRIMARY KEY, extracted_through_id INTEGER NOT NULL, updated_at INTEGER NOT NULL)`; remembered entities' `data` = `{ name, aliases: string[] }` (no `notes`).

- [ ] **Step 1: Write the failing test**

`server/src/db/migrations/memoryGraph.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { migrateMemoryGraph } from "./memoryGraph.js";

// The shape store.ts has by the time this migration runs: memory_notes already carries owner_id
// and the reminder columns, entities exists with remember-bridge rows holding data.notes[].
function buildDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE memory_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      trigger_at INTEGER,
      last_surfaced_at INTEGER,
      gave_up_at INTEGER
    );
    CREATE TABLE entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      data TEXT NOT NULL,
      confidence REAL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  return db;
}

function insertEntity(db: Database.Database, ownerId: number, type: string, data: unknown): number {
  return Number(
    db
      .prepare(`INSERT INTO entities (owner_id, type, data, created_at, updated_at) VALUES (?, ?, ?, 1, 1)`)
      .run(ownerId, type, JSON.stringify(data)).lastInsertRowid
  );
}

function notes(db: Database.Database) {
  return db
    .prepare(
      `SELECT id, owner_id AS ownerId, content, created_at AS createdAt, entity_id AS entityId, kind, source
       FROM memory_notes ORDER BY id`
    )
    .all() as { id: number; ownerId: number; content: string; createdAt: number; entityId: number | null; kind: string; source: string }[];
}

describe("migrateMemoryGraph", () => {
  it("adds the new memory_notes columns with defaults for existing rows", () => {
    const db = buildDb();
    db.prepare(`INSERT INTO memory_notes (owner_id, content, created_at) VALUES (1, 'Likes tea', 5)`).run();

    migrateMemoryGraph(db);

    const cols = (db.prepare(`PRAGMA table_info(memory_notes)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining(["entity_id", "kind", "source", "superseded_at", "superseded_by", "forgotten_at"])
    );
    expect(notes(db)).toEqual([
      { id: 1, ownerId: 1, content: "Likes tea", createdAt: 5, entityId: null, kind: "fact", source: "told" },
    ]);
  });

  it("creates the extraction cursor table", () => {
    const db = buildDb();
    migrateMemoryGraph(db);
    db.prepare(`INSERT INTO memory_extraction_cursors (phone, extracted_through_id, updated_at) VALUES ('44', 3, 1)`).run();
    expect(db.prepare(`SELECT extracted_through_id AS id FROM memory_extraction_cursors`).get()).toEqual({ id: 3 });
  });

  it("adopts the existing flat note for a legacy entity note instead of duplicating it", () => {
    const db = buildDb();
    // Old remember wrote the same text to memory_notes AND data.notes[].
    db.prepare(`INSERT INTO memory_notes (owner_id, content, created_at) VALUES (1, 'Handles invoicing', 10)`).run();
    const sarah = insertEntity(db, 1, "person", { name: "Sarah", notes: [{ text: "Handles invoicing", at: 10 }] });

    migrateMemoryGraph(db);

    expect(notes(db)).toEqual([
      { id: 1, ownerId: 1, content: "Handles invoicing", createdAt: 10, entityId: sarah, kind: "fact", source: "told" },
    ]);
    const data = JSON.parse((db.prepare(`SELECT data FROM entities WHERE id = ?`).get(sarah) as { data: string }).data);
    expect(data).toEqual({ name: "Sarah", aliases: [] });
  });

  it("inserts a legacy entity note that has no flat twin, keeping its timestamp", () => {
    const db = buildDb();
    const sarah = insertEntity(db, 1, "person", { name: "Sarah", notes: [{ text: "Prefers email", at: 42 }] });

    migrateMemoryGraph(db);

    expect(notes(db)).toEqual([
      expect.objectContaining({ ownerId: 1, content: "Prefers email", createdAt: 42, entityId: sarah }),
    ]);
  });

  it("never adopts another owner's identical note", () => {
    const db = buildDb();
    db.prepare(`INSERT INTO memory_notes (owner_id, content, created_at) VALUES (2, 'Handles invoicing', 10)`).run();
    const sarah = insertEntity(db, 1, "person", { name: "Sarah", notes: [{ text: "Handles invoicing", at: 10 }] });

    migrateMemoryGraph(db);

    const rows = notes(db);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.ownerId === 2)?.entityId).toBeNull();
    expect(rows.find((r) => r.ownerId === 1)?.entityId).toBe(sarah);
  });

  it("leaves non-remembered entities untouched", () => {
    const db = buildDb();
    const booking = insertEntity(db, 1, "booking", { kind: "hotel", name: "Hotel Eva" });
    migrateMemoryGraph(db);
    const data = JSON.parse((db.prepare(`SELECT data FROM entities WHERE id = ?`).get(booking) as { data: string }).data);
    expect(data).toEqual({ kind: "hotel", name: "Hotel Eva" });
  });

  it("is idempotent — a second run changes nothing", () => {
    const db = buildDb();
    insertEntity(db, 1, "person", { name: "Sarah", notes: [{ text: "Prefers email", at: 42 }] });
    migrateMemoryGraph(db);
    const before = notes(db);
    migrateMemoryGraph(db);
    expect(notes(db)).toEqual(before);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/db/migrations/memoryGraph.test.ts`
Expected: FAIL — cannot resolve `./memoryGraph.js`.

- [ ] **Step 3: Write the migration**

`server/src/db/migrations/memoryGraph.ts`:

```ts
import type Database from "better-sqlite3";

// Brings memory_notes and the remember→entities bridge forward to the personal-memory-graph shape
// (docs/superpowers/specs/2026-09-23-personal-memory-graph-design.md):
//
// - memory_notes gains the columns that turn it into a structured fact store: which remembered
//   entity a fact is about (entity_id — deliberately no REFERENCES clause, so deleteUserCompletely
//   gains no new FK-ordering hazard), kind (core/fact/preference), source (told/extracted), and
//   soft supersede/forget markers.
// - memory_extraction_cursors records how far services/memoryExtraction.ts has read each phone's
//   WhatsApp transcript.
// - Remembered entities stop carrying their notes inline (data.notes[]): each note becomes a
//   memory_notes row with entity_id set, so a correction or "forget" has exactly one copy to act
//   on. The old remember tool wrote every entity note to BOTH places, so an identical flat row of
//   the same owner is adopted (entity_id set on it) rather than duplicated.
//
// Safe on every boot: columns/tables are guarded, and an entity is only rewritten while its data
// still has a notes array.
export function migrateMemoryGraph(db: Database.Database): void {
  const columns = (db.prepare(`PRAGMA table_info(memory_notes)`).all() as { name: string }[]).map((c) => c.name);
  const addColumn = (name: string, definition: string) => {
    if (!columns.includes(name)) db.exec(`ALTER TABLE memory_notes ADD COLUMN ${name} ${definition}`);
  };
  addColumn("entity_id", "INTEGER");
  addColumn("kind", "TEXT NOT NULL DEFAULT 'fact'");
  addColumn("source", "TEXT NOT NULL DEFAULT 'told'");
  addColumn("superseded_at", "INTEGER");
  addColumn("superseded_by", "INTEGER");
  addColumn("forgotten_at", "INTEGER");

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_notes_entity ON memory_notes (owner_id, entity_id);
    CREATE INDEX IF NOT EXISTS idx_memory_notes_kind ON memory_notes (owner_id, kind);
    CREATE TABLE IF NOT EXISTS memory_extraction_cursors (
      phone                TEXT PRIMARY KEY,
      extracted_through_id INTEGER NOT NULL,
      updated_at           INTEGER NOT NULL
    );
  `);

  const candidates = db
    .prepare(`SELECT id, owner_id AS ownerId, data FROM entities WHERE data LIKE '%"notes"%'`)
    .all() as { id: number; ownerId: number; data: string }[];

  const findTwin = db.prepare(
    `SELECT id FROM memory_notes WHERE owner_id = ? AND content = ? AND entity_id IS NULL ORDER BY id LIMIT 1`
  );
  const adopt = db.prepare(`UPDATE memory_notes SET entity_id = ? WHERE id = ?`);
  const insert = db.prepare(
    `INSERT INTO memory_notes (owner_id, content, created_at, entity_id, kind, source) VALUES (?, ?, ?, ?, 'fact', 'told')`
  );
  const rewrite = db.prepare(`UPDATE entities SET data = ? WHERE id = ?`);

  db.transaction(() => {
    for (const row of candidates) {
      let data: { name?: unknown; notes?: unknown; aliases?: unknown; [key: string]: unknown };
      try {
        data = JSON.parse(row.data);
      } catch {
        continue;
      }
      if (typeof data?.name !== "string" || !Array.isArray(data.notes)) continue;

      for (const note of data.notes as { text?: unknown; at?: unknown }[]) {
        if (typeof note?.text !== "string" || !note.text.trim()) continue;
        const twin = findTwin.get(row.ownerId, note.text) as { id: number } | undefined;
        if (twin) adopt.run(row.id, twin.id);
        else insert.run(row.ownerId, note.text, typeof note.at === "number" ? note.at : Date.now(), row.id);
      }

      const { notes: _notes, ...rest } = data;
      rewrite.run(JSON.stringify({ ...rest, aliases: Array.isArray(rest.aliases) ? rest.aliases : [] }), row.id);
    }
  })();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/db/migrations/memoryGraph.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Wire into store.ts**

Add the import beside the others at the top of `server/src/db/store.ts`:

```ts
import { migrateMemoryGraph } from "./migrations/memoryGraph.js";
```

Immediately after the `memory_notes_fts` block (the `if (!ftsExistedBefore) { db.exec(\`INSERT INTO memory_notes_fts...\`); }` statement) add:

```ts
// Structured-fact columns, the extraction cursor table, and moving remembered entities' inline
// notes into memory_notes — see the migration's own comment. Runs after the FTS triggers exist so
// any note it inserts is indexed like every other insert.
migrateMemoryGraph(db);
```

- [ ] **Step 6: Run the store smoke + entity tests to confirm boot still works**

Run: `npx vitest run src/db/store.smoke.test.ts src/db/memoryNotesStore.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/db/migrations/memoryGraph.ts src/db/migrations/memoryGraph.test.ts src/db/store.ts
git commit -m "feat: migrate memory_notes into a structured fact store and move entity notes onto it"
```

---

### Task 2: Fact store API

**Files:**
- Modify: `server/src/db/store.ts` (the memory-notes section around `MemoryNoteRow` ~line 1347 through `searchReminderNotes` ~line 1440)
- Create: `server/src/db/memoryFacts.test.ts`

**Interfaces:**
- Consumes: columns from Task 1.
- Produces (all exported from `store.ts`):
  ```ts
  export type MemoryKind = "core" | "fact" | "preference";
  export type MemorySource = "told" | "extracted";
  export interface MemoryNoteRow { id: number; content: string; createdAt: number; triggerAt: number | null;
    lastSurfacedAt: number | null; gaveUpAt: number | null; entityId: number | null; kind: MemoryKind; source: MemorySource; }
  export function isMemoryKind(value: unknown): value is MemoryKind;
  export function addFact(ownerId: number, input: { content: string; kind?: MemoryKind; source?: MemorySource;
    entityId?: number | null; supersedesId?: number | null }): MemoryNoteRow;
  export function forgetFacts(ownerId: number, ids: number[]): number[];
  export function listCoreProfile(ownerId: number, limit?: number): MemoryNoteRow[];          // default 20, oldest→newest
  export function listActiveFactsForEntity(ownerId: number, entityId: number, limit?: number): MemoryNoteRow[]; // default 20, newest first
  export function listNewestActiveFacts(ownerId: number, opts?: { limit?: number; excludeCore?: boolean }): MemoryNoteRow[];
  export function searchActiveFacts(ownerId: number, query: string,
    opts?: { mode?: "all" | "any"; limit?: number; excludeCore?: boolean }): MemoryNoteRow[];
  export function inTransaction<T>(fn: () => T): T;
  ```
  `listMemoryNotes` and `searchMemoryNotes` return active facts only. `listRecentMemoryNotes` is removed in Task 6 (still used by the prompt until then).

- [ ] **Step 1: Write the failing test**

`server/src/db/memoryFacts.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  findOrCreateUserByEmail,
  addFact,
  addMemoryNote,
  forgetFacts,
  listCoreProfile,
  listActiveFactsForEntity,
  listNewestActiveFacts,
  searchActiveFacts,
  searchMemoryNotes,
  listMemoryNotes,
  findOrCreateEntity,
} from "./store.js";

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

describe("addFact", () => {
  it("defaults to kind fact, source told, no entity", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("fact-defaults"));
    const fact = addFact(user.id, { content: "Likes oat milk" });
    expect(fact).toMatchObject({ content: "Likes oat milk", kind: "fact", source: "told", entityId: null });
  });

  it("addMemoryNote rows read back with the same defaults", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("fact-legacy-defaults"));
    const note = addMemoryNote(user.id, "Legacy note");
    expect(note).toMatchObject({ kind: "fact", source: "told", entityId: null });
  });

  it("supersedes an active fact of the same owner, hiding it from every active read", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("fact-supersede"));
    const old = addFact(user.id, { content: "Lives in Paris", kind: "core" });
    const next = addFact(user.id, { content: "Lives in London", kind: "core", supersedesId: old.id });

    expect(listCoreProfile(user.id).map((f) => f.id)).toEqual([next.id]);
    expect(searchActiveFacts(user.id, "Paris")).toEqual([]);
    expect(listMemoryNotes(user.id).map((f) => f.id)).toEqual([next.id]);
  });

  it("ignores supersedesId pointing at another owner's fact", () => {
    const owner = findOrCreateUserByEmail(uniqueEmail("fact-supersede-owner"));
    const intruder = findOrCreateUserByEmail(uniqueEmail("fact-supersede-intruder"));
    const theirs = addFact(owner.id, { content: "Owner fact" });

    addFact(intruder.id, { content: "Intruder fact", supersedesId: theirs.id });

    expect(listMemoryNotes(owner.id).map((f) => f.id)).toEqual([theirs.id]);
  });
});

describe("forgetFacts", () => {
  it("soft-deletes only this owner's active facts and reports which ids changed", () => {
    const owner = findOrCreateUserByEmail(uniqueEmail("forget-owner"));
    const other = findOrCreateUserByEmail(uniqueEmail("forget-other"));
    const mine = addFact(owner.id, { content: "Allergic to shellfish" });
    const theirs = addFact(other.id, { content: "Allergic to peanuts" });

    expect(forgetFacts(owner.id, [mine.id, theirs.id, 999_999])).toEqual([mine.id]);
    expect(searchMemoryNotes(owner.id, "shellfish")).toEqual([]);
    expect(listMemoryNotes(other.id).map((f) => f.id)).toEqual([theirs.id]);
    // Forgetting twice is a no-op, not an error.
    expect(forgetFacts(owner.id, [mine.id])).toEqual([]);
  });
});

describe("listCoreProfile", () => {
  it("returns only active core facts, oldest first, keeping the newest `limit`", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("core-profile"));
    addFact(user.id, { content: "Not core" });
    const a = addFact(user.id, { content: "Name is Sam", kind: "core" });
    const b = addFact(user.id, { content: "Partner is Anna", kind: "core" });
    const c = addFact(user.id, { content: "Works at Acme", kind: "core" });

    expect(listCoreProfile(user.id).map((f) => f.id)).toEqual([a.id, b.id, c.id]);
    expect(listCoreProfile(user.id, 2).map((f) => f.id)).toEqual([b.id, c.id]);
  });
});

describe("listActiveFactsForEntity / listNewestActiveFacts", () => {
  it("scopes to one entity, newest first", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("entity-facts"));
    const sarah = findOrCreateEntity(user.id, "person", "Sarah");
    const f1 = addFact(user.id, { content: "Sarah handles invoicing", entityId: sarah.id });
    addFact(user.id, { content: "Unrelated" });
    const f2 = addFact(user.id, { content: "Sarah prefers email", entityId: sarah.id });

    expect(listActiveFactsForEntity(user.id, sarah.id).map((f) => f.id)).toEqual([f2.id, f1.id]);
  });

  it("listNewestActiveFacts can exclude core", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("newest-facts"));
    addFact(user.id, { content: "Name is Sam", kind: "core" });
    const f = addFact(user.id, { content: "Likes jazz", kind: "preference" });
    expect(listNewestActiveFacts(user.id, { excludeCore: true }).map((r) => r.id)).toEqual([f.id]);
  });
});

describe("searchActiveFacts", () => {
  it("mode all requires every term; mode any matches any term and drops stopwords", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("search-modes"));
    const shell = addFact(user.id, { content: "Allergic to shellfish" });
    const seats = addFact(user.id, { content: "Prefers window seats" });

    expect(searchActiveFacts(user.id, "shellfish seats", { mode: "all" })).toEqual([]);
    expect(
      searchActiveFacts(user.id, "what about the shellfish and seats", { mode: "any" })
        .map((f) => f.id)
        .sort()
    ).toEqual([shell.id, seats.id].sort());
  });

  it("excludeCore drops core facts; a query of only stopwords returns nothing", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("search-core"));
    addFact(user.id, { content: "Lives in Lisbon", kind: "core" });
    expect(searchActiveFacts(user.id, "Lisbon", { mode: "any", excludeCore: true })).toEqual([]);
    expect(searchActiveFacts(user.id, "the and of", { mode: "any" })).toEqual([]);
  });

  it("never returns another owner's facts", () => {
    const a = findOrCreateUserByEmail(uniqueEmail("search-owner-a"));
    const b = findOrCreateUserByEmail(uniqueEmail("search-owner-b"));
    addFact(a.id, { content: "Secret zebra fact" });
    expect(searchActiveFacts(b.id, "zebra", { mode: "any" })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/db/memoryFacts.test.ts`
Expected: FAIL — `addFact` (and others) is not exported.

- [ ] **Step 3: Implement the fact API in store.ts**

Replace the `MemoryNoteRow` interface and `MEMORY_NOTE_COLUMNS` constant with:

```ts
export type MemoryKind = "core" | "fact" | "preference";
export type MemorySource = "told" | "extracted";

export function isMemoryKind(value: unknown): value is MemoryKind {
  return value === "core" || value === "fact" || value === "preference";
}

export interface MemoryNoteRow {
  id: number;
  content: string;
  createdAt: number;
  triggerAt: number | null;
  lastSurfacedAt: number | null;
  gaveUpAt: number | null;
  // The remembered entity this fact is about (a person, place, project...); null = about the user.
  entityId: number | null;
  kind: MemoryKind;
  source: MemorySource;
}

// Built per table alias so the FTS joins below (which need an `m.` prefix) share one column list.
function memoryNoteColumns(alias = ""): string {
  const p = alias ? `${alias}.` : "";
  return `${p}id AS id, ${p}content AS content, ${p}created_at AS createdAt, ${p}trigger_at AS triggerAt,
    ${p}last_surfaced_at AS lastSurfacedAt, ${p}gave_up_at AS gaveUpAt, ${p}entity_id AS entityId,
    ${p}kind AS kind, ${p}source AS source`;
}
const MEMORY_NOTE_COLUMNS = memoryNoteColumns();

// A fact stops being "active" once a newer fact supersedes it or the user asks to forget it. Both
// are soft markers (the row stays for auditing); every read the assistant or the Setup page sees
// filters on this.
function activeFact(alias = ""): string {
  const p = alias ? `${alias}.` : "";
  return `${p}superseded_at IS NULL AND ${p}forgotten_at IS NULL`;
}

export function inTransaction<T>(fn: () => T): T {
  return db.transaction(fn)();
}
```

Change `listMemoryNotes` to filter active facts:

```ts
export function listMemoryNotes(ownerId: number): MemoryNoteRow[] {
  return db
    .prepare(`SELECT ${MEMORY_NOTE_COLUMNS} FROM memory_notes WHERE owner_id = ? AND ${activeFact()} ORDER BY id DESC`)
    .all(ownerId) as MemoryNoteRow[];
}
```

After `addMemoryNote` add:

```ts
// The structured write path — remember and services/memoryExtraction.ts both come through here.
// supersedesId only ever retires an ACTIVE fact of the SAME owner (the WHERE clause is the guard),
// so a stale or hallucinated id silently supersedes nothing while the new fact still saves.
export function addFact(
  ownerId: number,
  input: {
    content: string;
    kind?: MemoryKind;
    source?: MemorySource;
    entityId?: number | null;
    supersedesId?: number | null;
  }
): MemoryNoteRow {
  return inTransaction(() => {
    const now = Date.now();
    const info = db
      .prepare(
        `INSERT INTO memory_notes (owner_id, content, created_at, entity_id, kind, source) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(ownerId, input.content, now, input.entityId ?? null, input.kind ?? "fact", input.source ?? "told");
    const id = Number(info.lastInsertRowid);
    if (input.supersedesId) {
      db.prepare(
        `UPDATE memory_notes SET superseded_at = ?, superseded_by = ?
         WHERE id = ? AND owner_id = ? AND ${activeFact()}`
      ).run(now, id, input.supersedesId, ownerId);
    }
    return db.prepare(`SELECT ${MEMORY_NOTE_COLUMNS} FROM memory_notes WHERE id = ?`).get(id) as MemoryNoteRow;
  });
}

// Returns the ids that actually changed — unknown, already-forgotten, and other owners' ids are
// skipped, so the assistant can report exactly what it forgot.
export function forgetFacts(ownerId: number, ids: number[]): number[] {
  const now = Date.now();
  const stmt = db.prepare(
    `UPDATE memory_notes SET forgotten_at = ? WHERE id = ? AND owner_id = ? AND ${activeFact()}`
  );
  return inTransaction(() => ids.filter((id) => stmt.run(now, id, ownerId).changes > 0));
}

// The always-in-the-prompt identity profile. Newest `limit` core facts, rendered oldest first so a
// new core fact appends to the end — the cached system block only changes when a core fact does.
export function listCoreProfile(ownerId: number, limit = 20): MemoryNoteRow[] {
  return db
    .prepare(
      `SELECT * FROM (
         SELECT ${MEMORY_NOTE_COLUMNS} FROM memory_notes
         WHERE owner_id = ? AND kind = 'core' AND ${activeFact()} ORDER BY id DESC LIMIT ?
       ) ORDER BY id ASC`
    )
    .all(ownerId, limit) as MemoryNoteRow[];
}

export function listActiveFactsForEntity(ownerId: number, entityId: number, limit = 20): MemoryNoteRow[] {
  return db
    .prepare(
      `SELECT ${MEMORY_NOTE_COLUMNS} FROM memory_notes
       WHERE owner_id = ? AND entity_id = ? AND ${activeFact()} ORDER BY id DESC LIMIT ?`
    )
    .all(ownerId, entityId, limit) as MemoryNoteRow[];
}

export function listNewestActiveFacts(
  ownerId: number,
  opts: { limit?: number; excludeCore?: boolean } = {}
): MemoryNoteRow[] {
  return db
    .prepare(
      `SELECT ${MEMORY_NOTE_COLUMNS} FROM memory_notes
       WHERE owner_id = ? AND ${activeFact()} ${opts.excludeCore ? "AND kind != 'core'" : ""}
       ORDER BY id DESC LIMIT ?`
    )
    .all(ownerId, opts.limit ?? 20) as MemoryNoteRow[];
}
```

Replace `searchMemoryNotes` with the shared implementation plus a thin wrapper:

```ts
// Words too common to say anything about which fact is relevant — only dropped in "any" mode,
// where ORing them in would match nearly every fact.
const SEARCH_STOPWORDS = new Set(
  ("a an and are as at be but by can do does for from had has have he her him his how i if in is it its " +
    "me my of on or our she so that the their them they this to up us was we were what when where which " +
    "who why will with you your about just also any tell know did get got")
    .split(" ")
);

// FTS5 search over active facts. Terms are extracted and re-quoted rather than passed to MATCH raw —
// FTS5's query syntax treats quotes/colons/NOT/OR etc. as operators, and a phrase from the model or
// forwarded user text containing any of those would otherwise throw instead of matching literally.
// mode "all" ANDs the terms (precise lookup: search_memory); "any" ORs them after dropping
// stopwords and ranks by bm25 (relevance retrieval: memoryRetrieval.ts, memoryExtraction.ts).
export function searchActiveFacts(
  ownerId: number,
  query: string,
  opts: { mode?: "all" | "any"; limit?: number; excludeCore?: boolean } = {}
): MemoryNoteRow[] {
  const mode = opts.mode ?? "all";
  let terms = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (mode === "any") {
    terms = [...new Set(terms.map((t) => t.toLowerCase()))].filter(
      (t) => t.length >= 2 && !SEARCH_STOPWORDS.has(t)
    );
  }
  if (terms.length === 0) return [];

  const matchQuery = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(mode === "all" ? " AND " : " OR ");
  return db
    .prepare(
      `SELECT ${memoryNoteColumns("m")}
       FROM memory_notes_fts f
       JOIN memory_notes m ON m.id = f.rowid
       WHERE f.memory_notes_fts MATCH ? AND m.owner_id = ? AND ${activeFact("m")}
         ${opts.excludeCore ? "AND m.kind != 'core'" : ""}
       ORDER BY rank
       LIMIT ?`
    )
    .all(matchQuery, ownerId, opts.limit ?? 10) as MemoryNoteRow[];
}

export function searchMemoryNotes(ownerId: number, query: string, limit = 10): MemoryNoteRow[] {
  return searchActiveFacts(ownerId, query, { mode: "all", limit });
}
```

In `searchReminderNotes`, replace its explicit `SELECT m.id, m.content, ... m.gave_up_at AS gaveUpAt` list with `SELECT ${memoryNoteColumns("m")}` so its rows match the extended `MemoryNoteRow` (leave its WHERE clause as is).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/db/memoryFacts.test.ts src/db/memoryNotesStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/store.ts src/db/memoryFacts.test.ts
git commit -m "feat: fact store API — kinds, sources, supersede, forget, core profile, ranked search"
```

---

### Task 3: Remembered entities with aliases and relations; rewire remember/recall_entity

**Files:**
- Modify: `server/src/db/store.ts` (the "remember → entities bridge" section ~line 2450–2530)
- Modify: `server/src/db/entities.test.ts` (the `describe("remember → entities bridge")` block)
- Modify: `server/src/ai/assistant.ts` (imports ~line 25; `remember` case ~line 1160; `recall_entity` case ~line 1286; `recall_entity` tool description ~line 605)
- Modify: `server/src/ai/assistant.test.ts` (`describe("remember tool — entity linking")`, `describe("recall_entity tool")`, `describe("remember + recall_entity end-to-end")`)

**Interfaces:**
- Consumes: `addFact`, `listActiveFactsForEntity` (Task 2).
- Produces:
  ```ts
  export interface RememberedEntityData { name: string; aliases: string[]; }
  export interface RememberedEntitySummary { id: number; type: string; name: string; aliases: string[]; updatedAt: number; }
  export interface EntityRelation { relation: string; direction: "out" | "in"; entity: { id: number; type: string; name: string }; }
  export function findOrCreateEntity(ownerId: number, type: string, name: string): EntityRow<RememberedEntityData>;   // unchanged signature
  export function findEntityByName(ownerId: number, name: string, type?: string): EntityRow<RememberedEntityData> | null; // now also matches aliases
  export function addEntityAlias(ownerId: number, entityId: number, alias: string): EntityRow<RememberedEntityData>;
  export function listRememberedEntities(ownerId: number): RememberedEntitySummary[];  // newest-updated first
  export function linkEntitiesOnce(ownerId: number, fromId: number, relation: string, toId: number): boolean; // true if created
  export function listEntityRelations(ownerId: number, entityId: number): EntityRelation[];  // remembered entities only
  ```
  `appendEntityNote` is deleted. `recall_entity` returns `{ entity: { id, type, name, aliases }, facts: { id, content, kind }[], related: EntityRelation[] }`.

- [ ] **Step 1: Update entity store tests (failing)**

In `server/src/db/entities.test.ts`: change the import list — remove `appendEntityNote`, add `addEntityAlias`, `listRememberedEntities`, `linkEntitiesOnce`, `listEntityRelations`. Then in `describe("remember → entities bridge")`:

Replace the first test's assertion:

```ts
    expect(entity.data).toEqual({ name: "Sarah", aliases: [] });
```

Replace the `appendEntityNote` test with these tests:

```ts
  it("addEntityAlias: adds a trimmed alias once, ignoring the name itself and duplicates", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("alias-add"));
    const entity = findOrCreateEntity(user.id, "person", "Sarah");
    addEntityAlias(user.id, entity.id, "  Sarah Jones ");
    addEntityAlias(user.id, entity.id, "sarah jones");
    const after = addEntityAlias(user.id, entity.id, "SARAH");
    expect(after.data.aliases).toEqual(["Sarah Jones"]);
  });

  it("findEntityByName: matches an alias, and findOrCreateEntity reuses the aliased entity", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("alias-find"));
    const entity = findOrCreateEntity(user.id, "person", "Sarah");
    addEntityAlias(user.id, entity.id, "Sarah Jones");
    expect(findEntityByName(user.id, "sarah jones")?.id).toBe(entity.id);
    expect(findOrCreateEntity(user.id, "person", "Sarah Jones").id).toBe(entity.id);
  });

  it("listRememberedEntities: lists only remembered entities with name and aliases", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("list-remembered"));
    saveEntity(user.id, {
      type: "booking",
      data: { kind: "hotel", name: "Hotel Eva", reference: "ABC", startDate: "2026-01-01", endDate: null },
    });
    const sarah = findOrCreateEntity(user.id, "person", "Sarah");
    expect(listRememberedEntities(user.id)).toEqual([
      { id: sarah.id, type: "person", name: "Sarah", aliases: [], updatedAt: sarah.updatedAt },
    ]);
  });

  it("linkEntitiesOnce: creates a labelled link once and never a self-link", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("link-once"));
    const sarah = findOrCreateEntity(user.id, "person", "Sarah");
    const acme = findOrCreateEntity(user.id, "organisation", "Acme");
    expect(linkEntitiesOnce(user.id, sarah.id, "works_at", acme.id)).toBe(true);
    expect(linkEntitiesOnce(user.id, sarah.id, "works_at", acme.id)).toBe(false);
    expect(linkEntitiesOnce(user.id, sarah.id, "works_at", sarah.id)).toBe(false);

    expect(listEntityRelations(user.id, sarah.id)).toEqual([
      { relation: "works_at", direction: "out", entity: { id: acme.id, type: "organisation", name: "Acme" } },
    ]);
    expect(listEntityRelations(user.id, acme.id)).toEqual([
      { relation: "works_at", direction: "in", entity: { id: sarah.id, type: "person", name: "Sarah" } },
    ]);
  });

  it("listEntityRelations: skips links to non-remembered entities", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("relations-skip"));
    const sarah = findOrCreateEntity(user.id, "person", "Sarah");
    const trip = saveEntity(user.id, { type: "trip", data: { name: "Lisbon trip" } });
    linkRecords(user.id, { relation: "belongs_to", from: { type: "entity", id: sarah.id }, to: { type: "entity", id: trip.id } });
    expect(listEntityRelations(user.id, sarah.id)).toEqual([]);
  });
```

- [ ] **Step 2: Update assistant tool tests (failing)**

In `server/src/ai/assistant.test.ts` add `listActiveFactsForEntity` to the `../db/store.js` import list. Then:

In `"with entity_name+entity_type: creates the entity and files the note onto it"` replace
`expect(entity?.data.notes).toEqual([expect.objectContaining({ text: "Handles invoicing" })]);` with:

```ts
    expect(listActiveFactsForEntity(user.id, entity!.id).map((f) => f.content)).toEqual(["Handles invoicing"]);
```

and replace the comment + assertion below it with:

```ts
    // One row, not two: the fact itself carries the entity.
    expect(listMemoryNotes(user.id).map((n) => n.content)).toEqual(["Handles invoicing"]);
```

In `"a second remember call for the same name appends onto the same entity"` replace the final assertion with:

```ts
    expect(listActiveFactsForEntity(user.id, entity!.id).map((f) => f.content)).toEqual([
      "Prefers email over calls",
      "Handles invoicing",
    ]);
```

In every `recall_entity` / end-to-end test, the result type changes. Replace the typed casts and assertions as follows:

```ts
    const result = (await runTool(user.id, "recall_entity", { entity_name: "Sarah" })) as {
      entity: { name: string };
      facts: { content: string }[];
      related: { relation: string; entity: { name: string } }[];
    };
    expect(result.entity.name).toBe("Sarah");
    expect(result.facts.map((f) => f.content)).toEqual(["Leads Project Falcon"]);
    expect(result.related.map((r) => r.entity.name)).toEqual(["Project Falcon"]);
```

(In `"returns the entity plus everything linked to it"`.) In `"respects an optional entity_type filter"` change `{ entity: { data: { name: string } } }` → `{ entity: { name: string } }` and `rightType.entity.data.name` → `rightType.entity.name`. In the mixed-owner test use `hit.entity.name` and `hit.facts.map((f) => f.content)` → `["Handles invoicing"]`. In the end-to-end test expect `result.facts.map((f) => f.content)` to equal `["Prefers email over calls", "Handles invoicing"]` (newest first) and `result.related.map((r) => r.entity.name)` to equal `["Project Falcon"]`.

In the `relates_to` tests, `getRelatedEntities(...).map((e) => e.data.name)` still works (entity data still has `name`) — leave them.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/db/entities.test.ts src/ai/assistant.test.ts`
Expected: FAIL — missing exports / `recall_entity` shape mismatch.

- [ ] **Step 4: Implement store changes**

In `server/src/db/store.ts`, replace the bridge section's `RememberedEntityData`, `findOrCreateEntity`, `appendEntityNote`, `isRememberedEntity` and `findEntityByName` with:

```ts
export interface RememberedEntityData {
  name: string;
  // Other names the same subject goes by ("Sarah Jones" for "Sarah") — matched by findEntityByName
  // and retrieval so the extractor and remember converge on one entity instead of near-duplicates.
  aliases: string[];
}

export interface RememberedEntitySummary {
  id: number;
  type: string;
  name: string;
  aliases: string[];
  updatedAt: number;
}

export interface EntityRelation {
  relation: string;
  direction: "out" | "in";
  entity: { id: number; type: string; name: string };
}

function normalizeEntityName(name: string): string {
  return name.trim().toLowerCase();
}

// Narrows an entity's untyped `data` down to RememberedEntityData — required because
// listEntities(ownerId, {}) returns entities of every type, including document-extracted ones
// (travel_checkin, trip, expense, booking) whose data shape is unrelated. A `name` string alone
// isn't enough (booking also has one); the `aliases` array is what no document-extracted type has.
function isRememberedEntity(data: unknown): data is RememberedEntityData {
  return (
    typeof data === "object" &&
    data !== null &&
    typeof (data as RememberedEntityData).name === "string" &&
    Array.isArray((data as RememberedEntityData).aliases)
  );
}

function listRememberedEntityRows(ownerId: number, type?: string): EntityRow<RememberedEntityData>[] {
  return listEntities<unknown>(ownerId, type ? { type } : {}).filter(
    (e): e is EntityRow<RememberedEntityData> => isRememberedEntity(e.data)
  );
}

// Dedupes by owner+type+lowercased name-or-alias so the same subject mentioned across separate
// remember calls or extraction batches accumulates onto one entity.
export function findOrCreateEntity(
  ownerId: number,
  type: string,
  name: string
): EntityRow<RememberedEntityData> {
  const existing = findEntityByName(ownerId, name, type);
  if (existing) return existing;
  const trimmed = name.trim();
  if (!trimmed) throw new Error("findOrCreateEntity: name must not be blank");
  return saveEntity<RememberedEntityData>(ownerId, { type, data: { name: trimmed, aliases: [] } });
}

// Case-insensitive exact match on name or any alias, optionally narrowed to one type.
export function findEntityByName(
  ownerId: number,
  name: string,
  type?: string
): EntityRow<RememberedEntityData> | null {
  const normalized = normalizeEntityName(name);
  if (!normalized) return null;
  return (
    listRememberedEntityRows(ownerId, type).find((e) =>
      [e.data.name, ...e.data.aliases].some((n) => normalizeEntityName(n) === normalized)
    ) ?? null
  );
}

export function addEntityAlias(ownerId: number, entityId: number, alias: string): EntityRow<RememberedEntityData> {
  const entity = getEntity<RememberedEntityData>(ownerId, entityId);
  if (!entity || !isRememberedEntity(entity.data)) throw new Error(`remembered entity ${entityId} not found`);
  const trimmed = alias.trim();
  const known = [entity.data.name, ...entity.data.aliases].map(normalizeEntityName);
  if (!trimmed || known.includes(normalizeEntityName(trimmed))) return entity;
  return updateEntity<RememberedEntityData>(ownerId, entityId, {
    data: { ...entity.data, aliases: [...entity.data.aliases, trimmed] },
  });
}

export function listRememberedEntities(ownerId: number): RememberedEntitySummary[] {
  return listRememberedEntityRows(ownerId)
    .map((e) => ({ id: e.id, type: e.type, name: e.data.name, aliases: e.data.aliases, updatedAt: e.updatedAt }))
    .sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id);
}

// Entity→entity link with a free-text relation ("works_at", "sister_of"), created at most once
// per (from, relation, to). Returns whether a new link was written.
export function linkEntitiesOnce(ownerId: number, fromId: number, relation: string, toId: number): boolean {
  if (fromId === toId) return false;
  const exists = getLinksFrom(ownerId, "entity", fromId).some(
    (l) => l.relation === relation && l.toType === "entity" && l.toId === toId
  );
  if (exists) return false;
  linkRecords(ownerId, { relation, from: { type: "entity", id: fromId }, to: { type: "entity", id: toId } });
  return true;
}

// Both directions of every link between this entity and another REMEMBERED entity — trips,
// documents and other document-extracted entities are deliberately left out of memory output.
export function listEntityRelations(ownerId: number, entityId: number): EntityRelation[] {
  const toRelation = (relation: string, direction: "out" | "in", otherId: number): EntityRelation | null => {
    const other = getEntity<unknown>(ownerId, otherId);
    if (!other || !isRememberedEntity(other.data)) return null;
    return { relation, direction, entity: { id: other.id, type: other.type, name: other.data.name } };
  };
  const out = getLinksFrom(ownerId, "entity", entityId)
    .filter((l) => l.toType === "entity")
    .map((l) => toRelation(l.relation, "out", l.toId));
  const incoming = getLinksTo(ownerId, "entity", entityId)
    .filter((l) => l.fromType === "entity")
    .map((l) => toRelation(l.relation, "in", l.fromId));
  return [...out, ...incoming].filter((r): r is EntityRelation => r !== null);
}
```

- [ ] **Step 5: Rewire `remember` and `recall_entity` in assistant.ts**

In the `../db/store.js` import list replace `appendEntityNote,` with `addFact, listActiveFactsForEntity, linkEntitiesOnce, listEntityRelations,` (remove `linkRecords`/`getLinksFrom` from the import only if nothing else in assistant.ts uses them — check with grep before removing).

Replace the `case "remember": { ... }` body with:

```ts
    case "remember": {
      const note = input.note as string;
      const entityName = (input.entity_name as string | undefined)?.trim();
      const entityType = (input.entity_type as string | undefined)?.trim();
      const entity = entityName && entityType ? findOrCreateEntity(ownerId, entityType, entityName) : null;

      addFact(ownerId, { content: note, source: "told", entityId: entity?.id ?? null });

      if (entity) {
        for (const otherName of (input.relates_to as string[] | undefined) ?? []) {
          const other = findEntityByName(ownerId, otherName);
          if (other) linkEntitiesOnce(ownerId, entity.id, "relates_to", other.id);
        }
      }
      return { ok: true };
    }
```

Replace the `case "recall_entity": { ... }` body with:

```ts
    case "recall_entity": {
      const entityName = input.entity_name as string;
      const entityType = input.entity_type as string | undefined;
      const entity = findEntityByName(ownerId, entityName, entityType);
      if (!entity) return { error: `no entity found matching "${entityName}"` };
      return {
        entity: { id: entity.id, type: entity.type, name: entity.data.name, aliases: entity.data.aliases },
        facts: listActiveFactsForEntity(ownerId, entity.id).map((f) => ({ id: f.id, content: f.content, kind: f.kind })),
        related: listEntityRelations(ownerId, entity.id),
      };
    }
```

Update the `recall_entity` tool description to:

```ts
      "Look up everything remembered about a specific person, place, project, or other named subject in one call — its facts (each with an id you can pass to remember's replaces_id or forget_memory) plus the other remembered people/places/things it's linked to and how. Use this instead of search_memory when the user asks about a specific named thing, e.g. 'what do you know about Sarah'.",
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/db/entities.test.ts src/ai/assistant.test.ts src/db/migrations/memoryGraph.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck**

Run: `npm run build`
Expected: exits 0 (no remaining references to `appendEntityNote` or `data.notes`).

- [ ] **Step 8: Commit**

```bash
git add src/db/store.ts src/db/entities.test.ts src/ai/assistant.ts src/ai/assistant.test.ts
git commit -m "feat: remembered entities get aliases and labelled relations; facts carry their entity"
```

---

### Task 4: Chat controls — remember kind/replaces_id/relation, forget_memory, search_memory, rules

**Files:**
- Modify: `server/src/ai/assistant.ts` (`search_memory` tool ~line 450, `remember` tool ~line 573, new `forget_memory` tool next to `remember` in `ALWAYS_ON_TOOLS`, `runTool` cases, `buildRules` base list ~line 1680)
- Modify: `server/src/ai/assistant.test.ts`

**Interfaces:**
- Consumes: `addFact`, `forgetFacts`, `isMemoryKind`, `listCoreProfile`, `listNewestActiveFacts`, `searchActiveFacts`, `getEntity` (store).
- Produces: tool `forget_memory { ids: number[] }` → `{ forgotten: number[] }`; `remember` accepts `kind`, `replaces_id`, `relation`; `search_memory` returns `{ id, content, kind, entity?: string }[]` and accepts an empty/absent `query`.

- [ ] **Step 1: Write the failing tests**

Add `listCoreProfile, searchMemoryNotes, addFact` to the store import in `assistant.test.ts` (keep existing ones), then append:

```ts
describe("remember — kind, replaces_id, relation", () => {
  it("files a core fact when kind is core", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("remember-kind-core"));
    await runTool(user.id, "remember", { note: "The user's name is Sam", kind: "core" });
    expect(listCoreProfile(user.id).map((f) => f.content)).toEqual(["The user's name is Sam"]);
  });

  it("an unknown kind falls back to fact", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("remember-kind-bad"));
    await runTool(user.id, "remember", { note: "Something", kind: "banana" });
    expect(listMemoryNotes(user.id)[0].kind).toBe("fact");
  });

  it("replaces_id supersedes the old fact", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("remember-replaces"));
    const old = addFact(user.id, { content: "Lives in Paris", kind: "core" });
    await runTool(user.id, "remember", { note: "Lives in London", kind: "core", replaces_id: old.id });
    expect(listCoreProfile(user.id).map((f) => f.content)).toEqual(["Lives in London"]);
  });

  it("replaces_id with another owner's fact id supersedes nothing", async () => {
    const owner = findOrCreateUserByEmail(uniqueEmail("remember-replaces-owner"));
    const intruder = findOrCreateUserByEmail(uniqueEmail("remember-replaces-intruder"));
    const theirs = addFact(owner.id, { content: "Owner's fact" });
    await runTool(intruder.id, "remember", { note: "Mine", replaces_id: theirs.id });
    expect(listMemoryNotes(owner.id).map((f) => f.id)).toEqual([theirs.id]);
  });

  it("relation labels the relates_to links", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("remember-relation"));
    await runTool(user.id, "remember", { note: "Acme is a client", entity_name: "Acme", entity_type: "organisation" });
    await runTool(user.id, "remember", {
      note: "Sarah works at Acme",
      entity_name: "Sarah",
      entity_type: "person",
      relates_to: ["Acme"],
      relation: "works_at",
    });
    const result = (await runTool(user.id, "recall_entity", { entity_name: "Sarah" })) as {
      related: { relation: string; entity: { name: string } }[];
    };
    expect(result.related).toEqual([expect.objectContaining({ relation: "works_at", entity: expect.objectContaining({ name: "Acme" }) })]);
  });
});

describe("forget_memory tool", () => {
  it("is always available", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("forget-toollist"));
    expect(buildToolsForOwner(user.id).map((t) => t.name)).toContain("forget_memory");
  });

  it("forgets this owner's facts and reports which ids", async () => {
    const owner = findOrCreateUserByEmail(uniqueEmail("forget-tool-owner"));
    const other = findOrCreateUserByEmail(uniqueEmail("forget-tool-other"));
    const mine = addFact(owner.id, { content: "Allergic to shellfish" });
    const theirs = addFact(other.id, { content: "Allergic to peanuts" });

    const result = await runTool(owner.id, "forget_memory", { ids: [mine.id, theirs.id] });

    expect(result).toEqual({ forgotten: [mine.id] });
    expect(searchMemoryNotes(owner.id, "shellfish")).toEqual([]);
    expect(listMemoryNotes(other.id)).toHaveLength(1);
  });

  it("tolerates a missing or malformed ids array", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("forget-tool-bad"));
    expect(await runTool(user.id, "forget_memory", {})).toEqual({ forgotten: [] });
    expect(await runTool(user.id, "forget_memory", { ids: ["x", 1.5] })).toEqual({ forgotten: [] });
  });
});

describe("search_memory — ids, kinds, entity names, empty query", () => {
  it("returns id, content, kind and entity name", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("search-shape"));
    await runTool(user.id, "remember", { note: "Sarah handles invoicing", entity_name: "Sarah", entity_type: "person" });
    const results = (await runTool(user.id, "search_memory", { query: "invoicing" })) as unknown[];
    expect(results).toEqual([
      { id: expect.any(Number), content: "Sarah handles invoicing", kind: "fact", entity: "Sarah" },
    ]);
  });

  it("falls back to any-term matching when an all-terms search finds nothing", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("search-fallback"));
    await runTool(user.id, "remember", { note: "Allergic to shellfish" });
    const results = (await runTool(user.id, "search_memory", { query: "shellfish lobster allergy" })) as { content: string }[];
    expect(results.map((r) => r.content)).toEqual(["Allergic to shellfish"]);
  });

  it("with no query returns the core profile plus newest other facts", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("search-empty"));
    await runTool(user.id, "remember", { note: "Name is Sam", kind: "core" });
    await runTool(user.id, "remember", { note: "Likes jazz", kind: "preference" });
    const results = (await runTool(user.id, "search_memory", {})) as { content: string }[];
    expect(results.map((r) => r.content)).toEqual(["Name is Sam", "Likes jazz"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/ai/assistant.test.ts -t "kind, replaces_id|forget_memory|search_memory —"`
Expected: FAIL.

- [ ] **Step 3: Implement**

`remember` tool schema — add to `properties` (keep existing ones):

```ts
        kind: {
          type: "string",
          enum: ["core", "fact", "preference"],
          description:
            "Optional, default 'fact'. 'core' only for identity-level facts about the user that should " +
            "always be in mind (their name, partner/children/close family, home city, job/employer, a " +
            "strong standing preference). 'preference' for likes/dislikes/how they want things done.",
        },
        replaces_id: {
          type: "number",
          description:
            "Optional. When this note corrects or updates something you already remember, the id of " +
            "that old fact (from the [#id] tags or search_memory/recall_entity results) — the old fact " +
            "is retired instead of kept alongside the new one.",
        },
        relation: {
          type: "string",
          description:
            "Optional, default 'relates_to'. How this entity relates to the relates_to entities, in " +
            "snake_case, e.g. 'works_at', 'sister_of', 'lives_in', 'manages'.",
        },
```

New tool, added to `ALWAYS_ON_TOOLS` directly after `remember`:

```ts
  {
    name: "forget_memory",
    description:
      "Forget remembered facts the user says are wrong or asks you to forget. Pass the ids from the " +
      "[#id] tags or search_memory/recall_entity results. Then tell the user plainly what you forgot. " +
      "If something merely changed (they moved, changed jobs), use remember with replaces_id instead.",
    input_schema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "number" }, description: "Fact ids to forget" },
      },
      required: ["ids"],
    },
  },
```

`search_memory` tool — replace description and schema:

```ts
    name: "search_memory",
    description:
      "Search everything you remember about the user — older facts that aren't in your current " +
      "context are still here. Call it when the user refers to something they told you before that " +
      "you don't see, e.g. 'what did I say my allergy was'. Call it with no query for 'what do you " +
      "know about me' — that returns their core profile plus the most recent other facts. Results " +
      "carry ids for remember's replaces_id and forget_memory.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keyword(s) to search for; omit to list what you know" },
        limit: { type: "number", description: "Max facts to return, default 10" },
      },
      required: [],
    },
```

In `runTool`, update the `remember` case (from Task 3) to pass kind/supersede/relation:

```ts
    case "remember": {
      const note = input.note as string;
      const entityName = (input.entity_name as string | undefined)?.trim();
      const entityType = (input.entity_type as string | undefined)?.trim();
      const entity = entityName && entityType ? findOrCreateEntity(ownerId, entityType, entityName) : null;
      const replacesId = input.replaces_id;

      addFact(ownerId, {
        content: note,
        kind: isMemoryKind(input.kind) ? input.kind : "fact",
        source: "told",
        entityId: entity?.id ?? null,
        supersedesId: typeof replacesId === "number" && Number.isInteger(replacesId) ? replacesId : null,
      });

      if (entity) {
        const relation = (input.relation as string | undefined)?.trim() || "relates_to";
        for (const otherName of (input.relates_to as string[] | undefined) ?? []) {
          const other = findEntityByName(ownerId, otherName);
          if (other) linkEntitiesOnce(ownerId, entity.id, relation, other.id);
        }
      }
      return { ok: true };
    }
```

Add a `forget_memory` case next to it:

```ts
    case "forget_memory": {
      const ids = Array.isArray(input.ids)
        ? (input.ids as unknown[]).filter((id): id is number => typeof id === "number" && Number.isInteger(id))
        : [];
      return { forgotten: forgetFacts(ownerId, ids) };
    }
```

Replace the `search_memory` case:

```ts
    case "search_memory": {
      const query = ((input.query as string | undefined) ?? "").trim();
      const limit = (input.limit as number | undefined) ?? SEARCH_MEMORY_DEFAULT_LIMIT;
      let facts: MemoryNoteRow[];
      if (!query) {
        facts = [...listCoreProfile(ownerId), ...listNewestActiveFacts(ownerId, { limit: 20, excludeCore: true })];
      } else {
        facts = searchActiveFacts(ownerId, query, { mode: "all", limit });
        if (facts.length === 0) facts = searchActiveFacts(ownerId, query, { mode: "any", limit });
      }
      return facts.map((f) => factForModel(ownerId, f));
    }
```

Add this helper near `forModel` in assistant.ts:

```ts
// The shape every memory-reading tool hands the model: the id is what makes replaces_id and
// forget_memory usable; the entity name saves a recall_entity round-trip just to learn who a fact is about.
function factForModel(ownerId: number, fact: MemoryNoteRow) {
  const entity = fact.entityId ? getEntity<{ name?: unknown }>(ownerId, fact.entityId) : null;
  return {
    id: fact.id,
    content: fact.content,
    kind: fact.kind,
    ...(typeof entity?.data.name === "string" ? { entity: entity.data.name } : {}),
  };
}
```

Add to the store import: `forgetFacts, isMemoryKind, listCoreProfile, listNewestActiveFacts, searchActiveFacts, getEntity, type MemoryNoteRow` (skip any already imported; remove the now-unused `searchMemoryNotes` import if nothing else uses it — check with grep).

In `buildRules`' `base` array, replace the two existing remember lines (the "Use the remember tool proactively..." line and the "When a remember note is about a specific, nameable..." line) with:

```ts
    "- Use the remember tool proactively whenever the user shares something worth recalling later (preferences, which account is which, standing instructions, people in their life) — don't wait to be asked. Use kind 'core' only for identity-level facts (their name, partner/children/close family, home city, job/employer).",
    "- When a remember note is about a specific, nameable, recurring subject (a person, place, organisation, project) the user might ask about again by name, pass entity_name + entity_type on that same remember call; when it relates two such subjects, pass relates_to plus a relation like 'works_at'. Use recall_entity (not search_memory) when the user asks about that subject by name.",
    "- When the user corrects or updates something you remember (they moved, changed jobs, you had it wrong), call remember with replaces_id set to the old fact's id rather than saving a second, conflicting fact. When they say something you remember is wrong or ask you to forget it, call forget_memory and tell them what you forgot.",
    "- For 'what do you know about me', call search_memory with no query. Otherwise don't recite remembered facts unprompted — just use them.",
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/ai/assistant.test.ts`
Expected: PASS (including the pre-existing `search_memory tool` tests — their `content` assertions still hold).

- [ ] **Step 5: Commit**

```bash
git add src/ai/assistant.ts src/ai/assistant.test.ts
git commit -m "feat: correct and forget memories from chat; search_memory returns ids and lists the profile"
```

---

### Task 5: Per-message retrieval

**Files:**
- Create: `server/src/ai/memoryRetrieval.ts`
- Create: `server/src/ai/memoryRetrieval.test.ts`

**Interfaces:**
- Consumes: `listRememberedEntities`, `listActiveFactsForEntity`, `listEntityRelations`, `searchActiveFacts` (store).
- Produces:
  ```ts
  export const RELEVANT_MEMORY_HEADER: string;
  export function mentionsName(text: string, name: string): boolean;
  export function retrieveRelevantMemory(ownerId: number, text: string): string | null;
  ```

- [ ] **Step 1: Write the failing test**

`server/src/ai/memoryRetrieval.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { retrieveRelevantMemory, mentionsName, RELEVANT_MEMORY_HEADER } from "./memoryRetrieval.js";
import {
  findOrCreateUserByEmail,
  findOrCreateEntity,
  addEntityAlias,
  addFact,
  forgetFacts,
  linkEntitiesOnce,
} from "../db/store.js";

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

describe("mentionsName", () => {
  it("matches whole words case-insensitively", () => {
    expect(mentionsName("is sam coming?", "Sam")).toBe(true);
    expect(mentionsName("my Samsung broke", "Sam")).toBe(false);
    expect(mentionsName("ask Sarah Jones", "sarah jones")).toBe(true);
  });

  it("treats regex metacharacters in names literally", () => {
    expect(() => mentionsName("anything", "C++ (Guild)")).not.toThrow();
    expect(mentionsName("meeting at C++ (Guild) today", "C++ (Guild)")).toBe(true);
    expect(mentionsName("Dr. Who is on", "Dr. Who")).toBe(true);
    expect(mentionsName("DrX Who is on", "Dr. Who")).toBe(false);
  });

  it("never matches a blank name", () => {
    expect(mentionsName("anything", "  ")).toBe(false);
  });
});

describe("retrieveRelevantMemory", () => {
  it("returns null when nothing matches", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("retrieve-none"));
    addFact(user.id, { content: "Likes jazz" });
    expect(retrieveRelevantMemory(user.id, "what's the weather")).toBeNull();
  });

  it("pulls a mentioned entity's facts (with ids) and its relations", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("retrieve-entity"));
    const sarah = findOrCreateEntity(user.id, "person", "Sarah");
    const acme = findOrCreateEntity(user.id, "organisation", "Acme");
    linkEntitiesOnce(user.id, sarah.id, "works_at", acme.id);
    const fact = addFact(user.id, { content: "Sarah is the user's accountant", entityId: sarah.id });

    const block = retrieveRelevantMemory(user.id, "can you email sarah about the invoice")!;

    expect(block.startsWith(RELEVANT_MEMORY_HEADER)).toBe(true);
    expect(block).toContain(`- [#${fact.id}] Sarah is the user's accountant`);
    expect(block).toContain("- Sarah —works_at→ Acme");
  });

  it("matches an entity by alias", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("retrieve-alias"));
    const anna = findOrCreateEntity(user.id, "person", "Anna");
    addEntityAlias(user.id, anna.id, "my wife");
    addFact(user.id, { content: "Anna is vegetarian", entityId: anna.id });
    expect(retrieveRelevantMemory(user.id, "book dinner for me and my wife")).toContain("Anna is vegetarian");
  });

  it("finds unlinked facts by keyword, skipping core, forgotten and other owners' facts", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("retrieve-fts"));
    const other = findOrCreateUserByEmail(uniqueEmail("retrieve-fts-other"));
    addFact(user.id, { content: "Allergic to shellfish" });
    addFact(user.id, { content: "Lives near the shellfish market", kind: "core" });
    const gone = addFact(user.id, { content: "Loves shellfish platters" });
    forgetFacts(user.id, [gone.id]);
    addFact(other.id, { content: "Other person's shellfish fact" });

    const block = retrieveRelevantMemory(user.id, "any good shellfish places?")!;

    expect(block).toContain("Allergic to shellfish");
    expect(block).not.toContain("market");
    expect(block).not.toContain("platters");
    expect(block).not.toContain("Other person");
  });

  it("caps output at 12 facts", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("retrieve-cap"));
    const bob = findOrCreateEntity(user.id, "person", "Bob");
    for (let i = 0; i < 20; i++) addFact(user.id, { content: `Bob fact number ${i} about tennis`, entityId: bob.id });
    const block = retrieveRelevantMemory(user.id, "tennis with Bob")!;
    expect(block.split("\n").filter((l) => l.startsWith("- [#")).length).toBeLessThanOrEqual(12);
  });

  it("returns null for blank text", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("retrieve-blank"));
    expect(retrieveRelevantMemory(user.id, "   ")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ai/memoryRetrieval.test.ts`
Expected: FAIL — cannot resolve `./memoryRetrieval.js`.

- [ ] **Step 3: Implement**

`server/src/ai/memoryRetrieval.ts`:

```ts
// Per-message memory retrieval: the facts relevant to what the user just said, injected into the
// latest user message by runAssistantChat (never the cached system block — see the spec
// docs/superpowers/specs/2026-09-23-personal-memory-graph-design.md §3). Pure SQLite, no LLM call:
// remembered entities mentioned by name/alias pull their facts and relations; everything else comes
// from an OR/bm25 full-text search. Core facts are skipped — they're already in the system prompt.
import {
  listRememberedEntities,
  listActiveFactsForEntity,
  listEntityRelations,
  searchActiveFacts,
  type MemoryNoteRow,
} from "../db/store.js";

export const RELEVANT_MEMORY_HEADER =
  "Relevant things you remember (background from memory, not part of the user's message — use only if relevant):";

const MAX_MATCHED_ENTITIES = 3;
const FACTS_PER_ENTITY = 5;
const FTS_LIMIT = 8;
const MAX_FACTS = 12;
const MAX_CHARS = 1500;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Whole-word, case-insensitive: "Sam" must not match "Samsung". Lookarounds on letters/digits
// rather than \b, because \b is ASCII-only and names aren't.
export function mentionsName(text: string, name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(trimmed)}(?![\\p{L}\\p{N}])`, "iu").test(text);
}

export function retrieveRelevantMemory(ownerId: number, text: string): string | null {
  if (!text.trim()) return null;

  const lines: string[] = [];
  const seenFacts = new Set<number>();
  let chars = 0;
  let factCount = 0;

  const pushLine = (line: string): boolean => {
    if (chars + line.length + 1 > MAX_CHARS) return false;
    lines.push(line);
    chars += line.length + 1;
    return true;
  };
  const pushFact = (fact: MemoryNoteRow) => {
    if (fact.kind === "core" || seenFacts.has(fact.id) || factCount >= MAX_FACTS) return;
    if (pushLine(`- [#${fact.id}] ${fact.content}`)) {
      seenFacts.add(fact.id);
      factCount += 1;
    }
  };

  const matched = listRememberedEntities(ownerId)
    .map((entity) => {
      const hits = [entity.name, ...entity.aliases].filter((n) => mentionsName(text, n));
      return { entity, longest: Math.max(0, ...hits.map((h) => h.length)) };
    })
    .filter((m) => m.longest > 0)
    .sort((a, b) => b.longest - a.longest)
    .slice(0, MAX_MATCHED_ENTITIES);

  for (const { entity } of matched) {
    for (const fact of listActiveFactsForEntity(ownerId, entity.id, FACTS_PER_ENTITY)) pushFact(fact);
    for (const rel of listEntityRelations(ownerId, entity.id)) {
      pushLine(
        rel.direction === "out"
          ? `- ${entity.name} —${rel.relation}→ ${rel.entity.name}`
          : `- ${rel.entity.name} —${rel.relation}→ ${entity.name}`
      );
    }
  }

  for (const fact of searchActiveFacts(ownerId, text, { mode: "any", limit: FTS_LIMIT, excludeCore: true })) {
    pushFact(fact);
  }

  return lines.length ? [RELEVANT_MEMORY_HEADER, ...lines].join("\n") : null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/ai/memoryRetrieval.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ai/memoryRetrieval.ts src/ai/memoryRetrieval.test.ts
git commit -m "feat: retrieve the memories relevant to a message by entity mention and ranked search"
```

---

### Task 6: Core profile in the system prompt; injection and stable-history cache breakpoint

**Files:**
- Modify: `server/src/ai/assistant.ts` (`buildSystemPrompt` ~line 1711; `withMessagesCacheBreakpoint` ~line 1818; `runAssistantChat` ~line 1845; imports)
- Modify: `server/src/db/store.ts` (delete `listRecentMemoryNotes`)
- Modify: `server/src/ai/assistant.test.ts` (the system-prompt memory tests ~lines 190–222)
- Modify: `server/src/ai/assistant.cacheBreakpoint.test.ts`

**Interfaces:**
- Consumes: `listCoreProfile` (Task 2), `retrieveRelevantMemory` (Task 5).
- Produces: system prompt section headed `What you know about the user (core profile).`; requests carry ≤4 breakpoints.

- [ ] **Step 1: Replace the prompt memory tests (failing)**

In `assistant.test.ts`, delete the three tests `"annotates a memory note that has an armed (not-yet-sent) trigger"`, `"annotates a memory note whose trigger already fired as already sent"`, `"renders an ordinary note with no triggerAt as a plain line with no annotation"`, and add (inside the same `describe`):

```ts
  it("renders active core facts as the profile and leaves other facts out of the system prompt", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("prompt-core-profile"));
    addFact(user.id, { content: "The user's name is Sam", kind: "core" });
    addFact(user.id, { content: "Likes jazz", kind: "preference" });
    const prompt = buildSystemPrompt(user.id);
    expect(prompt).toContain("What you know about the user (core profile)");
    expect(prompt).toContain("- The user's name is Sam");
    expect(prompt).not.toContain("Likes jazz");
  });

  it("shows a placeholder when there is no core profile yet", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("prompt-core-empty"));
    expect(buildSystemPrompt(user.id)).toContain("(nothing known yet)");
  });

  it("is byte-identical after a non-core fact is added (system cache stays warm)", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("prompt-core-stable"));
    addFact(user.id, { content: "The user's name is Sam", kind: "core" });
    const before = buildSystemPrompt(user.id);
    addFact(user.id, { content: "Bought a new bike", kind: "fact" });
    expect(buildSystemPrompt(user.id)).toBe(before);
  });
```

Remove `addMemoryNote` / `markMemorySurfaced` from the import list if no other test in the file uses them (grep first). Keep the existing `"frames memory as something the assistant may proactively volunteer"` test unchanged — the new wording keeps the phrase "may naturally bring up".

- [ ] **Step 2: Add cache/injection tests (failing)**

Append to `assistant.cacheBreakpoint.test.ts` (add `addFact, findOrCreateEntity` to the store import):

```ts
type Block = { type: string; text?: string; cache_control?: unknown };
function blocksOf(m: Anthropic.MessageParam): Block[] {
  return typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as Block[]);
}
function stripCache(m: Anthropic.MessageParam) {
  return { role: m.role, content: blocksOf(m).map(({ cache_control: _c, ...rest }) => rest) };
}

describe("runAssistantChat — relevant-memory injection and stable-history breakpoint", () => {
  it("injects relevant memory as a leading block of the latest user message only", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } });
    const user = findOrCreateUserByEmail(uniqueEmail("inject-latest"));
    const sarah = findOrCreateEntity(user.id, "person", "Sarah");
    addFact(user.id, { content: "Sarah is the user's accountant", entityId: sarah.id });

    await runAssistantChat(user.id, [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi!" },
      { role: "user", content: "email Sarah" },
    ]);

    const messages = sentMessages(0);
    const latest = blocksOf(messages[2]);
    expect(latest).toHaveLength(2);
    expect(latest[0].text).toContain("Sarah is the user's accountant");
    expect(latest[1].text).toBe("email Sarah");
    expect(blocksOf(messages[0]).some((b) => b.text?.includes("accountant"))).toBe(false);
  });

  it("puts a breakpoint on the message before the latest user message, and at most two in messages", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } });
    const user = findOrCreateUserByEmail(uniqueEmail("stable-bp"));

    await runAssistantChat(user.id, [
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
      { role: "user", content: "three" },
    ]);

    const messages = sentMessages(0);
    const marked = messages.flatMap((m, i) => blocksOf(m).filter((b) => b.cache_control).map(() => i));
    expect(marked).toEqual([1, 2]);
  });

  it("keeps the history prefix byte-identical across turns while the injected block changes", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } });
    const user = findOrCreateUserByEmail(uniqueEmail("stable-prefix"));
    const sarah = findOrCreateEntity(user.id, "person", "Sarah");
    addFact(user.id, { content: "Sarah is the user's accountant", entityId: sarah.id });

    const turn1 = [
      { role: "user" as const, content: "hello" },
      { role: "assistant" as const, content: "hi!" },
      { role: "user" as const, content: "email Sarah" },
    ];
    await runAssistantChat(user.id, turn1);
    await runAssistantChat(user.id, [
      ...turn1,
      { role: "assistant" as const, content: "done" },
      { role: "user" as const, content: "thanks" },
    ]);

    const first = sentMessages(0);
    const second = sentMessages(1);
    // Prefix through the first call's stable breakpoint (index 1) is identical in the second call.
    expect(second.slice(0, 2).map(stripCache)).toEqual(first.slice(0, 2).map(stripCache));
    // The earlier user message no longer carries the injected block in the later call.
    expect(stripCache(second[2])).toEqual({ role: "user", content: [{ type: "text", text: "email Sarah" }] });
  });

  it("sends the system prompt without any per-message memory in it", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } });
    const user = findOrCreateUserByEmail(uniqueEmail("system-no-retrieval"));
    const sarah = findOrCreateEntity(user.id, "person", "Sarah");
    addFact(user.id, { content: "Sarah is the user's accountant", entityId: sarah.id });

    await runAssistantChat(user.id, [{ role: "user", content: "email Sarah" }]);

    const system = mockCreate.mock.calls[0][0].system as { text: string }[];
    expect(system[0].text).not.toContain("accountant");
  });
});
```

Note: the third test's `stripCache(second[2])` compares against a block array — `stripCache` normalises string content into one text block, so it passes whether the implementation sends that message as a string or a block array.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/ai/assistant.cacheBreakpoint.test.ts src/ai/assistant.test.ts -t "core profile|placeholder|byte-identical|injection|breakpoint"`
Expected: FAIL.

- [ ] **Step 4: Implement the core profile**

In `buildSystemPrompt`, replace the `const memories = listRecentMemoryNotes(ownerId).reverse(); const memoryList = ...;` block with:

```ts
  // Only the small, identity-level core profile lives in the cached system block — it changes a
  // few times a month, so this block is rarely rewritten. Everything else the assistant remembers
  // is retrieved per message (ai/memoryRetrieval.ts) and injected outside the cached prefix.
  const coreProfile = listCoreProfile(ownerId);
  const coreList = coreProfile.length
    ? coreProfile.map((f) => `- ${f.content}`).join("\n")
    : "(nothing known yet)";
```

and replace the `Things you remember about the user...${memoryList}` array entry with:

```ts
    `What you know about the user (core profile). You may naturally bring up one of these when it's ` +
      `genuinely relevant to what's being discussed — the way someone who was actually paying ` +
      `attention would — without forcing it. Other things you remember are shown alongside the ` +
      `user's latest message when relevant, and search_memory reaches the rest:\n${coreList}`,
```

Update imports: remove `listRecentMemoryNotes`, add `listCoreProfile` (if not already added in Task 4), add `import { retrieveRelevantMemory } from "./memoryRetrieval.js";`.

Delete `listRecentMemoryNotes` (and its comment) from `store.ts`. Run `grep -rn listRecentMemoryNotes src` — expect no hits.

- [ ] **Step 5: Implement injection and the stable-history breakpoint**

Replace `withMessagesCacheBreakpoint` and its comment with:

```ts
function withCacheControlOnLastBlock(message: Anthropic.MessageParam): Anthropic.MessageParam {
  const blocks =
    typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
  if (blocks.length === 0) return message;
  return {
    ...message,
    content: blocks.map((block, i) =>
      i === blocks.length - 1 ? { ...block, cache_control: { type: "ephemeral" as const, ttl: "1h" as const } } : block
    ),
  };
}

// Two breakpoints inside `messages` (tools + system use the other two of Anthropic's four):
// - the LAST block of the last message, so each tool-loop turn within one reply reads every
//   earlier turn back at the cached rate (feature-to-do/token-cost-reduction.md #2);
// - `stableIndex`: the message just before the latest user message. The latest user message
//   carries a per-message relevant-memory block (ai/memoryRetrieval.ts) that is never stored in
//   history, so the NEXT user turn's prefix diverges there — this breakpoint caches everything
//   before it, which the next turn sends byte-identically.
// Rebuilt from the original `messages` each call (never mutated), so no stale breakpoint lingers.
function withMessagesCacheBreakpoint(
  messages: Anthropic.MessageParam[],
  stableIndex: number
): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages;
  const last = messages.length - 1;
  return messages.map((m, i) =>
    i === last || (i === stableIndex && stableIndex < last) ? withCacheControlOnLastBlock(m) : m
  );
}
```

In `runAssistantChat`, replace the `const messages: Anthropic.MessageParam[] = trimmedHistory.map(...)` statement with:

```ts
  // The latest two user messages are the retrieval query, so a follow-up like "and what about
  // her?" still pulls the memories the previous message did.
  let latestUserIndex = -1;
  for (let i = trimmedHistory.length - 1; i >= 0; i--) {
    if (trimmedHistory[i].role === "user") {
      latestUserIndex = i;
      break;
    }
  }
  const retrievalText = trimmedHistory
    .filter((m) => m.role === "user")
    .slice(-2)
    .map((m) => m.content)
    .join("\n");
  const relevantMemory = retrieveRelevantMemory(ownerId, retrievalText);

  const messages: Anthropic.MessageParam[] = trimmedHistory.map((m, i) => ({
    role: m.role,
    content:
      i === latestUserIndex && relevantMemory
        ? [
            { type: "text" as const, text: relevantMemory },
            { type: "text" as const, text: m.content },
          ]
        : m.content,
  }));
  const stableHistoryIndex = latestUserIndex - 1;
```

and change the create call's `messages: withMessagesCacheBreakpoint(messages),` to:

```ts
      messages: withMessagesCacheBreakpoint(messages, stableHistoryIndex),
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/ai/assistant.cacheBreakpoint.test.ts src/ai/assistant.test.ts src/ai/memoryRetrieval.test.ts`
Expected: PASS — including the existing single-message breakpoint tests (with one history message `stableHistoryIndex` is −1, so only the last-block breakpoint is set).

- [ ] **Step 7: Typecheck and commit**

Run: `npm run build` → exits 0.

```bash
git add src/ai/assistant.ts src/ai/assistant.test.ts src/ai/assistant.cacheBreakpoint.test.ts src/db/store.ts
git commit -m "feat: core profile in the cached system prompt, relevant memories injected per message"
```

---

### Task 7: Background extraction from WhatsApp

**Files:**
- Modify: `server/src/db/store.ts` (cursor + message-window helpers near `getWhatsAppBacklogForSummary` ~line 1759; `deleteUserCompletely` ~line 3281)
- Create: `server/src/services/memoryExtraction.ts`
- Create: `server/src/services/memoryExtraction.test.ts`
- Modify: `server/src/routes/whatsappRoutes.ts:140` (next to `maybeUpdateConversationSummary`)
- Modify: `server/src/routes/whatsappRoutes.test.ts:62`, `server/src/routes/onboarding.e2e.test.ts:60` (add mocks)
- Modify: `server/src/db/deleteUserCompletely.test.ts`

**Interfaces:**
- Consumes: `addFact`, `findOrCreateEntity`, `findEntityByName`, `addEntityAlias`, `linkEntitiesOnce`, `listCoreProfile`, `searchActiveFacts`, `listRememberedEntities`, `inTransaction`, `isMemoryKind`, `resolveOwnerByPhone`, `recordApiUsage`, `getWhatsAppHistory` (store).
- Produces (store):
  ```ts
  export function getMemoryExtractionCursor(phone: string): number | null;
  export function setMemoryExtractionCursor(phone: string, extractedThroughId: number): void;
  export function getWhatsAppMessagesAfter(phone: string, afterId: number, limit: number): WhatsAppMessageRow[]; // ascending
  export function getWhatsAppMessagesBefore(phone: string, beforeId: number, limit: number): WhatsAppMessageRow[]; // ascending
  ```
  (service):
  ```ts
  export const EXTRACTION_BATCH_SIZE = 8;
  export function buildExtractionPrompt(input: { context: WhatsAppMessageRow[]; batch: WhatsAppMessageRow[];
    candidates: MemoryNoteRow[]; entities: RememberedEntitySummary[] }): string;
  export function applyMemoryOperations(ownerId: number, operations: unknown, candidateIds: Set<number>): { applied: number; skipped: number };
  export async function maybeExtractMemory(phone: string): Promise<void>;
  ```

- [ ] **Step 1: Store helpers — failing tests**

Append to `server/src/db/deleteUserCompletely.test.ts` inside `describe("deleteUserCompletely")` (add `setMemoryExtractionCursor, getMemoryExtractionCursor` to its import):

```ts
  it("removes the memory extraction cursor for the owner's phone", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("cursor-bound"));
    const phone = `4476${Date.now().toString().slice(-8)}`;
    addPhoneNumberForUser(user.id, phone);
    setMemoryExtractionCursor(phone, 5);

    deleteUserCompletely(user.id);

    expect(getMemoryExtractionCursor(phone)).toBeNull();
  });
```

- [ ] **Step 2: Implement store helpers**

After `getWhatsAppBacklogForSummary` in `store.ts`:

```ts
// How far services/memoryExtraction.ts has read this phone's transcript; null = never run.
export function getMemoryExtractionCursor(phone: string): number | null {
  const row = db
    .prepare(`SELECT extracted_through_id AS id FROM memory_extraction_cursors WHERE phone = ?`)
    .get(phone) as { id: number } | undefined;
  return row ? row.id : null;
}

export function setMemoryExtractionCursor(phone: string, extractedThroughId: number): void {
  db.prepare(
    `INSERT INTO memory_extraction_cursors (phone, extracted_through_id, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(phone) DO UPDATE SET extracted_through_id = excluded.extracted_through_id,
       updated_at = excluded.updated_at`
  ).run(phone, extractedThroughId, Date.now());
}

export function getWhatsAppMessagesAfter(phone: string, afterId: number, limit: number): WhatsAppMessageRow[] {
  return db
    .prepare(
      `SELECT id, phone, role, content, created_at AS createdAt FROM whatsapp_messages
       WHERE phone = ? AND id > ? ORDER BY id ASC LIMIT ?`
    )
    .all(phone, afterId, limit) as WhatsAppMessageRow[];
}

export function getWhatsAppMessagesBefore(phone: string, beforeId: number, limit: number): WhatsAppMessageRow[] {
  const rows = db
    .prepare(
      `SELECT id, phone, role, content, created_at AS createdAt FROM whatsapp_messages
       WHERE phone = ? AND id < ? ORDER BY id DESC LIMIT ?`
    )
    .all(phone, beforeId, limit) as WhatsAppMessageRow[];
  return rows.reverse();
}
```

In `deleteUserCompletely`, directly after the `whatsapp_conversation_summaries` DELETE add:

```ts
    // Same phone-keyed shape as the summaries above — a new account on the same number must start
    // extraction fresh, not resume the old owner's cursor.
    db.prepare(
      `DELETE FROM memory_extraction_cursors WHERE phone IN (
         SELECT phone FROM user_phone_numbers WHERE user_id = ?
         UNION SELECT phone FROM replay_parked_phones WHERE owner_id = ?
         UNION SELECT phone FROM whatsapp_messages WHERE owner_id = ?)`
    ).run(ownerId, ownerId, ownerId);
```

Run: `npx vitest run src/db/deleteUserCompletely.test.ts` → PASS.

- [ ] **Step 3: Extraction service — failing tests**

`server/src/services/memoryExtraction.test.ts`:

```ts
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
```

- [ ] **Step 4: Run to verify failure**

Run: `npx vitest run src/services/memoryExtraction.test.ts`
Expected: FAIL — cannot resolve `./memoryExtraction.js`.

- [ ] **Step 5: Implement the service**

`server/src/services/memoryExtraction.ts`:

```ts
// Background extraction of durable facts from WhatsApp conversations into the memory graph
// (docs/superpowers/specs/2026-09-23-personal-memory-graph-design.md §2). Runs fire-and-forget
// from whatsappRoutes.ts on every inbound message; the common case is a no-op (one indexed
// SELECT). Every EXTRACTION_BATCH_SIZE fresh messages, one Haiku call turns them into validated
// operations — add a fact (optionally superseding one it was shown), link two remembered entities,
// or record an alias — applied in one transaction.
//
// Never throws. An API failure leaves the cursor where it was, so the batch is retried on the next
// inbound message; any successful response advances it, even if every operation was rejected, so a
// batch the model can't handle never wedges the pipeline.
import Anthropic from "@anthropic-ai/sdk";
import {
  resolveOwnerByPhone,
  recordApiUsage,
  getWhatsAppHistory,
  getWhatsAppMessagesAfter,
  getWhatsAppMessagesBefore,
  getMemoryExtractionCursor,
  setMemoryExtractionCursor,
  listCoreProfile,
  searchActiveFacts,
  listRememberedEntities,
  addFact,
  findOrCreateEntity,
  findEntityByName,
  addEntityAlias,
  linkEntitiesOnce,
  inTransaction,
  isMemoryKind,
  type MemoryNoteRow,
  type RememberedEntitySummary,
  type WhatsAppMessageRow,
} from "../db/store.js";

export const EXTRACTION_BATCH_SIZE = 8;
const CONTEXT_MESSAGES = 2;
// A phone that has never been extracted starts at the raw history window (mirrors
// MAX_HISTORY_MESSAGES / conversationSummary.ts's RAW_HISTORY_WINDOW), not at its first-ever
// message: months-old messages processed after newer facts could otherwise "supersede" them with
// stale information. Older history is already covered by the rolling conversation summary.
const BOOTSTRAP_WINDOW = 24;
const CANDIDATE_FACT_LIMIT = 30;
const CANDIDATE_ENTITY_LIMIT = 50;
const MAX_FACT_LENGTH = 500;
const EXTRACTION_MODEL = process.env.ASSISTANT_MODEL_SIMPLE ?? "claude-haiku-4-5";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

// Messages arrive in quick bursts; without this two overlapping runs would read the same batch
// and write every fact twice.
const inFlight = new Set<string>();

const RECORD_MEMORY_TOOL: Anthropic.Tool = {
  name: "record_memory",
  description: "Record the memory operations for this batch. An empty operations list is a normal answer.",
  input_schema: {
    type: "object",
    properties: {
      operations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            op: { type: "string", enum: ["add_fact", "link", "alias"] },
            content: { type: "string", description: "add_fact: one self-contained third-person sentence" },
            kind: { type: "string", enum: ["core", "fact", "preference"] },
            entity: {
              type: "object",
              properties: { name: { type: "string" }, type: { type: "string" } },
              description: "add_fact: the named person/place/organisation/project this fact is about, if any",
            },
            supersedes_id: { type: "number", description: "add_fact: id of a known fact this one replaces" },
            from: { type: "string", description: "link: entity name" },
            relation: { type: "string", description: "link: snake_case, e.g. works_at, sister_of" },
            to: { type: "string", description: "link: entity name" },
            alias: { type: "string", description: "alias: another name for `entity`" },
          },
          required: ["op"],
        },
      },
    },
    required: ["operations"],
  },
};

function transcript(rows: WhatsAppMessageRow[]): string {
  return rows.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n");
}

export function buildExtractionPrompt(input: {
  context: WhatsAppMessageRow[];
  batch: WhatsAppMessageRow[];
  candidates: MemoryNoteRow[];
  entities: RememberedEntitySummary[];
}): string {
  const known = input.candidates.length
    ? input.candidates.map((f) => `- [#${f.id}] (${f.kind}) ${f.content}`).join("\n")
    : "(none)";
  const entities = input.entities.length
    ? input.entities
        .map((e) => `- ${e.name} (${e.type}${e.aliases.length ? `; also: ${e.aliases.join(", ")}` : ""})`)
        .join("\n")
    : "(none)";
  return [
    "You maintain the long-term memory of a personal assistant about the person it works for.",
    `Facts already known (with ids):\n${known}`,
    `People, places, organisations and projects already known:\n${entities}`,
    input.context.length ? `Earlier messages, for context only (already processed):\n${transcript(input.context)}` : "",
    `New messages to process:\n${transcript(input.batch)}`,
    [
      "Call record_memory with the operations these NEW messages justify. Rules:",
      "- Only durable things worth knowing weeks from now: facts about the user and the people, places, organisations and projects in their life; routines; preferences; standing instructions. Not one-off task requests, small talk, or anything only true today.",
      "- Something the assistant said only counts if the user confirmed it.",
      "- Never record secrets: passwords, PINs, card or bank account numbers, one-time codes, security answers.",
      "- kind 'core' is only for identity-level facts: the user's name, partner/children/close family, home city, job/employer, a strong standing preference. Use 'preference' for likes/dislikes/how they want things done, otherwise 'fact'.",
      "- If a known fact already says it, record nothing. If the new messages change or correct a known fact, add the new fact with supersedes_id set to that fact's id.",
      "- Write each fact as one self-contained third-person sentence, e.g. \"Sarah Jones is the user's accountant at Acme.\"",
      "- When a fact is about a named person/place/organisation/project, set entity, reusing an existing name exactly rather than inventing a variant. Use link for a relationship between two named entities and alias when the user uses another name for a known one.",
      "- Zero operations is a normal, expected answer.",
    ].join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// Validates each model-proposed operation independently — one malformed op is skipped without
// discarding its valid siblings. supersedes_id is only honoured for facts the model was actually
// shown (candidateIds), so it can never retire a fact by guessing an id; link/alias ops only ever
// act on entities that already exist (including ones an add_fact in this same batch just created).
export function applyMemoryOperations(
  ownerId: number,
  operations: unknown,
  candidateIds: Set<number>
): { applied: number; skipped: number } {
  const ops = Array.isArray(operations) ? operations : [];
  let applied = 0;
  let skipped = 0;
  const valid = (op: unknown): op is Record<string, unknown> => typeof op === "object" && op !== null;

  inTransaction(() => {
    // add_fact first so links/aliases in the same batch can refer to entities it creates.
    const ordered = [
      ...ops.filter((op) => valid(op) && op.op === "add_fact"),
      ...ops.filter((op) => !(valid(op) && op.op === "add_fact")),
    ];
    for (const op of ordered) {
      if (!valid(op)) {
        skipped += 1;
        continue;
      }
      if (op.op === "add_fact") {
        const content = nonEmptyString(op.content);
        if (!content || content.length > MAX_FACT_LENGTH || !isMemoryKind(op.kind)) {
          skipped += 1;
          continue;
        }
        const entityInput = valid(op.entity) ? op.entity : null;
        const entityName = nonEmptyString(entityInput?.name);
        const entityType = nonEmptyString(entityInput?.type);
        const entity = entityName && entityType ? findOrCreateEntity(ownerId, entityType, entityName) : null;
        const supersedes = typeof op.supersedes_id === "number" && candidateIds.has(op.supersedes_id) ? op.supersedes_id : null;
        addFact(ownerId, { content, kind: op.kind, source: "extracted", entityId: entity?.id ?? null, supersedesId: supersedes });
        applied += 1;
      } else if (op.op === "link") {
        const from = nonEmptyString(op.from);
        const to = nonEmptyString(op.to);
        const relation = nonEmptyString(op.relation);
        const fromEntity = from ? findEntityByName(ownerId, from) : null;
        const toEntity = to ? findEntityByName(ownerId, to) : null;
        if (!fromEntity || !toEntity || !relation) {
          skipped += 1;
          continue;
        }
        linkEntitiesOnce(ownerId, fromEntity.id, relation, toEntity.id);
        applied += 1;
      } else if (op.op === "alias") {
        const name = nonEmptyString(op.entity);
        const alias = nonEmptyString(op.alias);
        const entity = name ? findEntityByName(ownerId, name) : null;
        if (!entity || !alias) {
          skipped += 1;
          continue;
        }
        addEntityAlias(ownerId, entity.id, alias);
        applied += 1;
      } else {
        skipped += 1;
      }
    }
  });
  return { applied, skipped };
}

function startingCursor(phone: string): number {
  const recent = getWhatsAppHistory(phone, BOOTSTRAP_WINDOW);
  return recent.length ? recent[0].id - 1 : 0;
}

export async function maybeExtractMemory(phone: string): Promise<void> {
  if (inFlight.has(phone)) return;
  inFlight.add(phone);
  try {
    const ownerId = resolveOwnerByPhone(phone);
    if (ownerId === null) return;

    const afterId = getMemoryExtractionCursor(phone) ?? startingCursor(phone);
    const batch = getWhatsAppMessagesAfter(phone, afterId, EXTRACTION_BATCH_SIZE);
    if (batch.length < EXTRACTION_BATCH_SIZE) return;

    const context = getWhatsAppMessagesBefore(phone, batch[0].id, CONTEXT_MESSAGES);
    const core = listCoreProfile(ownerId);
    const related = searchActiveFacts(ownerId, batch.map((m) => m.content).join("\n"), {
      mode: "any",
      limit: CANDIDATE_FACT_LIMIT,
    });
    const candidates = [...core, ...related.filter((f) => !core.some((c) => c.id === f.id))];
    const entities = listRememberedEntities(ownerId).slice(0, CANDIDATE_ENTITY_LIMIT);

    let response: Anthropic.Message;
    try {
      response = await getClient().messages.create({
        model: EXTRACTION_MODEL,
        max_tokens: 1024,
        tools: [RECORD_MEMORY_TOOL],
        tool_choice: { type: "tool", name: RECORD_MEMORY_TOOL.name },
        messages: [{ role: "user", content: buildExtractionPrompt({ context, batch, candidates, entities }) }],
      });
    } catch (err) {
      console.error("memoryExtraction: model call failed; batch will be retried", err);
      return;
    }

    recordApiUsage(
      ownerId,
      "whatsapp",
      EXTRACTION_MODEL,
      "memory_extraction",
      response.usage?.input_tokens ?? 0,
      response.usage?.output_tokens ?? 0,
      response.usage?.cache_read_input_tokens ?? 0,
      response.usage?.cache_creation_input_tokens ?? 0
    );

    try {
      const toolUse = response.content.find(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === RECORD_MEMORY_TOOL.name
      );
      const operations = (toolUse?.input as { operations?: unknown } | undefined)?.operations;
      applyMemoryOperations(ownerId, operations, new Set(candidates.map((f) => f.id)));
    } catch (err) {
      console.error("memoryExtraction: applying operations failed; skipping batch", err);
    }
    setMemoryExtractionCursor(phone, batch[batch.length - 1].id);
  } catch (err) {
    console.error("memoryExtraction: unexpected failure", err);
  } finally {
    inFlight.delete(phone);
  }
}
```

If `WhatsAppMessageRow` or `RememberedEntitySummary` isn't exported as a type from `store.ts`, export it (`export interface ...`).

- [ ] **Step 6: Run to verify pass**

Run: `npx vitest run src/services/memoryExtraction.test.ts`
Expected: PASS. If the bootstrap test's cursor index assertion is off by one, re-derive from `startingCursor` (cursor = id of message 15, batch = messages 16–23) rather than loosening the assertion — i.e. `ids[40 - 24 + EXTRACTION_BATCH_SIZE - 1]` is message 23.

- [ ] **Step 7: Wire into the WhatsApp route**

In `server/src/routes/whatsappRoutes.ts` add the import beside `maybeUpdateConversationSummary`:

```ts
import { maybeExtractMemory } from "../services/memoryExtraction.js";
```

and right after the `maybeUpdateConversationSummary(message.from).catch(...)` statement:

```ts
  // Fire-and-forget, same as the summary above — turns each batch of fresh messages into
  // structured memories (services/memoryExtraction.ts). Usually a no-op; never blocks a reply.
  maybeExtractMemory(message.from).catch((err) =>
    console.error("whatsapp: memory extraction failed", err)
  );
```

In both `src/routes/whatsappRoutes.test.ts` and `src/routes/onboarding.e2e.test.ts`, directly after the existing `vi.mock("../services/conversationSummary.js", ...)` add:

```ts
vi.mock("../services/memoryExtraction.js", () => ({
  maybeExtractMemory: vi.fn().mockResolvedValue(undefined),
}));
```

- [ ] **Step 8: Run route tests**

Run: `npx vitest run src/routes/whatsappRoutes.test.ts src/routes/onboarding.e2e.test.ts src/db/deleteUserCompletely.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/db/store.ts src/db/deleteUserCompletely.test.ts src/services/memoryExtraction.ts src/services/memoryExtraction.test.ts src/routes/whatsappRoutes.ts src/routes/whatsappRoutes.test.ts src/routes/onboarding.e2e.test.ts
git commit -m "feat: extract durable memories from WhatsApp conversations in the background"
```

---

### Task 8: Full verification

**Files:** none new.

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all tests pass. Any failure in a file not touched by this plan that references `memoryList`, `Things you remember about the user`, `listRecentMemoryNotes`, `appendEntityNote`, or `data.notes` is a stale expectation of the old behaviour — update it to the new shape from the spec, don't revert the feature.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 3: Grep for leftovers**

Run: `grep -rn "listRecentMemoryNotes\|appendEntityNote\|Things you remember about the user" src`
Expected: no output.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A src
git commit -m "test: align remaining suites with the memory graph"
```
(Skip if nothing changed.)
