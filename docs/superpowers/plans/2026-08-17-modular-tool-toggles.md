# Modular Tool Toggles (v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each user independently turn Microsoft Teams chat and the travel/Schengen day tracker on or off, with the assistant's tool list, the Chats page, and the Setup page's Location check-ins section all respecting that per-user state.

**Architecture:** A new `user_enabled_tools` table (owner_id + tool_key) drives everything downstream: `server/src/ai/assistant.ts` filters Claude's tool schemas and system-prompt rules per owner before every call, `runTool` rejects a disabled tool's function server-side as defense-in-depth even if somehow requested, and two small `GET`/`PUT /api/tools` routes let the client read/write this state. The tool *catalog* (labels/descriptions) is hardcoded server-side, matching the existing `/api/providers` precedent — only *which tools a user turned on* is data.

**Tech Stack:** Express + TypeScript + better-sqlite3 (server), React + Vite + TypeScript + plain CSS (client). Adds `vitest` + `supertest` as server dev dependencies — the codebase currently has zero test infrastructure on either side, so Task 1 sets up the minimum needed for TDD on the server-side logic in this plan (the risky part: tool filtering, defense-in-depth). Client changes are verified manually, matching the codebase's existing testing posture (no client tests exist today either) — a full client test framework is out of scope for a 2-toggle feature.

**Spec:** `docs/superpowers/specs/2026-08-17-modular-tool-toggles-design.md`

## Global Constraints

- New signups default to **both tools off** (opt-in, not opt-out) — per spec's "Open questions" resolution.
- The sidebar/nav is **not** touched in this plan — stays the fixed 5-tab shell. Disabled tools show an inline in-page message, not a hidden nav item.
- Both the UI *and* the assistant/WhatsApp tool-calling channel must reflect the same enabled/disabled state — never gate one without the other.
- The tool catalog (key, label, description) is a hardcoded array in server code, not a database table — only per-user enablement is persisted.
- Every new store function follows the existing `ownerId`-first, owner-scoped-query pattern already used throughout `server/src/db/store.ts` (see e.g. `listCheckins`, `addPhoneNumberForUser`).
- Every new/modified `/api/*` route relies on `requireAuth` (already globally mounted in `server/src/index.ts` — no per-route auth code needed beyond reading `(req as unknown as AuthedRequest).userId`).

---

### Task 1: Server test infrastructure

**Files:**
- Modify: `server/package.json`
- Create: `server/vitest.config.ts`
- Create: `server/src/test/setup.ts`
- Modify: `server/src/db/store.ts:7`
- Create: `server/src/db/store.smoke.test.ts`

**Interfaces:**
- Produces: an isolated, disposable SQLite DB for every `npm test` run (via `process.env.DATA_DIR`), a `vitest` test runner, and `supertest` available for route-level tests in later tasks.

- [ ] **Step 1: Add test dependencies**

```bash
cd server
npm install -D vitest supertest @types/supertest
```

- [ ] **Step 2: Add the test script to `server/package.json`**

In the `"scripts"` block, add:

```json
    "test": "vitest run",
```

- [ ] **Step 3: Create `server/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./src/test/setup.ts"],
  },
});
```

- [ ] **Step 4: Create `server/src/test/setup.ts`**

```ts
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// store.ts computes its data directory at module-load time from DATA_DIR (falling back to
// process.cwd()/data when unset — see store.ts). Setting this here, in a setupFiles script that
// vitest runs before any test file is imported, ensures every test run gets a fresh temp SQLite
// file instead of touching server/data/app.db (the real dev database).
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-test-"));
process.env.DATA_DIR = testDataDir;
```

- [ ] **Step 5: Point `store.ts` at `DATA_DIR` when set**

Modify `server/src/db/store.ts:7`:

```ts
// Before:
const dataDir = path.join(process.cwd(), "data");

// After:
// DATA_DIR lets tests (see server/src/test/setup.ts) point this at an isolated temp directory
// instead of the real server/data — unset in normal dev/production, where this falls back to
// the existing behavior unchanged.
const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
```

- [ ] **Step 6: Write a smoke test — `server/src/db/store.smoke.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { findOrCreateUserByEmail, getUser } from "./store.js";

describe("store smoke test", () => {
  it("creates and reads back a user, confirming the isolated test DB is wired up", () => {
    const user = findOrCreateUserByEmail("smoke-test@example.com");
    expect(user.email).toBe("smoke-test@example.com");
    const fetched = getUser(user.id);
    expect(fetched?.email).toBe("smoke-test@example.com");
  });
});
```

- [ ] **Step 7: Run it and verify it passes**

Run: `cd server && npm test`
Expected: 1 test file, 1 test, PASS. Confirm `server/data/app.db`'s modified time is unchanged (the test used the temp `DATA_DIR`, not the real dev DB).

- [ ] **Step 8: Commit**

```bash
git add server/package.json server/package-lock.json server/vitest.config.ts server/src/test/setup.ts server/src/db/store.ts server/src/db/store.smoke.test.ts
git commit -m "test: add vitest + isolated test database for the server"
```

---

### Task 2: Data model — `user_enabled_tools`

**Files:**
- Modify: `server/src/db/store.ts`
- Test: `server/src/db/toolsStore.test.ts`

**Interfaces:**
- Consumes: nothing new (uses the existing `db` singleton and `users` table already in `store.ts`).
- Produces: `export type ToolKey = "teams" | "travel"`, `export const TOOL_KEYS: ToolKey[]`, `export function getEnabledTools(ownerId: number): Set<ToolKey>`, `export function setToolEnabled(ownerId: number, toolKey: ToolKey, enabled: boolean): void` — all from `server/src/db/store.ts`. Task 3 and Task 4 both import these.

- [ ] **Step 1: Write the failing tests — `server/src/db/toolsStore.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { findOrCreateUserByEmail, getEnabledTools, setToolEnabled } from "./store.js";

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

describe("user_enabled_tools", () => {
  it("returns an empty set for a user who hasn't enabled anything", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("no-tools"));
    expect(getEnabledTools(user.id)).toEqual(new Set());
  });

  it("enabling a tool makes it appear in the enabled set", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("enable-teams"));
    setToolEnabled(user.id, "teams", true);
    expect(getEnabledTools(user.id)).toEqual(new Set(["teams"]));
  });

  it("enabling twice does not error or duplicate", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("enable-twice"));
    setToolEnabled(user.id, "travel", true);
    setToolEnabled(user.id, "travel", true);
    expect(getEnabledTools(user.id)).toEqual(new Set(["travel"]));
  });

  it("disabling removes it from the enabled set", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("disable"));
    setToolEnabled(user.id, "teams", true);
    setToolEnabled(user.id, "teams", false);
    expect(getEnabledTools(user.id)).toEqual(new Set());
  });

  it("rejects an unknown tool key", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("bad-key"));
    expect(() => setToolEnabled(user.id, "finance" as never, true)).toThrow("unknown tool");
  });

  it("is scoped per owner — enabling for one user doesn't affect another", () => {
    const userA = findOrCreateUserByEmail(uniqueEmail("owner-a"));
    const userB = findOrCreateUserByEmail(uniqueEmail("owner-b"));
    setToolEnabled(userA.id, "teams", true);
    expect(getEnabledTools(userB.id)).toEqual(new Set());
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cd server && npm test -- toolsStore`
Expected: FAIL — `getEnabledTools`/`setToolEnabled` are not exported from `./store.js`.

- [ ] **Step 3: Add the table**

Modify `server/src/db/store.ts` — in the `db.exec(...)` block under the `-- Multi-tenant tables — always safe to create fresh` comment (immediately after the existing `CREATE INDEX IF NOT EXISTS idx_user_phone_numbers_user ON user_phone_numbers(user_id);` line, before the closing `` ` `` of that `db.exec`):

```sql
  CREATE TABLE IF NOT EXISTS user_enabled_tools (
    owner_id INTEGER NOT NULL REFERENCES users(id),
    tool_key TEXT NOT NULL,
    enabled_at INTEGER NOT NULL,
    PRIMARY KEY(owner_id, tool_key)
  );
```

- [ ] **Step 4: Add the type and functions**

Modify `server/src/db/store.ts` — insert after the `removePhoneNumberForUser` function (right before the `resolveOwnerByPhone` function, so it lives alongside the other simple owner-scoped tables):

```ts
export type ToolKey = "teams" | "travel";
export const TOOL_KEYS: ToolKey[] = ["teams", "travel"];

export function getEnabledTools(ownerId: number): Set<ToolKey> {
  const rows = db
    .prepare(`SELECT tool_key AS toolKey FROM user_enabled_tools WHERE owner_id = ?`)
    .all(ownerId) as { toolKey: ToolKey }[];
  return new Set(rows.map((r) => r.toolKey));
}

export function setToolEnabled(ownerId: number, toolKey: ToolKey, enabled: boolean): void {
  if (!TOOL_KEYS.includes(toolKey)) {
    throw new Error(`unknown tool: ${toolKey}`);
  }
  if (enabled) {
    db.prepare(
      `INSERT INTO user_enabled_tools (owner_id, tool_key, enabled_at) VALUES (?, ?, ?)
       ON CONFLICT(owner_id, tool_key) DO NOTHING`
    ).run(ownerId, toolKey, Date.now());
  } else {
    db.prepare(`DELETE FROM user_enabled_tools WHERE owner_id = ? AND tool_key = ?`).run(ownerId, toolKey);
  }
}
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `cd server && npm test -- toolsStore`
Expected: 6 tests, all PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/db/store.ts server/src/db/toolsStore.test.ts
git commit -m "feat: add user_enabled_tools table and store functions"
```

---

### Task 3: `GET`/`PUT /api/tools` routes

**Files:**
- Create: `server/src/routes/toolsRoutes.ts`
- Modify: `server/src/index.ts`
- Test: `server/src/routes/toolsRoutes.test.ts`

**Interfaces:**
- Consumes: `getEnabledTools`, `setToolEnabled`, `TOOL_KEYS`, `type ToolKey` from `server/src/db/store.js` (Task 2). `AuthedRequest` from `server/src/middleware/auth.js`.
- Produces: `export const toolsRoutes: Router` from `server/src/routes/toolsRoutes.js`, mounted at `/api/tools` and `/api/tools/:key`. Response shape `{ key: ToolKey; label: string; description: string; enabled: boolean }[]` for `GET`. Task 5 consumes this shape client-side.

- [ ] **Step 1: Write the failing tests — `server/src/routes/toolsRoutes.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { toolsRoutes } from "./toolsRoutes.js";
import { findOrCreateUserByEmail, getEnabledTools } from "../db/store.js";
import type { AuthedRequest } from "../middleware/auth.js";

function buildTestApp(userId: number) {
  const app = express();
  app.use(express.json());
  // Stub in place of requireAuth — real auth (cookies/sessions) is exercised elsewhere; this
  // test is about the tools routes' own logic, not the auth middleware.
  app.use((req, _res, next) => {
    (req as unknown as AuthedRequest).userId = userId;
    next();
  });
  app.use(toolsRoutes);
  return app;
}

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

describe("GET /api/tools", () => {
  it("lists the catalog with enabled:false for a user with nothing turned on", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("list-none"));
    const app = buildTestApp(user.id);
    const res = await request(app).get("/api/tools");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        key: "teams",
        label: "Microsoft Teams chat",
        description: "Let your assistant read and search your Teams conversations.",
        enabled: false,
      },
      {
        key: "travel",
        label: "Travel / Schengen day tracker",
        description:
          "Track location check-ins and count days spent in a country or the Schengen area.",
        enabled: false,
      },
    ]);
  });
});

describe("PUT /api/tools/:key", () => {
  it("enables a tool and persists it", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("enable"));
    const app = buildTestApp(user.id);
    const res = await request(app).put("/api/tools/teams").send({ enabled: true });
    expect(res.status).toBe(200);
    expect(getEnabledTools(user.id)).toEqual(new Set(["teams"]));
  });

  it("disables a previously enabled tool", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("disable"));
    const app = buildTestApp(user.id);
    await request(app).put("/api/tools/travel").send({ enabled: true });
    const res = await request(app).put("/api/tools/travel").send({ enabled: false });
    expect(res.status).toBe(200);
    expect(getEnabledTools(user.id)).toEqual(new Set());
  });

  it("rejects an unknown tool key with 400", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("bad-key"));
    const app = buildTestApp(user.id);
    const res = await request(app).put("/api/tools/finance").send({ enabled: true });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cd server && npm test -- toolsRoutes`
Expected: FAIL — `./toolsRoutes.js` does not exist yet.

- [ ] **Step 3: Create `server/src/routes/toolsRoutes.ts`**

```ts
import { Router } from "express";
import { getEnabledTools, setToolEnabled, TOOL_KEYS, type ToolKey } from "../db/store.js";
import type { AuthedRequest } from "../middleware/auth.js";

export const toolsRoutes = Router();

// The tool catalog (which tools exist, their display copy) is code, not data — same precedent
// as /api/providers in accountRoutes.ts. Only which tools a given user has turned on lives in
// the database (user_enabled_tools).
const TOOL_CATALOG: { key: ToolKey; label: string; description: string }[] = [
  {
    key: "teams",
    label: "Microsoft Teams chat",
    description: "Let your assistant read and search your Teams conversations.",
  },
  {
    key: "travel",
    label: "Travel / Schengen day tracker",
    description:
      "Track location check-ins and count days spent in a country or the Schengen area.",
  },
];

toolsRoutes.get("/api/tools", (req, res) => {
  const ownerId = (req as unknown as AuthedRequest).userId;
  const enabled = getEnabledTools(ownerId);
  res.json(
    TOOL_CATALOG.map((t) => ({
      ...t,
      enabled: enabled.has(t.key),
    }))
  );
});

toolsRoutes.put("/api/tools/:key", (req, res) => {
  const ownerId = (req as unknown as AuthedRequest).userId;
  const key = req.params.key as ToolKey;
  if (!TOOL_KEYS.includes(key)) {
    res.status(400).json({ error: `unknown tool: ${key}` });
    return;
  }
  const { enabled } = req.body ?? {};
  setToolEnabled(ownerId, key, !!enabled);
  res.json({ ok: true });
});
```

- [ ] **Step 4: Register the router in `server/src/index.ts`**

Add the import near the other route imports (after `import { alertRoutes } from "./routes/alertRoutes.js";`):

```ts
import { toolsRoutes } from "./routes/toolsRoutes.js";
```

Add the mount near the other `/api` mounts (after `app.use(alertRoutes);`):

```ts
app.use(toolsRoutes);
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `cd server && npm test -- toolsRoutes`
Expected: 4 tests, all PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/toolsRoutes.ts server/src/routes/toolsRoutes.test.ts server/src/index.ts
git commit -m "feat: add GET/PUT /api/tools routes"
```

---

### Task 4: `assistant.ts` — per-owner tool filtering + defense-in-depth

**Files:**
- Modify: `server/src/ai/assistant.ts`
- Test: `server/src/ai/assistant.test.ts`

**Interfaces:**
- Consumes: `getEnabledTools`, `TOOL_KEYS`, `type ToolKey` from `server/src/db/store.js` (Task 2).
- Produces: `export function buildToolsForOwner(ownerId: number): Anthropic.Tool[]`, `export function buildSystemPrompt(ownerId: number): string` (already existed, now exported), `export async function runTool(ownerId: number, name: string, input: Record<string, unknown>): Promise<unknown>` (already existed, now exported + gated). `runAssistantChat`'s public signature is unchanged.

- [ ] **Step 1: Write the failing tests — `server/src/ai/assistant.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { buildToolsForOwner, buildSystemPrompt, runTool } from "./assistant.js";
import { findOrCreateUserByEmail, setToolEnabled } from "../db/store.js";

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

describe("buildToolsForOwner", () => {
  it("excludes teams and travel tools when neither is enabled", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("no-tools"));
    const names = buildToolsForOwner(user.id).map((t) => t.name);
    expect(names).not.toContain("list_recent_chats");
    expect(names).not.toContain("search_chats");
    expect(names).not.toContain("list_travel_checkins");
    expect(names).not.toContain("count_travel_days");
  });

  it("includes teams tools when teams is enabled", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("teams-on"));
    setToolEnabled(user.id, "teams", true);
    const names = buildToolsForOwner(user.id).map((t) => t.name);
    expect(names).toContain("list_recent_chats");
    expect(names).toContain("search_chats");
    expect(names).not.toContain("list_travel_checkins");
  });

  it("includes travel tools when travel is enabled", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("travel-on"));
    setToolEnabled(user.id, "travel", true);
    const names = buildToolsForOwner(user.id).map((t) => t.name);
    expect(names).toContain("list_travel_checkins");
    expect(names).toContain("count_travel_days");
  });

  it("puts the cache_control breakpoint on the last tool in the array, whichever one that is", () => {
    const userNoTools = findOrCreateUserByEmail(uniqueEmail("cache-none"));
    const noToolsResult = buildToolsForOwner(userNoTools.id);
    expect(noToolsResult[noToolsResult.length - 1].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });

    const userWithTravel = findOrCreateUserByEmail(uniqueEmail("cache-travel"));
    setToolEnabled(userWithTravel.id, "travel", true);
    const withTravelResult = buildToolsForOwner(userWithTravel.id);
    expect(withTravelResult[withTravelResult.length - 1].name).toBe("count_travel_days");
    expect(withTravelResult[withTravelResult.length - 1].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
  });
});

describe("buildSystemPrompt", () => {
  it("omits travel-specific rules when travel is disabled", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("prompt-no-travel"));
    const prompt = buildSystemPrompt(user.id);
    expect(prompt).not.toContain("count_travel_days");
  });

  it("includes travel-specific rules when travel is enabled", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("prompt-travel"));
    setToolEnabled(user.id, "travel", true);
    const prompt = buildSystemPrompt(user.id);
    expect(prompt).toContain("count_travel_days");
  });
});

describe("runTool defense-in-depth", () => {
  it("rejects a teams tool call when teams is not enabled for that owner", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("defense-teams"));
    const result = await runTool(user.id, "list_recent_chats", {});
    expect(result).toEqual({ error: "tool not enabled: list_recent_chats" });
  });

  it("rejects a travel tool call when travel is not enabled for that owner", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("defense-travel"));
    const result = await runTool(user.id, "count_travel_days", { area: "schengen" });
    expect(result).toEqual({ error: "tool not enabled: count_travel_days" });
  });

  it("does not block always-on tools regardless of enabled-tools state", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("defense-remember"));
    const result = await runTool(user.id, "remember", { note: "test note" });
    expect(result).toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cd server && npm test -- assistant.test`
Expected: FAIL — `buildToolsForOwner` is not exported, `buildSystemPrompt`/`runTool` are not exported yet.

- [ ] **Step 3: Add the import**

Modify `server/src/ai/assistant.ts` — in the existing import block from `"../db/store.js"` (currently `listAccounts, getSetting, listRecentMemoryNotes, addMemoryNote, searchDocuments, listDocuments, listCheckins, listAllCheckinsAscending, type DocumentRow`), add `getEnabledTools, TOOL_KEYS, type ToolKey,`:

```ts
import {
  listAccounts,
  getSetting,
  listRecentMemoryNotes,
  addMemoryNote,
  searchDocuments,
  listDocuments,
  listCheckins,
  listAllCheckinsAscending,
  getEnabledTools,
  TOOL_KEYS,
  type ToolKey,
  type DocumentRow,
} from "../db/store.js";
```

- [ ] **Step 4: Split the `tools` array into always-on + conditional groups**

In `server/src/ai/assistant.ts`, the existing `const tools: Anthropic.Tool[] = [ ... ];` array (19 entries) needs two changes:

1. Remove these 4 tool definitions from the array entirely: `list_recent_chats`, `search_chats`, `list_travel_checkins`, `count_travel_days`.
2. Remove the `cache_control: { type: "ephemeral", ttl: "1h" }` property from the `count_travel_days` definition (it was only there because that tool happened to be last in the old flat array — placement is now dynamic, see Step 5).
3. Rename the array from `tools` to `ALWAYS_ON_TOOLS`.

Then add the two conditional groups and the assembly function right after it:

```ts
const CONDITIONAL_TOOLS: Record<ToolKey, Anthropic.Tool[]> = {
  teams: [
    {
      name: "list_recent_chats",
      description:
        "List the user's most recent Microsoft Teams conversations (direct messages and group chats). Call this when the user asks what's new in Teams or about recent chat messages.",
      input_schema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max chats, default 20" },
        },
      },
    },
    {
      name: "search_chats",
      description:
        "Search the user's Microsoft Teams chat messages by keyword. Call this when the user asks to find something someone said in Teams.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
    },
  ],
  travel: [
    {
      name: "list_travel_checkins",
      description:
        "List the user's location check-ins (country/city + timestamp), newest first. These are logged automatically by a phone automation when the user lands somewhere or crosses a border — not something they send manually. Call this for travel questions like 'where have I been' or 'when did I arrive in France'. This is raw location history, not day-counting — use count_travel_days for duration questions instead of doing the arithmetic yourself.",
      input_schema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max check-ins, default 50" },
        },
      },
    },
    {
      name: "count_travel_days",
      description:
        "Count how many days the user has spent in a country or region, computed deterministically from logged location check-ins (not documents/boarding passes). Use area 'schengen' or 'eu' for those groupings, or the exact country name as it appears in list_travel_checkins output (case-insensitive) — check that tool first if unsure of the exact spelling. Defaults to the last 180 days (the window relevant to the Schengen 90/180 rule) if no dates are given; pass explicit since_date/until_date (YYYY-MM-DD) for a different range, e.g. a specific year.",
      input_schema: {
        type: "object",
        properties: {
          area: { type: "string", description: "'schengen', 'eu', or an exact country name" },
          since_date: { type: "string", description: "ISO date YYYY-MM-DD, default 180 days ago" },
          until_date: { type: "string", description: "ISO date YYYY-MM-DD, default today" },
        },
        required: ["area"],
      },
    },
  ],
};

export function buildToolsForOwner(ownerId: number): Anthropic.Tool[] {
  const enabled = getEnabledTools(ownerId);
  const result = [...ALWAYS_ON_TOOLS];
  for (const key of TOOL_KEYS) {
    if (enabled.has(key)) result.push(...CONDITIONAL_TOOLS[key]);
  }
  // Cache breakpoint must be on the LAST tool schema in the array — which tool that is now
  // depends on which conditional tools are enabled, so it's set dynamically here rather than
  // hardcoded on one specific tool definition like before.
  if (result.length > 0) {
    result[result.length - 1] = {
      ...result[result.length - 1],
      cache_control: { type: "ephemeral", ttl: "1h" },
    };
  }
  return result;
}
```

- [ ] **Step 5: Make the Rules block in `buildSystemPrompt` conditional on enabled tools**

Modify `server/src/ai/assistant.ts` — replace the hardcoded `Rules:` template-string block (the long backtick string starting `` `Rules:\n- Always look up real data... ` `` inside `buildSystemPrompt`) with a call to a new `buildRules` helper. Add this function right before `buildSystemPrompt`:

```ts
function buildRules(enabled: Set<ToolKey>): string {
  const base = [
    "- Always look up real data with your tools before answering questions about email, calendar, or files — never invent contents.",
    "- You can create email drafts but can never send email. After creating a draft, tell the user to review and send it from their mailbox.",
    "- You can create, edit, and delete calendar events directly on the user's own calendar — these are low-risk and reversible. You can never invite other people to an event; calendar events you create are personal-only.",
    '- You can archive emails and apply labels/categories directly — archiving is fully reversible (the email is just removed from the inbox, never deleted) so you don\'t need to ask permission first, but do confirm if the query is broad or ambiguous (e.g. "archive everything" with no filter).',
    "- Use search_contacts to resolve a name to an email address before drafting to someone when you don't already have their address.",
    "- Use the remember tool proactively whenever the user shares something worth recalling later (preferences, which account is which, standing instructions) — don't wait to be asked.",
    '- Use search_documents/list_recent_documents when the user asks about something they photographed or sent via WhatsApp (boarding passes, licenses, tickets, receipts) — e.g. "when did I fly to X" or "what\'s the code on my license".',
  ];
  const travel = [
    "- Use list_travel_checkins for questions about where the user has physically been or when they arrived somewhere — this is automatic location history, separate from documents.",
    '- Use count_travel_days for "how many days have I spent in X" style questions — never estimate day counts yourself from raw check-in timestamps or document text.',
  ];
  const tail = [
    '- When a message reports a document that was just saved (e.g. a WhatsApp photo/PDF), don\'t dump every extracted field back at the user — give a short confirmation of only the key fact(s) (e.g. what it is, and the one or two details most likely to matter, like dates or a confirmation code), then carry out whatever else was asked. Save the full itemized breakdown for if the user explicitly asks to see all the details (e.g. "show me everything on it").',
    '- When one message asks for multiple things (e.g. "save this and also add it to my calendar"), do all of them in that same turn using your tools — don\'t complete only the first one and wait to be asked again for the rest.',
    "- When several accounts are connected and the user's request is ambiguous about which one, search across all of them or ask.",
    "- Keep answers concise and lead with the direct answer.",
  ];
  return ["Rules:", ...base, ...(enabled.has("travel") ? travel : []), ...tail].join("\n");
}
```

Then change `buildSystemPrompt`'s signature from `function buildSystemPrompt(ownerId: number): string {` to `export function buildSystemPrompt(ownerId: number): string {`, and inside it replace the old hardcoded `` `Rules:\n...` `` template string in the returned array with `buildRules(getEnabledTools(ownerId))`.

- [ ] **Step 6: Add the defense-in-depth check to `runTool`**

Modify `server/src/ai/assistant.ts` — change `async function runTool(` to `export async function runTool(`, and add this check as the first line inside the function body, before the `switch (name) {`:

```ts
const TOOL_NAME_TO_KEY: Record<string, ToolKey> = {
  list_recent_chats: "teams",
  search_chats: "teams",
  list_travel_checkins: "travel",
  count_travel_days: "travel",
};

export async function runTool(ownerId: number, name: string, input: Record<string, unknown>): Promise<unknown> {
  const requiredKey = TOOL_NAME_TO_KEY[name];
  if (requiredKey && !getEnabledTools(ownerId).has(requiredKey)) {
    return { error: `tool not enabled: ${name}` };
  }
  switch (name) {
    // ...unchanged
```

(`TOOL_NAME_TO_KEY` is a new top-level const — place it directly above the `runTool` function.)

- [ ] **Step 7: Use `buildToolsForOwner` in `runAssistantChat`**

Modify `server/src/ai/assistant.ts` — inside `runAssistantChat`, in the `anthropic.messages.create({...})` call, change:

```ts
// Before:
      tools,

// After:
      tools: buildToolsForOwner(ownerId),
```

- [ ] **Step 8: Run the tests and verify they pass**

Run: `cd server && npm test -- assistant.test`
Expected: 9 tests, all PASS.

- [ ] **Step 9: Run the full server test suite to confirm nothing else broke**

Run: `cd server && npm test`
Expected: all test files across Tasks 1–4 PASS.

- [ ] **Step 10: Commit**

```bash
git add server/src/ai/assistant.ts server/src/ai/assistant.test.ts
git commit -m "feat: per-owner tool filtering + defense-in-depth in assistant.ts"
```

---

### Task 5: Client — Setup page Tools section + gate Location check-ins

**Files:**
- Modify: `client/src/api/client.ts`
- Modify: `client/src/pages/SetupPage.tsx`

**Interfaces:**
- Consumes: `GET /api/tools`, `PUT /api/tools/:key` (Task 3).
- Produces: `export interface Tool { key: "teams" | "travel"; label: string; description: string; enabled: boolean }`, `export const fetchTools: () => Promise<Tool[]>`, `export async function setToolEnabled(key: Tool["key"], enabled: boolean): Promise<void>` — all from `client/src/api/client.ts`. Task 6 and Task 7 both import these.

- [ ] **Step 1: Add the API functions to `client/src/api/client.ts`**

Append near the other similar settings-style exports (after the `saveAlertSettings` function):

```ts
export interface Tool {
  key: "teams" | "travel";
  label: string;
  description: string;
  enabled: boolean;
}

export const fetchTools = () => getJson<Tool[]>("/api/tools");

export async function setToolEnabled(key: Tool["key"], enabled: boolean): Promise<void> {
  const res = await fetch(
    `${API_BASE}/api/tools/${key}`,
    withCredentials({
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    })
  );
  if (!res.ok) throw new Error("failed to update tool");
}
```

- [ ] **Step 2: Update the import list in `client/src/pages/SetupPage.tsx`**

```ts
// Old:
  fetchAlertSettings,
  saveAlertSettings,
  NEWS_TOPIC_LABELS,

// New:
  fetchAlertSettings,
  saveAlertSettings,
  fetchTools,
  setToolEnabled as apiSetToolEnabled,
  NEWS_TOPIC_LABELS,
```

```ts
// Old:
  type AlertSettings,
} from "../api/client";

// New:
  type AlertSettings,
  type Tool,
} from "../api/client";
```

- [ ] **Step 3: Add state**

```ts
// Old:
  const [alertSettings, setAlertSettings] = useState<AlertSettings>({ enabled: false });
  const [alertSaved, setAlertSaved] = useState(false);

// New:
  const [alertSettings, setAlertSettings] = useState<AlertSettings>({ enabled: false });
  const [alertSaved, setAlertSaved] = useState(false);
  const [tools, setTools] = useState<Tool[]>([]);
```

- [ ] **Step 4: Fetch tools in `load()`**

```ts
// Old:
  async function load() {
    const [p, a, s, f, b, m, ws, nums, ci, sd, al] = await Promise.all([
      fetchProviders(),
      fetchAccounts(),
      fetchSettings(),
      fetchLocalFolders(),
      fetchBriefingSettings(),
      fetchMemoryNotes(),
      fetchWhatsAppStatus(),
      fetchWhatsAppAllowedNumbers(),
      fetchCheckins(),
      fetchTravelDays("schengen", 180),
      fetchAlertSettings(),
    ]);
    setProviders(p);
    setAccounts(a);
    setAssistantName(s.assistantName);
    setPersona(s.persona);
    setFolders(f);
    setBriefing(b);
    setMemoryNotes(m);
    setWhatsAppStatus(ws);
    setAlertSettings(al);
    setAllowedNumbers(nums);
    setCheckins(ci);
    setSchengenDays(sd);
  }

// New:
  async function load() {
    const [p, a, s, f, b, m, ws, nums, ci, sd, al, tl] = await Promise.all([
      fetchProviders(),
      fetchAccounts(),
      fetchSettings(),
      fetchLocalFolders(),
      fetchBriefingSettings(),
      fetchMemoryNotes(),
      fetchWhatsAppStatus(),
      fetchWhatsAppAllowedNumbers(),
      fetchCheckins(),
      fetchTravelDays("schengen", 180),
      fetchAlertSettings(),
      fetchTools(),
    ]);
    setProviders(p);
    setAccounts(a);
    setAssistantName(s.assistantName);
    setPersona(s.persona);
    setFolders(f);
    setBriefing(b);
    setMemoryNotes(m);
    setWhatsAppStatus(ws);
    setAlertSettings(al);
    setAllowedNumbers(nums);
    setCheckins(ci);
    setSchengenDays(sd);
    setTools(tl);
  }
```

- [ ] **Step 5: Add the toggle handler**

```ts
// Old:
  async function handleToggleAlerts(enabled: boolean) {
    const next = { enabled };
    setAlertSettings(next);
    await saveAlertSettings(next);
    setAlertSaved(true);
    setTimeout(() => setAlertSaved(false), 2500);
  }

// New:
  async function handleToggleAlerts(enabled: boolean) {
    const next = { enabled };
    setAlertSettings(next);
    await saveAlertSettings(next);
    setAlertSaved(true);
    setTimeout(() => setAlertSaved(false), 2500);
  }

  async function handleToggleTool(key: Tool["key"], enabled: boolean) {
    setTools((prev) => prev.map((t) => (t.key === key ? { ...t, enabled } : t)));
    await apiSetToolEnabled(key, enabled);
  }
```

- [ ] **Step 6: Add the Tools section and gate Location check-ins**

```tsx
// Old:
      <h2>Location check-ins</h2>
      <div className="card">
        <p className="muted" style={{ marginTop: 0 }}>
          Logged automatically by a phone automation (iOS Shortcuts / Android Tasker) that
          POSTs to <code>/api/checkin</code> when you land somewhere or cross a border — not
          sent via WhatsApp, since that would need a manual tap each time. See the README for
          how to set up the phone-side automation; the shared secret it needs is
          <code> CHECKIN_SECRET</code> in <code>server/.env</code>.
        </p>
        {schengenDays && (
          <div className="banner" style={{ marginBottom: 14 }}>
            Schengen: <strong>{schengenDays.daysPresent} / 90</strong> days used in the last
            180 days ({schengenDays.sinceDate} to {schengenDays.untilDate})
          </div>
        )}
        {checkins.length === 0 ? (
          <p className="muted" style={{ marginTop: 12 }}>
            No check-ins logged yet.
          </p>
        ) : (
          checkins.map((c) => (
            <div key={c.id} className="list-item row" style={{ justifyContent: "space-between" }}>
              <span style={{ fontSize: 13.5 }}>
                {c.city ? `${c.city}, ` : ""}
                {c.country ??
                  (c.latitude != null && c.longitude != null
                    ? `${c.latitude.toFixed(3)}, ${c.longitude.toFixed(3)}`
                    : "Unknown location")}{" "}
                <span className="badge" style={{ fontSize: 11 }}>
                  {c.source === "document" ? "from document" : "phone"}
                </span>
              </span>
              <span className="muted" style={{ fontSize: 12.5 }}>
                {new Date(c.checkedInAt).toLocaleString()}
              </span>
            </div>
          ))
        )}
      </div>

// New:
      <h2>Tools</h2>
      <div className="card">
        <p className="muted" style={{ marginTop: 0 }}>
          Turn optional capabilities on or off — everything else stays as-is either way.
        </p>
        {tools.map((t) => (
          <label key={t.key} className="row" style={{ marginBottom: 10 }}>
            <input
              type="checkbox"
              style={{ width: "auto" }}
              checked={t.enabled}
              onChange={(e) => handleToggleTool(t.key, e.target.checked)}
            />
            <span>
              <strong>{t.label}</strong> — <span className="muted">{t.description}</span>
            </span>
          </label>
        ))}
      </div>

      <h2>Location check-ins</h2>
      {!tools.find((t) => t.key === "travel")?.enabled ? (
        <div className="card muted">
          Travel tracking isn't enabled — turn it on in the Tools section above.
        </div>
      ) : (
      <div className="card">
        <p className="muted" style={{ marginTop: 0 }}>
          Logged automatically by a phone automation (iOS Shortcuts / Android Tasker) that
          POSTs to <code>/api/checkin</code> when you land somewhere or cross a border — not
          sent via WhatsApp, since that would need a manual tap each time. See the README for
          how to set up the phone-side automation; the shared secret it needs is
          <code> CHECKIN_SECRET</code> in <code>server/.env</code>.
        </p>
        {schengenDays && (
          <div className="banner" style={{ marginBottom: 14 }}>
            Schengen: <strong>{schengenDays.daysPresent} / 90</strong> days used in the last
            180 days ({schengenDays.sinceDate} to {schengenDays.untilDate})
          </div>
        )}
        {checkins.length === 0 ? (
          <p className="muted" style={{ marginTop: 12 }}>
            No check-ins logged yet.
          </p>
        ) : (
          checkins.map((c) => (
            <div key={c.id} className="list-item row" style={{ justifyContent: "space-between" }}>
              <span style={{ fontSize: 13.5 }}>
                {c.city ? `${c.city}, ` : ""}
                {c.country ??
                  (c.latitude != null && c.longitude != null
                    ? `${c.latitude.toFixed(3)}, ${c.longitude.toFixed(3)}`
                    : "Unknown location")}{" "}
                <span className="badge" style={{ fontSize: 11 }}>
                  {c.source === "document" ? "from document" : "phone"}
                </span>
              </span>
              <span className="muted" style={{ fontSize: 12.5 }}>
                {new Date(c.checkedInAt).toLocaleString()}
              </span>
            </div>
          ))
        )}
      </div>
      )}
```

- [ ] **Step 7: Manually verify**

Run: `cd server && npm run dev` (terminal 1), `cd client && npm run dev` (terminal 2). Open the Setup page:
1. Confirm a new "Tools" section appears with two unchecked toggles (Teams chat, Travel / Schengen day tracker).
2. Confirm the "Location check-ins" section below it shows "Travel tracking isn't enabled..." instead of the Schengen banner/check-in list.
3. Check the Travel toggle — confirm the Location check-ins section switches to its normal content within the same render (no reload needed).
4. Reload the page — confirm the toggle state persisted (still checked).

- [ ] **Step 8: Commit**

```bash
git add client/src/api/client.ts client/src/pages/SetupPage.tsx
git commit -m "feat: add Tools section to Setup page, gate Location check-ins on travel toggle"
```

---

### Task 6: Client — Chats page inline "not enabled" state

**Files:**
- Modify: `client/src/pages/ChatsPage.tsx`

**Interfaces:**
- Consumes: `fetchTools`, `type Tool` from `client/src/api/client.js` (Task 5).

- [ ] **Step 1: Replace `client/src/pages/ChatsPage.tsx` with the full updated file**

```tsx
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchChats, fetchTools, type ChatThread } from "../api/client";

export function ChatsPage() {
  const [chats, setChats] = useState<ChatThread[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [teamsEnabled, setTeamsEnabled] = useState<boolean | null>(null);

  async function load(q?: string) {
    setLoading(true);
    setError(null);
    try {
      setChats(await fetchChats(q));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchTools()
      .then((tools) => setTeamsEnabled(tools.find((t) => t.key === "teams")?.enabled ?? false))
      .catch(() => setTeamsEnabled(false));
  }, []);

  useEffect(() => {
    if (teamsEnabled) load();
  }, [teamsEnabled]);

  if (teamsEnabled === null) return null; // brief flash-avoidance, same pattern as RequireAuth

  if (!teamsEnabled) {
    return (
      <div className="main">
        <h1>Chats</h1>
        <div className="card">
          <p className="muted" style={{ marginTop: 0 }}>
            Teams chat isn't enabled for your account.
          </p>
          <Link to="/setup">
            <button>Turn it on in Setup</button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="main">
      <h1>Chats</h1>
      <form
        className="row"
        style={{ marginBottom: 16 }}
        onSubmit={(e) => {
          e.preventDefault();
          load(query || undefined);
        }}
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search Microsoft Teams messages…"
        />
        <button type="submit">Search</button>
      </form>

      <div className="card">
        {loading && <p className="muted">Loading…</p>}
        {error && <p className="error">{error}</p>}
        {!loading && !error && chats.length === 0 && (
          <p className="muted">
            No Teams chats — connect a Microsoft account on the Setup page.
          </p>
        )}
        {chats.map((c) => (
          <div key={`${c.accountId}-${c.id}`} className="list-item">
            <a href={c.link} target="_blank" rel="noreferrer">
              <div className="title">
                <span>{c.topic}</span>
                <span className="badge">{c.accountEmail}</span>
              </div>
              <div className="sub">{c.lastSender}</div>
              <div className="sub">{c.preview}</div>
            </a>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Manually verify**

With Teams toggled off (default): open `/chats` — confirm it shows "Teams chat isn't enabled for your account." with a working "Turn it on in Setup" link (navigates to `/setup`). Toggle Teams on from Setup, return to `/chats` — confirm the normal search bar + thread list now renders (or the "No Teams chats — connect a Microsoft account" message if no Microsoft account is connected).

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/ChatsPage.tsx
git commit -m "feat: show inline enable-prompt on Chats page when Teams tool is off"
```

---

### Task 7: Client — Onboarding lightweight tool-picker step

**Files:**
- Modify: `client/src/pages/OnboardingPage.tsx`

**Interfaces:**
- Consumes: `fetchTools`, `setToolEnabled`, `type Tool` from `client/src/api/client.js` (Task 5).

- [ ] **Step 1: Replace `client/src/pages/OnboardingPage.tsx` with the full updated file**

```tsx
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  fetchProviders,
  fetchAccounts,
  fetchWhatsAppAllowedNumbers,
  saveWhatsAppAllowedNumbers,
  fetchTools,
  setToolEnabled as apiSetToolEnabled,
  loginUrl,
  type ProviderInfo,
  type Account,
  type Tool,
} from "../api/client";

// First-run flow for a just-invited user with no connected accounts yet — reached right after
// login (see authRoutes.ts's callback: redirects here when listAccounts(user.id) is empty).
// Deliberately never blocks — "skip for now" always works, since the full Setup page covers the
// same ground later.
export function OnboardingPage() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [numbers, setNumbers] = useState<string[]>([]);
  const [newNumber, setNewNumber] = useState("");
  const [saving, setSaving] = useState(false);
  const [tools, setTools] = useState<Tool[]>([]);
  const [params] = useSearchParams();
  const navigate = useNavigate();

  useEffect(() => {
    Promise.all([
      fetchProviders(),
      fetchAccounts(),
      fetchWhatsAppAllowedNumbers(),
      fetchTools(),
    ]).then(([p, a, n, t]) => {
      setProviders(p);
      setAccounts(a);
      setNumbers(n);
      setTools(t);
    });
  }, [params]);

  async function addNumber() {
    const trimmed = newNumber.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      const next = [...numbers, trimmed];
      await saveWhatsAppAllowedNumbers(next);
      setNumbers(next);
      setNewNumber("");
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleTool(key: Tool["key"], enabled: boolean) {
    setTools((prev) => prev.map((t) => (t.key === key ? { ...t, enabled } : t)));
    await apiSetToolEnabled(key, enabled);
  }

  return (
    <div className="main">
      <h1>Let's set up your hub</h1>
      <p className="muted" style={{ marginTop: -12, marginBottom: 24 }}>
        A few quick steps — or skip straight to the assistant and do this later from Setup.
      </p>

      <h2>1. Connect an account</h2>
      {accounts.length > 0 && (
        <div className="banner">
          {accounts.length} account{accounts.length > 1 ? "s" : ""} connected.
        </div>
      )}
      {providers.map((p) => (
        <div key={p.provider} className="card row" style={{ justifyContent: "space-between" }}>
          <div>
            <strong>{p.label}</strong>
            <div className="muted">
              {p.configured ? "Ready to connect." : "Not available on this deployment."}
            </div>
          </div>
          {p.configured ? (
            <a href={loginUrl(p.loginPath)}>
              <button>Connect</button>
            </a>
          ) : (
            <button disabled>Not configured</button>
          )}
        </div>
      ))}

      <h2>2. Add your WhatsApp number</h2>
      <p className="muted" style={{ marginTop: -4 }}>
        So you can message your assistant from your phone — country code, no spaces or +, e.g.
        447911123456.
      </p>
      <div className="card">
        <div className="row">
          <input
            value={newNumber}
            onChange={(e) => setNewNumber(e.target.value)}
            placeholder="447911123456"
          />
          <button onClick={addNumber} disabled={saving || !newNumber.trim()}>
            Add
          </button>
        </div>
        {numbers.length > 0 && (
          <div style={{ marginTop: 10 }}>
            {numbers.map((n) => (
              <div key={n} className="list-item">
                {n}
              </div>
            ))}
          </div>
        )}
      </div>

      <h2>3. Pick your tools (optional)</h2>
      <p className="muted" style={{ marginTop: -4 }}>
        Turn on whichever of these you want — you can change this anytime from Setup.
      </p>
      <div className="card">
        {tools.map((t) => (
          <label key={t.key} className="row" style={{ marginBottom: 10 }}>
            <input
              type="checkbox"
              style={{ width: "auto" }}
              checked={t.enabled}
              onChange={(e) => handleToggleTool(t.key, e.target.checked)}
            />
            <span>
              <strong>{t.label}</strong> — <span className="muted">{t.description}</span>
            </span>
          </label>
        ))}
      </div>

      <div className="row" style={{ marginTop: 24 }}>
        <button onClick={() => navigate("/assistant")}>Go to my assistant</button>
        <Link to="/assistant" className="muted" style={{ fontSize: 13.5 }}>
          skip for now
        </Link>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Manually verify**

As a newly-invited user reaching `/onboarding` for the first time: confirm a new "3. Pick your tools (optional)" section appears with both toggles unchecked by default. Check one, navigate to `/assistant` via "skip for now", then go to `/setup` — confirm the Tools section there reflects the same state (persisted, shared with onboarding). Confirm clicking "skip for now" or "Go to my assistant" without touching any toggle still works exactly as before (never blocks).

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/OnboardingPage.tsx
git commit -m "feat: add lightweight tool-picker step to onboarding"
```

---

## Self-Review Notes

- **Spec coverage**: data model (Task 2), server-side filtering + defense-in-depth (Task 4), API routes (Task 3), Setup Tools section + Location check-ins gating (Task 5), Chats page gating (Task 6), onboarding step (Task 7) — every section of the spec has a task. Test infrastructure (Task 1) was added because none existed and the spec explicitly calls for coverage of the branching logic.
- **Placeholder scan**: no TBD/TODO markers; every step has real, complete code.
- **Type consistency**: `ToolKey` is defined once in `store.ts` (Task 2) and imported everywhere else (`toolsRoutes.ts`, `assistant.ts`) rather than redefined. `Tool` (the client-side shape, includes `label`/`description`/`enabled`) is defined once in `client.ts` (Task 5) and imported by both `ChatsPage.tsx` and `OnboardingPage.tsx`. Function names (`getEnabledTools`, `setToolEnabled`, `buildToolsForOwner`, `fetchTools`) are used identically across every task that references them.
