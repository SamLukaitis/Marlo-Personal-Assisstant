# Business Edition — Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-user "business" edition of Marlowe for UK sole traders whose receipts, bills and payments land in a Marlo-owned ledger, categorised against HMRC SA103 boxes.

**Architecture:** `users.edition` + an edition registry (`server/src/editions/`) that general code consults through four narrow hooks (tool list, tool dispatch, system prompt, receipt/mail/briefing events). All business logic lives in `server/src/business/` and is only reached through the registry. The ledger is three new SQLite tables created by a migration in `db/migrations/businessLedger.ts`.

**Tech Stack:** TypeScript (ESM), Express, better-sqlite3, Anthropic SDK (`claude-haiku-4-5` via `ASSISTANT_MODEL_SIMPLE`), vitest.

**Spec:** `docs/superpowers/specs/2026-10-16-business-edition-design.md` (phase A = build order steps 1–5).

## Global Constraints

- Edition ids are exactly `"general" | "business"`; default `"general"`; existing users unchanged.
- General code never imports from `server/src/business/`; only `server/src/editions/` does.
- Every business tool handler refuses unless the owner's edition is `business`.
- Money is integer pence, GBP only. Never hard-delete ledger rows; every edit writes `ledger_entry_history`.
- Totals count only `business_use='business' AND status='confirmed' AND deleted_at IS NULL`.
- UK tax year runs 6 April – 5 April.
- Model guesses never produce `confirmed` entries — only the user (chat, or confirming a review) or remembered counterparty choices do.
- Income detected from email is never auto-confirmed (`needs_review` only) and never sends a proactive message.
- `deleteUserCompletely` must remove every new owner-scoped row (`findRemainingOwnerReferences` must return `[]`).
- Run tests from `server/`: `npx vitest run <file>`. Baseline: 132 files / 1745 tests green.

## Review Focus

1. **Non-GBP receipt** (e.g. a €12 café receipt) → must not be logged as 1200 pence GBP; it is skipped. Pinned in Task 6.
2. **Same receipt arriving twice** (WhatsApp resend, email + photo of the same doc row re-run, scheduler retry on income mail) → exactly one ledger entry. Pinned in Tasks 3, 6, 7.
3. **Counterparty spelling variants** ("SCREWFIX LTD", "Screwfix", "screwfix.") → one remembered category. Pinned in Task 3.
4. **Dates on 5 and 6 April** → land in different tax years. Pinned in Task 3.
5. **General-edition user** sends a receipt / gets an invoice email → no ledger rows, no "add it to your books" text, no business tools. Pinned in Tasks 2 and 6.

## File map

| File | Responsibility |
|---|---|
| `server/src/db/store.ts` (modify) | `users.edition`, `invited_phones.edition`, edition getters/setters, `getDb()`, ledger cleanup in `deleteUserCompletely` |
| `server/src/db/migrations/businessLedger.ts` (create) | ledger tables + indexes |
| `server/src/editions/index.ts` (create) | registry: `getEdition`, tool filter, tool dispatch, receipt/mail/briefing hooks |
| `server/src/business/taxYear.ts` | tax-year maths |
| `server/src/business/ledgerStore.ts` | ledger SQL (insert/dedupe, update+history, soft delete, list, summary, counterparty memory) |
| `server/src/business/categories.ts` | SA103 category list + hints |
| `server/src/business/categorise.ts` | model guess (pure prompt/parse + one API call) |
| `server/src/business/ledger.ts` | `recordExpense`, `recordIncome`, `confirmEntry` — the rules |
| `server/src/business/profile.ts` | business profile in settings |
| `server/src/business/tools.ts` | assistant tool definitions + handler |
| `server/src/business/prompt.ts` | business system-prompt section |
| `server/src/business/receipts.ts` | receipt → ledger hook |
| `server/src/business/incomeDetector.ts` | payment-received email detection |
| `server/src/business/briefing.ts` | money lines for the briefing |
| `server/src/ai/assistant.ts` (modify) | consult registry in `buildToolsForOwner`, `runTool`, `buildSystemPrompt` |
| `server/src/services/documents.ts` (modify) | call receipt hook |
| `server/src/services/attention.ts` (modify) | business "add it to your books" offer |
| `server/src/services/importantEmailAlerts.ts` (modify) | call mail hook |
| `server/src/services/briefing.ts` (modify) | `extraFacts` |
| `server/src/scripts/invite.ts`, `server/src/scripts/setEdition.ts`, `server/package.json` | edition assignment CLI |

---

### Task 1: Edition column and store accessors

**Files:**
- Modify: `server/src/db/store.ts` (after the `migrateUsersEmailNullable(...)` call ~line 355; `addInvitedPhone` ~line 3996; `addPhoneNumberForUser` ~line 2139)
- Test: `server/src/db/edition.test.ts`

**Interfaces:**
- Produces: `type EditionId = "general" | "business"`, `EDITION_IDS`, `isEditionId(x): x is EditionId`, `getUserEdition(userId): EditionId`, `setUserEdition(userId, edition)`, `addInvitedPhone(phone, edition?: EditionId)`, `getDb(): Database.Database`.

- [ ] **Step 1: Write the failing test** — `server/src/db/edition.test.ts`

```ts
import { describe, it, expect } from "vitest";
import {
  findOrCreateUserByEmail,
  findOrCreateUserByPhone,
  getUserEdition,
  setUserEdition,
  addInvitedPhone,
  isEditionId,
} from "./store.js";

let n = 0;
const email = () => `edition-${Date.now()}-${++n}@example.com`;
const phone = () => `4479${String(Date.now()).slice(-6)}${String(++n).padStart(2, "0")}`;

describe("user edition", () => {
  it("defaults to general", () => {
    expect(getUserEdition(findOrCreateUserByEmail(email()).id)).toBe("general");
  });

  it("can be set to business and back", () => {
    const u = findOrCreateUserByEmail(email());
    setUserEdition(u.id, "business");
    expect(getUserEdition(u.id)).toBe("business");
    setUserEdition(u.id, "general");
    expect(getUserEdition(u.id)).toBe("general");
  });

  it("rejects unknown editions", () => {
    const u = findOrCreateUserByEmail(email());
    expect(() => setUserEdition(u.id, "family" as never)).toThrow();
    expect(isEditionId("family")).toBe(false);
  });

  it("applies the invite's edition when the invited phone is bound to a new user", () => {
    const p = phone();
    addInvitedPhone(p, "business");
    const u = findOrCreateUserByPhone(p);
    expect(getUserEdition(u.id)).toBe("business");
  });

  it("an invite without an edition leaves the user on general", () => {
    const p = phone();
    addInvitedPhone(p);
    expect(getUserEdition(findOrCreateUserByPhone(p).id)).toBe("general");
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/db/edition.test.ts` — Expected: FAIL (`getUserEdition` not exported).

- [ ] **Step 3: Implement in `store.ts`**

After `migrateUsersEmailNullable(...)` (so a users-table rebuild can never drop the column):

```ts
// Business edition (docs/superpowers/specs/2026-10-16-business-edition-design.md): which product a
// user is on. Added after the users rebuild above so that rebuild never has to know about it.
const userColumnsAfterRebuild = (db.prepare(`PRAGMA table_info(users)`).all() as { name: string }[]).map((c) => c.name);
if (!userColumnsAfterRebuild.includes("edition")) {
  db.exec(`ALTER TABLE users ADD COLUMN edition TEXT NOT NULL DEFAULT 'general'`);
}
const invitedPhoneColumns = (db.prepare(`PRAGMA table_info(invited_phones)`).all() as { name: string }[]).map((c) => c.name);
if (!invitedPhoneColumns.includes("edition")) {
  db.exec(`ALTER TABLE invited_phones ADD COLUMN edition TEXT`);
}
```

Near the admin helpers (~line 3550):

```ts
export const EDITION_IDS = ["general", "business"] as const;
export type EditionId = (typeof EDITION_IDS)[number];

export function isEditionId(x: unknown): x is EditionId {
  return typeof x === "string" && (EDITION_IDS as readonly string[]).includes(x);
}

export function getUserEdition(userId: number): EditionId {
  const row = db.prepare(`SELECT edition FROM users WHERE id = ?`).get(userId) as { edition: string } | undefined;
  return isEditionId(row?.edition) ? row.edition : "general";
}

export function setUserEdition(userId: number, edition: EditionId): void {
  if (!isEditionId(edition)) throw new Error(`Unknown edition: ${String(edition)}`);
  db.prepare(`UPDATE users SET edition = ? WHERE id = ?`).run(edition, userId);
}

// For server/src/business/ledgerStore.ts, which keeps its SQL next to its own logic rather than
// growing this file further. Nothing else should need it.
export function getDb(): Database.Database {
  return db;
}
```

Replace `addInvitedPhone`:

```ts
// Used by server/src/scripts/invite.ts — the app owner's manual "grant this person a hub" tool.
// An edition on the invite is applied when the number is first bound to an account.
export function addInvitedPhone(phone: string, edition?: EditionId): void {
  if (edition !== undefined && !isEditionId(edition)) throw new Error(`Unknown edition: ${String(edition)}`);
  db.prepare(
    `INSERT INTO invited_phones (phone, invited_at, edition) VALUES (?, ?, ?)
     ON CONFLICT(phone) DO UPDATE SET edition = COALESCE(excluded.edition, invited_phones.edition)`
  ).run(normalizePhone(phone), Date.now(), edition ?? null);
}
```

In `addPhoneNumberForUser`, inside the `bind` transaction, in the `if (!row) { ... }` block right after the INSERT:

```ts
      const invited = db.prepare(`SELECT edition FROM invited_phones WHERE phone = ?`).get(normalized) as
        | { edition: string | null }
        | undefined;
      if (isEditionId(invited?.edition)) {
        db.prepare(`UPDATE users SET edition = ? WHERE id = ?`).run(invited.edition, ownerId);
      }
```

- [ ] **Step 4: Run** `npx vitest run src/db/edition.test.ts src/db` — Expected: PASS (whole `db` folder, to catch invite regressions).

- [ ] **Step 5: Commit** `git add -A server/src/db && git commit -m "feat(business): per-user edition column and invite edition"`

---

### Task 2: Edition registry wired into the assistant

**Files:**
- Create: `server/src/editions/index.ts`
- Modify: `server/src/ai/assistant.ts` (`buildToolsForOwner` ~1233, `runTool` ~1316 and its `default:` ~1947, `buildSystemPrompt` return array ~2174)
- Test: `server/src/editions/editions.test.ts`

**Interfaces:**
- Consumes: `getUserEdition`, `EditionId` (Task 1).
- Produces:
  ```ts
  export interface Edition {
    id: EditionId;
    brandName: string;
    excludeTools: readonly string[];
    extraTools: Anthropic.Tool[];
    promptSection(ownerId: number): string;
    logsReceipts: boolean;
  }
  export function getEdition(ownerId: number): Edition;
  export function applyEditionTools(ownerId: number, tools: Anthropic.ToolUnion[]): Anthropic.ToolUnion[];
  export function isToolExcluded(ownerId: number, name: string): boolean;
  export async function runEditionTool(ownerId: number, name: string, input: Record<string, unknown>): Promise<unknown | undefined>;
  ```
  Later tasks add `onReceiptSaved`, `onAutomatedMail`, `editionBriefingFacts` to this file and fill `extraTools` / `runEditionTool` / `promptSection` from `business/`.

- [ ] **Step 1: Write the failing test** — `server/src/editions/editions.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { findOrCreateUserByEmail, setUserEdition } from "../db/store.js";
import { getEdition, isToolExcluded } from "./index.js";
import { buildToolsForOwner, buildSystemPrompt } from "../ai/assistant.js";

let n = 0;
const user = (edition: "general" | "business") => {
  const u = findOrCreateUserByEmail(`ed-${Date.now()}-${++n}@example.com`);
  setUserEdition(u.id, edition);
  return u.id;
};
const names = (ownerId: number) =>
  buildToolsForOwner(ownerId).map((t) => ("name" in t ? t.name : "")).filter(Boolean);

describe("edition registry", () => {
  it("general users get the general edition and the full tool list", () => {
    const id = user("general");
    expect(getEdition(id).id).toBe("general");
    expect(names(id)).toContain("get_news");
    expect(names(id)).toContain("create_trip");
  });

  it("business users lose travel, news, markets and the old expense tools", () => {
    const id = user("business");
    const tools = names(id);
    for (const t of ["get_news", "get_markets", "create_trip", "link_to_trip", "get_trip_contents", "list_expenses", "undo_expense"]) {
      expect(tools).not.toContain(t);
      expect(isToolExcluded(id, t)).toBe(true);
    }
    expect(tools).toContain("create_calendar_event");
    expect(tools).toContain("set_reminder");
  });

  it("keeps the cache breakpoint on the last tool for business users", () => {
    const tools = buildToolsForOwner(user("business"));
    expect((tools[tools.length - 1] as { cache_control?: unknown }).cache_control).toBeDefined();
    expect(tools.filter((t) => (t as { cache_control?: unknown }).cache_control).length).toBe(1);
  });

  it("adds the business section to the system prompt only for business users", () => {
    expect(buildSystemPrompt(user("business"))).toContain("BUSINESS EDITION");
    expect(buildSystemPrompt(user("general"))).not.toContain("BUSINESS EDITION");
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/editions/editions.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Create `server/src/editions/index.ts`**

```ts
// The only bridge between general Marlowe code and edition-specific code (see
// docs/superpowers/specs/2026-10-16-business-edition-design.md §1). General code asks this module;
// it never imports server/src/business/ directly.
import type Anthropic from "@anthropic-ai/sdk";
import { getUserEdition, type EditionId } from "../db/store.js";

export interface Edition {
  id: EditionId;
  brandName: string;
  excludeTools: readonly string[];
  extraTools: Anthropic.Tool[];
  promptSection(ownerId: number): string;
  logsReceipts: boolean;
}

const GENERAL: Edition = {
  id: "general",
  brandName: "Marlowe",
  excludeTools: [],
  extraTools: [],
  promptSection: () => "",
  logsReceipts: false,
};

const BUSINESS: Edition = {
  id: "business",
  brandName: "Marlo for Business",
  excludeTools: [
    "get_news",
    "get_markets",
    "create_trip",
    "link_to_trip",
    "get_trip_contents",
    "list_travel_checkins",
    "count_travel_days",
    // The ledger replaces these: undo_expense hard-deletes, which the books must never do.
    "list_expenses",
    "undo_expense",
  ],
  extraTools: [],
  promptSection: () =>
    "BUSINESS EDITION: this user is a UK sole trader and you are their admin assistant for the business — receipts, bills, payments, email and diary.",
  logsReceipts: true,
};

const EDITIONS: Record<EditionId, Edition> = { general: GENERAL, business: BUSINESS };

export function getEdition(ownerId: number): Edition {
  return EDITIONS[getUserEdition(ownerId)];
}

export function isToolExcluded(ownerId: number, name: string): boolean {
  return getEdition(ownerId).excludeTools.includes(name);
}

export function applyEditionTools(ownerId: number, tools: Anthropic.ToolUnion[]): Anthropic.ToolUnion[] {
  const edition = getEdition(ownerId);
  return [
    ...tools.filter((t) => !("name" in t) || !edition.excludeTools.includes(t.name)),
    ...edition.extraTools,
  ];
}

// undefined = not an edition tool; runTool falls through to its own "unknown tool" error.
export async function runEditionTool(
  _ownerId: number,
  _name: string,
  _input: Record<string, unknown>
): Promise<unknown | undefined> {
  return undefined;
}
```

- [ ] **Step 4: Wire into `assistant.ts`**

Import: `import { applyEditionTools, getEdition, isToolExcluded, runEditionTool } from "../editions/index.js";`

`buildToolsForOwner` — replace `const result = [...ALWAYS_ON_TOOLS]; ... PHONE_ACTION_TOOLS);` tail so the edition filter runs before the cache breakpoint:

```ts
  const enabled = getEnabledTools(ownerId);
  const assembled: Anthropic.ToolUnion[] = [...ALWAYS_ON_TOOLS];
  for (const key of TOOL_KEYS) {
    if (enabled.has(key)) assembled.push(...CONDITIONAL_TOOLS[key]);
  }
  if (isMapsConfigured()) assembled.push(...MAPS_TOOLS);
  if (isPhoneActionsConfigured()) assembled.push(...PHONE_ACTION_TOOLS);
  const result = applyEditionTools(ownerId, assembled);
```

`runTool` — first lines of the body:

```ts
  if (isToolExcluded(ownerId, name)) return { error: `tool not available: ${name}` };
```

`runTool` `default:` branch:

```ts
    default: {
      const handled = await runEditionTool(ownerId, name, input);
      return handled !== undefined ? handled : { error: `unknown tool: ${name}` };
    }
```

`buildSystemPrompt` return array — add after `phonePromptSection(ownerId),`:

```ts
    getEdition(ownerId).promptSection(ownerId),
```

- [ ] **Step 5: Run** `npx vitest run src/editions src/ai` — Expected: PASS.

- [ ] **Step 6: Commit** `git add -A server/src/editions server/src/ai/assistant.ts && git commit -m "feat(business): edition registry filters tools and adds prompt section"`

---

### Task 3: Ledger tables, tax year and ledger store

**Files:**
- Create: `server/src/db/migrations/businessLedger.ts`, `server/src/business/taxYear.ts`, `server/src/business/ledgerStore.ts`
- Modify: `server/src/db/store.ts` (call migration next to `migrateReplayParkMarker(db)`; `deleteUserCompletely` before `DELETE FROM users`)
- Test: `server/src/business/taxYear.test.ts`, `server/src/business/ledgerStore.test.ts`

**Interfaces:**
- Produces (`ledgerStore.ts`):
  ```ts
  export type Direction = "in" | "out";
  export type BusinessUse = "business" | "personal" | "unsure";
  export type LedgerStatus = "confirmed" | "needs_review";
  export type LedgerSource = "whatsapp_doc" | "email" | "chat" | "bank";
  export type ChangedBy = "user" | "assistant" | "system";
  export interface LedgerEntry { id: number; ownerId: number; direction: Direction; amountPence: number; occurredOn: string; counterparty: string | null; description: string | null; category: string | null; businessUse: BusinessUse; status: LedgerStatus; source: LedgerSource; documentId: number | null; sourceRef: string | null; deletedAt: number | null; createdAt: number; updatedAt: number; }
  export interface NewLedgerEntry { direction: Direction; amountPence: number; occurredOn: string; counterparty?: string | null; description?: string | null; category?: string | null; businessUse: BusinessUse; status: LedgerStatus; source: LedgerSource; documentId?: number | null; sourceRef?: string | null; }
  export type LedgerPatch = Partial<Pick<LedgerEntry, "amountPence" | "occurredOn" | "counterparty" | "description" | "category" | "businessUse" | "status">>;
  export function insertLedgerEntry(ownerId: number, e: NewLedgerEntry): { entry: LedgerEntry; created: boolean };
  export function getLedgerEntry(ownerId: number, id: number): LedgerEntry | null;
  export function updateLedgerEntry(ownerId: number, id: number, patch: LedgerPatch, changedBy: ChangedBy): LedgerEntry | null;
  export function softDeleteLedgerEntry(ownerId: number, id: number, changedBy: ChangedBy): LedgerEntry | null;
  export function listLedgerEntries(ownerId: number, f?: { from?: string; to?: string; direction?: Direction; status?: LedgerStatus; category?: string; limit?: number }): LedgerEntry[];
  export function listLedgerHistory(ownerId: number, entryId: number): { changedAt: number; changedBy: ChangedBy; before: unknown; after: unknown }[];
  export function summariseLedger(ownerId: number, from: string, to: string): { incomePence: number; expensesPence: number; byCategory: Record<string, number>; needsReviewCount: number };
  export function counterpartyKey(name: string): string;
  export function getCounterpartyChoice(ownerId: number, counterparty: string): { category: string | null; businessUse: BusinessUse } | null;
  export function rememberCounterpartyChoice(ownerId: number, counterparty: string, category: string | null, businessUse: BusinessUse): void;
  ```
- Produces (`taxYear.ts`): `taxYearFor(dateISO: string): { label: string; start: string; end: string }`, `currentTaxYear(now?: Date)`.

- [ ] **Step 1: Write failing tests**

`server/src/business/taxYear.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { taxYearFor } from "./taxYear.js";

describe("taxYearFor", () => {
  it("5 April belongs to the year that started the previous April", () => {
    expect(taxYearFor("2027-04-05")).toEqual({ label: "2026-27", start: "2026-04-06", end: "2027-04-05" });
  });
  it("6 April starts a new tax year", () => {
    expect(taxYearFor("2027-04-06")).toEqual({ label: "2027-28", start: "2027-04-06", end: "2028-04-05" });
  });
  it("January belongs to the year that started the previous April", () => {
    expect(taxYearFor("2027-01-15").label).toBe("2026-27");
  });
  it("rejects malformed dates", () => {
    expect(() => taxYearFor("15/01/2027")).toThrow();
  });
});
```

`server/src/business/ledgerStore.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { findOrCreateUserByEmail, deleteUserCompletely, findRemainingOwnerReferences } from "../db/store.js";
import {
  insertLedgerEntry,
  updateLedgerEntry,
  softDeleteLedgerEntry,
  listLedgerEntries,
  listLedgerHistory,
  summariseLedger,
  counterpartyKey,
  getCounterpartyChoice,
  rememberCounterpartyChoice,
  type NewLedgerEntry,
} from "./ledgerStore.js";

let n = 0;
const owner = () => findOrCreateUserByEmail(`ledger-${Date.now()}-${++n}@example.com`).id;
const out = (over: Partial<NewLedgerEntry> = {}): NewLedgerEntry => ({
  direction: "out", amountPence: 4820, occurredOn: "2026-10-10", counterparty: "Screwfix",
  category: "repairs", businessUse: "business", status: "confirmed", source: "chat", ...over,
});

describe("ledgerStore", () => {
  it("inserts and lists entries newest first", () => {
    const id = owner();
    insertLedgerEntry(id, out({ occurredOn: "2026-10-01" }));
    insertLedgerEntry(id, out({ occurredOn: "2026-10-05" }));
    expect(listLedgerEntries(id).map((e) => e.occurredOn)).toEqual(["2026-10-05", "2026-10-01"]);
  });

  it("rejects non-positive or fractional amounts and bad dates", () => {
    const id = owner();
    expect(() => insertLedgerEntry(id, out({ amountPence: 0 }))).toThrow();
    expect(() => insertLedgerEntry(id, out({ amountPence: 12.5 }))).toThrow();
    expect(() => insertLedgerEntry(id, out({ occurredOn: "10/10/2026" }))).toThrow();
  });

  it("dedupes on source + sourceRef and reports created=false", () => {
    const id = owner();
    const a = insertLedgerEntry(id, out({ source: "whatsapp_doc", sourceRef: "doc:1:0" }));
    const b = insertLedgerEntry(id, out({ source: "whatsapp_doc", sourceRef: "doc:1:0", amountPence: 999 }));
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.entry.id).toBe(a.entry.id);
    expect(listLedgerEntries(id)).toHaveLength(1);
  });

  it("entries without a sourceRef are never deduped", () => {
    const id = owner();
    insertLedgerEntry(id, out());
    insertLedgerEntry(id, out());
    expect(listLedgerEntries(id)).toHaveLength(2);
  });

  it("writes history on update and soft delete, and hides deleted rows", () => {
    const id = owner();
    const { entry } = insertLedgerEntry(id, out());
    updateLedgerEntry(id, entry.id, { category: "cost_of_goods" }, "user");
    softDeleteLedgerEntry(id, entry.id, "user");
    expect(listLedgerEntries(id)).toHaveLength(0);
    const history = listLedgerHistory(id, entry.id);
    expect(history).toHaveLength(2);
    expect((history[0].after as { category: string }).category).toBe("cost_of_goods");
    expect((history[1].after as { deletedAt: number | null }).deletedAt).not.toBeNull();
  });

  it("does not touch another owner's entry", () => {
    const a = owner();
    const b = owner();
    const { entry } = insertLedgerEntry(a, out());
    expect(updateLedgerEntry(b, entry.id, { category: "other" }, "user")).toBeNull();
    expect(softDeleteLedgerEntry(b, entry.id, "user")).toBeNull();
  });

  it("summary counts only confirmed, business, non-deleted entries in range", () => {
    const id = owner();
    insertLedgerEntry(id, out({ amountPence: 1000 }));
    insertLedgerEntry(id, out({ amountPence: 2000, category: "phone_office" }));
    insertLedgerEntry(id, out({ amountPence: 5000, businessUse: "personal" }));
    insertLedgerEntry(id, out({ amountPence: 7000, status: "needs_review" }));
    insertLedgerEntry(id, out({ amountPence: 9000, occurredOn: "2025-01-01" }));
    const gone = insertLedgerEntry(id, out({ amountPence: 3000 })).entry;
    softDeleteLedgerEntry(id, gone.id, "user");
    insertLedgerEntry(id, { direction: "in", amountPence: 45000, occurredOn: "2026-10-12", counterparty: "Dave", businessUse: "business", status: "confirmed", source: "chat" });
    expect(summariseLedger(id, "2026-04-06", "2027-04-05")).toEqual({
      incomePence: 45000,
      expensesPence: 3000,
      byCategory: { repairs: 1000, phone_office: 2000 },
      needsReviewCount: 1,
    });
  });

  it("normalises counterparty names for remembered choices", () => {
    expect(counterpartyKey("SCREWFIX LTD")).toBe("screwfix");
    expect(counterpartyKey(" Screwfix. ")).toBe("screwfix");
    expect(counterpartyKey("B&Q plc")).toBe("b q");
    const id = owner();
    rememberCounterpartyChoice(id, "Screwfix Limited", "repairs", "business");
    expect(getCounterpartyChoice(id, "SCREWFIX")).toEqual({ category: "repairs", businessUse: "business" });
    expect(getCounterpartyChoice(id, "Wickes")).toBeNull();
  });

  it("deleteUserCompletely removes every ledger row", () => {
    const id = owner();
    const { entry } = insertLedgerEntry(id, out());
    updateLedgerEntry(id, entry.id, { category: "other" }, "user");
    rememberCounterpartyChoice(id, "Screwfix", "repairs", "business");
    deleteUserCompletely(id);
    expect(findRemainingOwnerReferences(id)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/business` — Expected: FAIL (modules missing).

- [ ] **Step 3: Create `server/src/db/migrations/businessLedger.ts`**

```ts
import type Database from "better-sqlite3";

// Business edition ledger (docs/superpowers/specs/2026-10-16-business-edition-design.md §2).
// document_id and entry_id deliberately carry no REFERENCES to documents/ledger_entries, same
// reasoning as memoryGraph.ts: no new FK-ordering hazard for deleteUserCompletely or for a
// document being removed. owner_id does reference users, so findRemainingOwnerReferences checks it.
export function migrateBusinessLedger(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ledger_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL REFERENCES users(id),
      direction TEXT NOT NULL CHECK (direction IN ('in','out')),
      amount_pence INTEGER NOT NULL CHECK (amount_pence > 0),
      occurred_on TEXT NOT NULL,
      counterparty TEXT,
      description TEXT,
      category TEXT,
      business_use TEXT NOT NULL CHECK (business_use IN ('business','personal','unsure')),
      status TEXT NOT NULL CHECK (status IN ('confirmed','needs_review')),
      source TEXT NOT NULL CHECK (source IN ('whatsapp_doc','email','chat','bank')),
      document_id INTEGER,
      source_ref TEXT,
      deleted_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_owner_date ON ledger_entries(owner_id, occurred_on);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_source_ref
      ON ledger_entries(owner_id, source, source_ref) WHERE source_ref IS NOT NULL;
    CREATE TABLE IF NOT EXISTS ledger_entry_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id INTEGER NOT NULL,
      owner_id INTEGER NOT NULL REFERENCES users(id),
      changed_at INTEGER NOT NULL,
      changed_by TEXT NOT NULL,
      before_json TEXT NOT NULL,
      after_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_history_entry ON ledger_entry_history(entry_id);
    CREATE TABLE IF NOT EXISTS ledger_counterparty_choices (
      owner_id INTEGER NOT NULL REFERENCES users(id),
      counterparty_key TEXT NOT NULL,
      category TEXT,
      business_use TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (owner_id, counterparty_key)
    );
  `);
}
```

In `store.ts`: `import { migrateBusinessLedger } from "./migrations/businessLedger.js";` and call `migrateBusinessLedger(db);` directly after `migrateReplayParkMarker(db);`. In `deleteUserCompletely`, just before `db.prepare(\`DELETE FROM user_phone_numbers WHERE user_id = ?\`)`:

```ts
    db.prepare(`DELETE FROM ledger_entry_history WHERE owner_id = ?`).run(ownerId);
    db.prepare(`DELETE FROM ledger_entries WHERE owner_id = ?`).run(ownerId);
    db.prepare(`DELETE FROM ledger_counterparty_choices WHERE owner_id = ?`).run(ownerId);
```

- [ ] **Step 4: Create `server/src/business/taxYear.ts`**

```ts
// UK tax year: 6 April to 5 April. Dates are plain YYYY-MM-DD strings throughout the ledger.
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function taxYearFor(dateISO: string): { label: string; start: string; end: string } {
  const m = ISO_DATE.exec(dateISO);
  if (!m) throw new Error(`Expected YYYY-MM-DD, got "${dateISO}"`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const startYear = mo > 4 || (mo === 4 && d >= 6) ? y : y - 1;
  return {
    label: `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`,
    start: `${startYear}-04-06`,
    end: `${startYear + 1}-04-05`,
  };
}

export function currentTaxYear(now: Date = new Date()): { label: string; start: string; end: string } {
  return taxYearFor(now.toISOString().slice(0, 10));
}
```

- [ ] **Step 5: Create `server/src/business/ledgerStore.ts`**

```ts
// SQL for the business ledger (tables: db/migrations/businessLedger.ts). Rules that decide WHAT
// gets written live in ledger.ts; this file only guarantees integrity: validation, dedupe,
// owner scoping, history on every change, and soft deletes only.
import { getDb } from "../db/store.js";

export type Direction = "in" | "out";
export type BusinessUse = "business" | "personal" | "unsure";
export type LedgerStatus = "confirmed" | "needs_review";
export type LedgerSource = "whatsapp_doc" | "email" | "chat" | "bank";
export type ChangedBy = "user" | "assistant" | "system";

export interface LedgerEntry {
  id: number;
  ownerId: number;
  direction: Direction;
  amountPence: number;
  occurredOn: string;
  counterparty: string | null;
  description: string | null;
  category: string | null;
  businessUse: BusinessUse;
  status: LedgerStatus;
  source: LedgerSource;
  documentId: number | null;
  sourceRef: string | null;
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface NewLedgerEntry {
  direction: Direction;
  amountPence: number;
  occurredOn: string;
  counterparty?: string | null;
  description?: string | null;
  category?: string | null;
  businessUse: BusinessUse;
  status: LedgerStatus;
  source: LedgerSource;
  documentId?: number | null;
  sourceRef?: string | null;
}

export type LedgerPatch = Partial<
  Pick<LedgerEntry, "amountPence" | "occurredOn" | "counterparty" | "description" | "category" | "businessUse" | "status">
>;

const SELECT = `SELECT id, owner_id AS ownerId, direction, amount_pence AS amountPence, occurred_on AS occurredOn,
  counterparty, description, category, business_use AS businessUse, status, source, document_id AS documentId,
  source_ref AS sourceRef, deleted_at AS deletedAt, created_at AS createdAt, updated_at AS updatedAt
  FROM ledger_entries`;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validate(e: Pick<LedgerEntry, "amountPence" | "occurredOn">): void {
  if (!Number.isInteger(e.amountPence) || e.amountPence <= 0) {
    throw new Error(`amountPence must be a positive whole number of pence, got ${e.amountPence}`);
  }
  if (!ISO_DATE.test(e.occurredOn) || Number.isNaN(Date.parse(e.occurredOn))) {
    throw new Error(`occurredOn must be YYYY-MM-DD, got "${e.occurredOn}"`);
  }
}

export function getLedgerEntry(ownerId: number, id: number): LedgerEntry | null {
  return (getDb().prepare(`${SELECT} WHERE owner_id = ? AND id = ?`).get(ownerId, id) as LedgerEntry | undefined) ?? null;
}

export function insertLedgerEntry(ownerId: number, e: NewLedgerEntry): { entry: LedgerEntry; created: boolean } {
  validate(e);
  const db = getDb();
  if (e.sourceRef) {
    const existing = db
      .prepare(`${SELECT} WHERE owner_id = ? AND source = ? AND source_ref = ?`)
      .get(ownerId, e.source, e.sourceRef) as LedgerEntry | undefined;
    if (existing) return { entry: existing, created: false };
  }
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO ledger_entries (owner_id, direction, amount_pence, occurred_on, counterparty, description, category,
         business_use, status, source, document_id, source_ref, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      ownerId, e.direction, e.amountPence, e.occurredOn, e.counterparty ?? null, e.description ?? null,
      e.category ?? null, e.businessUse, e.status, e.source, e.documentId ?? null, e.sourceRef ?? null, now, now
    );
  return { entry: getLedgerEntry(ownerId, Number(info.lastInsertRowid))!, created: true };
}

function writeWithHistory(ownerId: number, id: number, changedBy: ChangedBy, apply: (before: LedgerEntry) => void): LedgerEntry | null {
  const db = getDb();
  return db.transaction(() => {
    const before = getLedgerEntry(ownerId, id);
    if (!before) return null;
    apply(before);
    const after = getLedgerEntry(ownerId, id)!;
    db.prepare(
      `INSERT INTO ledger_entry_history (entry_id, owner_id, changed_at, changed_by, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, ownerId, Date.now(), changedBy, JSON.stringify(before), JSON.stringify(after));
    return after;
  })();
}

const PATCH_COLUMNS: Record<keyof LedgerPatch, string> = {
  amountPence: "amount_pence",
  occurredOn: "occurred_on",
  counterparty: "counterparty",
  description: "description",
  category: "category",
  businessUse: "business_use",
  status: "status",
};

export function updateLedgerEntry(ownerId: number, id: number, patch: LedgerPatch, changedBy: ChangedBy): LedgerEntry | null {
  const keys = (Object.keys(patch) as (keyof LedgerPatch)[]).filter((k) => patch[k] !== undefined);
  return writeWithHistory(ownerId, id, changedBy, (before) => {
    validate({ amountPence: patch.amountPence ?? before.amountPence, occurredOn: patch.occurredOn ?? before.occurredOn });
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${PATCH_COLUMNS[k]} = ?`).join(", ");
    getDb()
      .prepare(`UPDATE ledger_entries SET ${sets}, updated_at = ? WHERE owner_id = ? AND id = ?`)
      .run(...keys.map((k) => patch[k] as string | number | null), Date.now(), ownerId, id);
  });
}

export function softDeleteLedgerEntry(ownerId: number, id: number, changedBy: ChangedBy): LedgerEntry | null {
  return writeWithHistory(ownerId, id, changedBy, () => {
    const now = Date.now();
    getDb().prepare(`UPDATE ledger_entries SET deleted_at = ?, updated_at = ? WHERE owner_id = ? AND id = ?`).run(now, now, ownerId, id);
  });
}

export function listLedgerEntries(
  ownerId: number,
  f: { from?: string; to?: string; direction?: Direction; status?: LedgerStatus; category?: string; limit?: number } = {}
): LedgerEntry[] {
  const where = ["owner_id = ?", "deleted_at IS NULL"];
  const args: (string | number)[] = [ownerId];
  if (f.from) { where.push("occurred_on >= ?"); args.push(f.from); }
  if (f.to) { where.push("occurred_on <= ?"); args.push(f.to); }
  if (f.direction) { where.push("direction = ?"); args.push(f.direction); }
  if (f.status) { where.push("status = ?"); args.push(f.status); }
  if (f.category) { where.push("category = ?"); args.push(f.category); }
  args.push(f.limit ?? 50);
  return getDb()
    .prepare(`${SELECT} WHERE ${where.join(" AND ")} ORDER BY occurred_on DESC, id DESC LIMIT ?`)
    .all(...args) as LedgerEntry[];
}

export function listLedgerHistory(ownerId: number, entryId: number) {
  return (
    getDb()
      .prepare(
        `SELECT changed_at AS changedAt, changed_by AS changedBy, before_json AS b, after_json AS a
         FROM ledger_entry_history WHERE owner_id = ? AND entry_id = ? ORDER BY id ASC`
      )
      .all(ownerId, entryId) as { changedAt: number; changedBy: ChangedBy; b: string; a: string }[]
  ).map((r) => ({ changedAt: r.changedAt, changedBy: r.changedBy, before: JSON.parse(r.b), after: JSON.parse(r.a) }));
}

export function summariseLedger(ownerId: number, from: string, to: string) {
  const db = getDb();
  const counted = `owner_id = ? AND deleted_at IS NULL AND status = 'confirmed' AND business_use = 'business' AND occurred_on BETWEEN ? AND ?`;
  const totals = db
    .prepare(`SELECT direction, SUM(amount_pence) AS total FROM ledger_entries WHERE ${counted} GROUP BY direction`)
    .all(ownerId, from, to) as { direction: Direction; total: number }[];
  const cats = db
    .prepare(`SELECT category, SUM(amount_pence) AS total FROM ledger_entries WHERE ${counted} AND direction = 'out' GROUP BY category`)
    .all(ownerId, from, to) as { category: string | null; total: number }[];
  const review = db
    .prepare(`SELECT COUNT(*) AS c FROM ledger_entries WHERE owner_id = ? AND deleted_at IS NULL AND status = 'needs_review'`)
    .get(ownerId) as { c: number };
  return {
    incomePence: totals.find((t) => t.direction === "in")?.total ?? 0,
    expensesPence: totals.find((t) => t.direction === "out")?.total ?? 0,
    byCategory: Object.fromEntries(cats.map((c) => [c.category ?? "uncategorised", c.total])),
    needsReviewCount: review.c,
  };
}

const COMPANY_SUFFIXES = /\b(ltd|limited|plc|llp|inc|uk|co)\b/g;

export function counterpartyKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(COMPANY_SUFFIXES, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function getCounterpartyChoice(ownerId: number, counterparty: string): { category: string | null; businessUse: BusinessUse } | null {
  const key = counterpartyKey(counterparty);
  if (!key) return null;
  return (
    (getDb()
      .prepare(`SELECT category, business_use AS businessUse FROM ledger_counterparty_choices WHERE owner_id = ? AND counterparty_key = ?`)
      .get(ownerId, key) as { category: string | null; businessUse: BusinessUse } | undefined) ?? null
  );
}

export function rememberCounterpartyChoice(ownerId: number, counterparty: string, category: string | null, businessUse: BusinessUse): void {
  const key = counterpartyKey(counterparty);
  if (!key) return;
  getDb()
    .prepare(
      `INSERT INTO ledger_counterparty_choices (owner_id, counterparty_key, category, business_use, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(owner_id, counterparty_key) DO UPDATE SET category = excluded.category, business_use = excluded.business_use, updated_at = excluded.updated_at`
    )
    .run(ownerId, key, category, businessUse, Date.now());
}
```

- [ ] **Step 6: Run** `npx vitest run src/business src/db` — Expected: PASS.

- [ ] **Step 7: Commit** `git add -A server/src && git commit -m "feat(business): ledger tables, tax year and ledger store"`

---

### Task 4: Categories, categoriser and ledger rules

**Files:**
- Create: `server/src/business/categories.ts`, `server/src/business/categorise.ts`, `server/src/business/profile.ts`, `server/src/business/ledger.ts`
- Test: `server/src/business/categorise.test.ts`, `server/src/business/ledger.test.ts`

**Interfaces:**
- Consumes: Task 3 store functions.
- Produces:
  ```ts
  // categories.ts
  export const SA103_CATEGORIES: readonly { key: string; label: string; hints: string }[];
  export type CategoryKey = (typeof SA103_CATEGORIES)[number]["key"];
  export function isCategoryKey(x: unknown): x is CategoryKey;
  export function categoryLabel(key: string | null): string;
  // categorise.ts
  export interface CategoriseItem { counterparty: string; description?: string | null; amountPence: number }
  export interface CategoryGuess { category: CategoryKey; businessUse: BusinessUse }
  export function buildCategorisePrompt(item: CategoriseItem, businessDescription: string | null): string;
  export function parseCategoryGuess(input: unknown): CategoryGuess | null;
  export async function guessCategory(ownerId: number, item: CategoriseItem): Promise<CategoryGuess | null>;
  // profile.ts
  export function getBusinessDescription(ownerId: number): string | null;
  export function setBusinessDescription(ownerId: number, description: string): void;
  // ledger.ts
  export type Guesser = (ownerId: number, item: CategoriseItem) => Promise<CategoryGuess | null>;
  export async function recordExpense(ownerId: number, input: { amountPence: number; occurredOn: string; counterparty: string; description?: string | null; source: LedgerSource; documentId?: number | null; sourceRef?: string | null; category?: CategoryKey; businessUse?: BusinessUse }, guess?: Guesser): Promise<{ entry: LedgerEntry; created: boolean }>;
  export function recordIncome(ownerId: number, input: { amountPence: number; occurredOn: string; counterparty: string; description?: string | null; source: LedgerSource; sourceRef?: string | null }): { entry: LedgerEntry; created: boolean };
  export function confirmEntry(ownerId: number, id: number, choice: { category?: CategoryKey; businessUse?: BusinessUse }): LedgerEntry | null;
  ```

- [ ] **Step 1: Write failing tests**

`server/src/business/categorise.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { SA103_CATEGORIES, isCategoryKey } from "./categories.js";
import { buildCategorisePrompt, parseCategoryGuess } from "./categorise.js";

describe("categories", () => {
  it("covers the SA103 expense boxes", () => {
    expect(SA103_CATEGORIES.map((c) => c.key)).toEqual([
      "cost_of_goods", "car_van_travel", "staff", "premises", "repairs", "phone_office",
      "advertising", "finance_charges", "professional_fees", "other",
    ]);
    expect(isCategoryKey("repairs")).toBe(true);
    expect(isCategoryKey("entertainment")).toBe(false);
  });
});

describe("buildCategorisePrompt", () => {
  it("includes every category, the item and the business description", () => {
    const p = buildCategorisePrompt({ counterparty: "Screwfix", amountPence: 4820 }, "plumber");
    for (const c of SA103_CATEGORIES) expect(p).toContain(c.key);
    expect(p).toContain("Screwfix");
    expect(p).toContain("£48.20");
    expect(p).toContain("plumber");
  });
});

describe("parseCategoryGuess", () => {
  it("accepts a valid guess", () => {
    expect(parseCategoryGuess({ category: "repairs", business_use: "business" })).toEqual({ category: "repairs", businessUse: "business" });
  });
  it("rejects unknown categories or uses", () => {
    expect(parseCategoryGuess({ category: "entertainment", business_use: "business" })).toBeNull();
    expect(parseCategoryGuess({ category: "repairs", business_use: "maybe" })).toBeNull();
    expect(parseCategoryGuess(undefined)).toBeNull();
  });
});
```

`server/src/business/ledger.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { findOrCreateUserByEmail } from "../db/store.js";
import { recordExpense, recordIncome, confirmEntry } from "./ledger.js";
import { getCounterpartyChoice, rememberCounterpartyChoice } from "./ledgerStore.js";

let n = 0;
const owner = () => findOrCreateUserByEmail(`rules-${Date.now()}-${++n}@example.com`).id;
const base = { amountPence: 4820, occurredOn: "2026-10-10", counterparty: "Screwfix", source: "whatsapp_doc" as const };

describe("recordExpense", () => {
  it("a category the user stated is confirmed and remembered", async () => {
    const id = owner();
    const guess = vi.fn();
    const { entry } = await recordExpense(id, { ...base, source: "chat", category: "repairs", businessUse: "business" }, guess);
    expect(entry.status).toBe("confirmed");
    expect(guess).not.toHaveBeenCalled();
    expect(getCounterpartyChoice(id, "SCREWFIX LTD")).toEqual({ category: "repairs", businessUse: "business" });
  });

  it("a remembered counterparty is confirmed without asking the model", async () => {
    const id = owner();
    rememberCounterpartyChoice(id, "Screwfix", "repairs", "business");
    const guess = vi.fn();
    const { entry } = await recordExpense(id, base, guess);
    expect(entry).toMatchObject({ status: "confirmed", category: "repairs", businessUse: "business" });
    expect(guess).not.toHaveBeenCalled();
  });

  it("a model guess is stored but needs review", async () => {
    const id = owner();
    const { entry } = await recordExpense(id, base, async () => ({ category: "repairs", businessUse: "business" }));
    expect(entry).toMatchObject({ status: "needs_review", category: "repairs", businessUse: "business" });
  });

  it("no guess at all still records the entry for review", async () => {
    const id = owner();
    const { entry } = await recordExpense(id, base, async () => null);
    expect(entry).toMatchObject({ status: "needs_review", category: null, businessUse: "unsure" });
  });

  it("a failing guesser does not lose the entry", async () => {
    const id = owner();
    const { entry } = await recordExpense(id, base, async () => { throw new Error("api down"); });
    expect(entry.status).toBe("needs_review");
  });
});

describe("recordIncome", () => {
  it("income told in chat is confirmed", () => {
    expect(recordIncome(owner(), { amountPence: 45000, occurredOn: "2026-10-12", counterparty: "Dave", source: "chat" }).entry.status).toBe("confirmed");
  });
  it("income spotted in email needs review", () => {
    expect(recordIncome(owner(), { amountPence: 45000, occurredOn: "2026-10-12", counterparty: "Stripe", source: "email", sourceRef: "email:1:abc" }).entry.status).toBe("needs_review");
  });
});

describe("confirmEntry", () => {
  it("confirms, applies the choice and remembers the counterparty", async () => {
    const id = owner();
    const { entry } = await recordExpense(id, base, async () => ({ category: "repairs", businessUse: "business" }));
    const confirmed = confirmEntry(id, entry.id, { category: "cost_of_goods" });
    expect(confirmed).toMatchObject({ status: "confirmed", category: "cost_of_goods", businessUse: "business" });
    expect(getCounterpartyChoice(id, "Screwfix")?.category).toBe("cost_of_goods");
  });
  it("marking personal clears nothing but excludes it from totals", async () => {
    const id = owner();
    const { entry } = await recordExpense(id, base, async () => null);
    expect(confirmEntry(id, entry.id, { businessUse: "personal" })).toMatchObject({ status: "confirmed", businessUse: "personal" });
  });
  it("an unsure entry can't be confirmed without a business/personal answer", async () => {
    const id = owner();
    const { entry } = await recordExpense(id, base, async () => null);
    expect(() => confirmEntry(id, entry.id, { category: "repairs" })).toThrow(/business or personal/);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/business` — Expected: FAIL.

- [ ] **Step 3: Create `categories.ts`**

```ts
// The expense boxes on HMRC's short self-employment form (SA103S). Hints are what the categoriser
// and the assistant read; keep them in plain English.
export const SA103_CATEGORIES = [
  { key: "cost_of_goods", label: "Cost of goods", hints: "materials, stock or parts bought to resell or build into a job you charge for" },
  { key: "car_van_travel", label: "Car, van and travel", hints: "fuel, parking, train/bus fares, van repairs, hotels on work trips (not commuting to a regular workplace)" },
  { key: "staff", label: "Staff costs", hints: "wages or subcontractor payments to people working for you" },
  { key: "premises", label: "Rent, rates, power and insurance", hints: "workshop/office rent, business rates, electricity, business insurance" },
  { key: "repairs", label: "Repairs and maintenance", hints: "repairing tools, equipment or premises; small tools and consumables (e.g. Screwfix, Toolstation)" },
  { key: "phone_office", label: "Phone, stationery and office", hints: "phone and broadband bills, software subscriptions, postage, printing, stationery" },
  { key: "advertising", label: "Advertising", hints: "ads, website hosting, business cards, listings (NOT client entertainment, which isn't allowable)" },
  { key: "finance_charges", label: "Bank and finance charges", hints: "bank fees, card processing fees (Stripe, SumUp fees), loan interest" },
  { key: "professional_fees", label: "Accountancy and legal", hints: "accountant, bookkeeper, solicitor, professional memberships" },
  { key: "other", label: "Other allowable expenses", hints: "anything else wholly for the business that fits none of the above" },
] as const;

export type CategoryKey = (typeof SA103_CATEGORIES)[number]["key"];

export function isCategoryKey(x: unknown): x is CategoryKey {
  return typeof x === "string" && SA103_CATEGORIES.some((c) => c.key === x);
}

export function categoryLabel(key: string | null): string {
  return SA103_CATEGORIES.find((c) => c.key === key)?.label ?? "Uncategorised";
}

export function formatPence(pence: number): string {
  return `£${(pence / 100).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
```

- [ ] **Step 4: Create `profile.ts`**

```ts
import { getSetting, setSetting } from "../db/store.js";

const KEY = "business_description";

export function getBusinessDescription(ownerId: number): string | null {
  return getSetting(ownerId, KEY)?.trim() || null;
}

export function setBusinessDescription(ownerId: number, description: string): void {
  const clean = description.trim().slice(0, 200);
  if (!clean) throw new Error("Business description can't be empty.");
  setSetting(ownerId, KEY, clean);
}
```

- [ ] **Step 5: Create `categorise.ts`**

```ts
// One small-model guess at an expense's SA103 box. A guess is only ever a suggestion: ledger.ts
// stores it as needs_review. The API call itself isn't unit-tested (no repo precedent for mocking
// the SDK, same as importantEmailClassifier.ts); the prompt and parser are.
import Anthropic from "@anthropic-ai/sdk";
import { recordApiUsage } from "../db/store.js";
import { SA103_CATEGORIES, isCategoryKey, formatPence, type CategoryKey } from "./categories.js";
import type { BusinessUse } from "./ledgerStore.js";
import { getBusinessDescription } from "./profile.js";

export interface CategoriseItem {
  counterparty: string;
  description?: string | null;
  amountPence: number;
}

export interface CategoryGuess {
  category: CategoryKey;
  businessUse: BusinessUse;
}

const MODEL = process.env.ASSISTANT_MODEL_SIMPLE ?? "claude-haiku-4-5";
let client: Anthropic | null = null;
const getClient = () => (client ??= new Anthropic());

const TOOL: Anthropic.Tool = {
  name: "categorise_expense",
  description: "Report the best HMRC expense category for this purchase and whether it is likely business or personal.",
  input_schema: {
    type: "object",
    properties: {
      category: { type: "string", enum: SA103_CATEGORIES.map((c) => c.key) },
      business_use: { type: "string", enum: ["business", "personal", "unsure"] },
    },
    required: ["category", "business_use"],
  },
};

export function buildCategorisePrompt(item: CategoriseItem, businessDescription: string | null): string {
  return [
    `A UK sole trader${businessDescription ? ` (${businessDescription})` : ""} spent ${formatPence(item.amountPence)} at "${item.counterparty}"${
      item.description ? ` — ${item.description}` : ""
    }.`,
    "Pick the single best HMRC self-employment expense category:",
    ...SA103_CATEGORIES.map((c) => `- ${c.key}: ${c.label} — ${c.hints}`),
    "Say business_use=personal for obviously personal spending (groceries, restaurants, clothes, entertainment), unsure if it could be either.",
  ].join("\n");
}

export function parseCategoryGuess(input: unknown): CategoryGuess | null {
  const i = input as { category?: unknown; business_use?: unknown } | undefined;
  if (!i || !isCategoryKey(i.category)) return null;
  if (i.business_use !== "business" && i.business_use !== "personal" && i.business_use !== "unsure") return null;
  return { category: i.category, businessUse: i.business_use };
}

export async function guessCategory(ownerId: number, item: CategoriseItem): Promise<CategoryGuess | null> {
  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 200,
    tools: [TOOL],
    tool_choice: { type: "tool", name: TOOL.name },
    messages: [{ role: "user", content: buildCategorisePrompt(item, getBusinessDescription(ownerId)) }],
  });
  recordApiUsage(
    ownerId, "background", MODEL, "business_categoriser",
    response.usage?.input_tokens ?? 0, response.usage?.output_tokens ?? 0,
    response.usage?.cache_read_input_tokens ?? 0, response.usage?.cache_creation_input_tokens ?? 0
  );
  const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  return parseCategoryGuess(toolUse?.input);
}
```

- [ ] **Step 6: Create `ledger.ts`**

```ts
// The rules for what goes into the books (spec §3). Only the user's own word, or a choice they
// made before for the same counterparty, produces a confirmed entry; a model guess is pre-filled
// but always waits for review.
import type { CategoryKey } from "./categories.js";
import { guessCategory, type CategoriseItem, type CategoryGuess } from "./categorise.js";
import {
  insertLedgerEntry,
  getLedgerEntry,
  updateLedgerEntry,
  getCounterpartyChoice,
  rememberCounterpartyChoice,
  type BusinessUse,
  type LedgerEntry,
  type LedgerSource,
} from "./ledgerStore.js";

export type Guesser = (ownerId: number, item: CategoriseItem) => Promise<CategoryGuess | null>;

export async function recordExpense(
  ownerId: number,
  input: {
    amountPence: number;
    occurredOn: string;
    counterparty: string;
    description?: string | null;
    source: LedgerSource;
    documentId?: number | null;
    sourceRef?: string | null;
    category?: CategoryKey;
    businessUse?: BusinessUse;
  },
  guess: Guesser = guessCategory
): Promise<{ entry: LedgerEntry; created: boolean }> {
  const common = {
    direction: "out" as const,
    amountPence: input.amountPence,
    occurredOn: input.occurredOn,
    counterparty: input.counterparty,
    description: input.description ?? null,
    source: input.source,
    documentId: input.documentId ?? null,
    sourceRef: input.sourceRef ?? null,
  };

  if (input.businessUse && input.businessUse !== "unsure" && (input.category || input.businessUse === "personal")) {
    rememberCounterpartyChoice(ownerId, input.counterparty, input.category ?? null, input.businessUse);
    return insertLedgerEntry(ownerId, { ...common, category: input.category ?? null, businessUse: input.businessUse, status: "confirmed" });
  }

  const remembered = getCounterpartyChoice(ownerId, input.counterparty);
  if (remembered && remembered.businessUse !== "unsure") {
    return insertLedgerEntry(ownerId, { ...common, category: remembered.category, businessUse: remembered.businessUse, status: "confirmed" });
  }

  let guessed: CategoryGuess | null = null;
  try {
    guessed = await guess(ownerId, { counterparty: input.counterparty, description: input.description, amountPence: input.amountPence });
  } catch (err) {
    console.error("business/ledger: category guess failed; recording for review without one", err);
  }
  return insertLedgerEntry(ownerId, {
    ...common,
    category: input.category ?? guessed?.category ?? null,
    businessUse: guessed?.businessUse ?? "unsure",
    status: "needs_review",
  });
}

export function recordIncome(
  ownerId: number,
  input: { amountPence: number; occurredOn: string; counterparty: string; description?: string | null; source: LedgerSource; sourceRef?: string | null }
): { entry: LedgerEntry; created: boolean } {
  return insertLedgerEntry(ownerId, {
    direction: "in",
    amountPence: input.amountPence,
    occurredOn: input.occurredOn,
    counterparty: input.counterparty,
    description: input.description ?? null,
    businessUse: "business",
    status: input.source === "chat" ? "confirmed" : "needs_review",
    source: input.source,
    sourceRef: input.sourceRef ?? null,
  });
}

export function confirmEntry(
  ownerId: number,
  id: number,
  choice: { category?: CategoryKey; businessUse?: BusinessUse }
): LedgerEntry | null {
  const before = getLedgerEntry(ownerId, id);
  if (!before || before.deletedAt) return null;
  const businessUse = choice.businessUse ?? before.businessUse;
  if (businessUse === "unsure") throw new Error("Need to know if this is business or personal before confirming it.");
  const category = choice.category ?? before.category;
  const after = updateLedgerEntry(ownerId, id, { category, businessUse, status: "confirmed" }, "user");
  if (after?.direction === "out" && after.counterparty) {
    rememberCounterpartyChoice(ownerId, after.counterparty, after.category, after.businessUse);
  }
  return after;
}
```

- [ ] **Step 7: Run** `npx vitest run src/business` — Expected: PASS.

- [ ] **Step 8: Commit** `git add -A server/src/business && git commit -m "feat(business): SA103 categories, categoriser and ledger rules"`

---

### Task 5: Business assistant tools and prompt section

**Files:**
- Create: `server/src/business/tools.ts`, `server/src/business/prompt.ts`
- Modify: `server/src/editions/index.ts` (business `extraTools`, `promptSection`, `runEditionTool`)
- Test: `server/src/business/tools.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces: `BUSINESS_TOOLS: Anthropic.Tool[]`, `BUSINESS_TOOL_NAMES: ReadonlySet<string>`, `runBusinessTool(ownerId, name, input): Promise<unknown>`, `businessPromptSection(ownerId): string`, `periodRange(period, today): { from: string; to: string }`.

- [ ] **Step 1: Write the failing test** — `server/src/business/tools.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { findOrCreateUserByEmail, setUserEdition } from "../db/store.js";
import { runTool, buildToolsForOwner, buildSystemPrompt } from "../ai/assistant.js";
import { periodRange } from "./tools.js";
import { listLedgerEntries } from "./ledgerStore.js";

let n = 0;
const user = (edition: "general" | "business") => {
  const u = findOrCreateUserByEmail(`tools-${Date.now()}-${++n}@example.com`);
  setUserEdition(u.id, edition);
  return u.id;
};

describe("business tools", () => {
  it("are offered to business users only", () => {
    const has = (id: number) => buildToolsForOwner(id).some((t) => "name" in t && t.name === "log_expense");
    expect(has(user("business"))).toBe(true);
    expect(has(user("general"))).toBe(false);
  });

  it("refuse to run for a general user", async () => {
    const res = await runTool(user("general"), "log_income", { amount: 450, date: "2026-10-12", from: "Dave" });
    expect(res).toMatchObject({ error: expect.stringContaining("business") });
  });

  it("log_income and log_expense write confirmed entries; amounts are pounds in, pence stored", async () => {
    const id = user("business");
    await runTool(id, "log_income", { amount: 450, date: "2026-10-12", from: "Dave" });
    await runTool(id, "log_expense", { amount: 32.5, date: "2026-10-12", paid_to: "Shell", category: "car_van_travel", business_use: "business" });
    const rows = listLedgerEntries(id);
    expect(rows.map((r) => [r.direction, r.amountPence, r.status])).toEqual([
      ["out", 3250, "confirmed"],
      ["in", 45000, "confirmed"],
    ]);
  });

  it("rejects a bad amount with an error the model can read", async () => {
    const res = await runTool(user("business"), "log_income", { amount: -5, date: "2026-10-12", from: "Dave" });
    expect(res).toMatchObject({ error: expect.any(String) });
  });

  it("confirm_ledger_entry and remove_ledger_entry work by id", async () => {
    const id = user("business");
    const { entry } = (await runTool(id, "log_expense", { amount: 10, date: "2026-10-12", paid_to: "Tesco", business_use: "personal" })) as { entry: { id: number } };
    expect(await runTool(id, "remove_ledger_entry", { entry_id: entry.id })).toMatchObject({ ok: true });
    expect(listLedgerEntries(id)).toHaveLength(0);
  });

  it("get_money_summary reports pounds for the tax year", async () => {
    const id = user("business");
    await runTool(id, "log_income", { amount: 450, date: "2026-10-12", from: "Dave" });
    const res = (await runTool(id, "get_money_summary", { period: "tax_year", today: "2026-10-16" })) as { income: string };
    expect(res.income).toBe("£450.00");
  });

  it("set_business_profile shows up in the prompt", async () => {
    const id = user("business");
    await runTool(id, "set_business_profile", { description: "plumber in Leeds" });
    expect(buildSystemPrompt(id)).toContain("plumber in Leeds");
  });

  it("the prompt lists entries waiting for review", async () => {
    const id = user("business");
    await runTool(id, "log_expense", { amount: 48.2, date: "2026-10-12", paid_to: "Screwfix" }); // no business_use → needs review
    expect(buildSystemPrompt(id)).toMatch(/Screwfix.*£48\.20/);
  });
});

describe("periodRange", () => {
  it("this_week starts Monday", () => {
    expect(periodRange("this_week", "2026-10-16")).toEqual({ from: "2026-10-12", to: "2026-10-16" });
  });
  it("last_week is the previous Monday to Sunday", () => {
    expect(periodRange("last_week", "2026-10-16")).toEqual({ from: "2026-10-05", to: "2026-10-11" });
  });
  it("tax_year runs from 6 April", () => {
    expect(periodRange("tax_year", "2026-10-16")).toEqual({ from: "2026-04-06", to: "2026-10-16" });
  });
});
```

Note: `log_expense` without `business_use` and with no remembered counterparty calls the real `guessCategory`. To keep tests offline, `runBusinessTool` must skip the model when `process.env.VITEST` is set? **No** — instead `log_expense` passes a guesser that returns `null` (the assistant already knows the item; if the user didn't say, the review question is the right outcome). Chat-logged expenses never call the model.

- [ ] **Step 2: Run** `npx vitest run src/business/tools.test.ts` — Expected: FAIL.

- [ ] **Step 3: Create `tools.ts`**

```ts
// Assistant tools for the business edition. Reached only via editions/index.ts. Amounts cross the
// model boundary in pounds (what people say) and are stored in pence.
import type Anthropic from "@anthropic-ai/sdk";
import { DateTime } from "luxon";
import { getUserEdition } from "../db/store.js";
import { SA103_CATEGORIES, isCategoryKey, formatPence, categoryLabel } from "./categories.js";
import { recordExpense, recordIncome, confirmEntry } from "./ledger.js";
import { listLedgerEntries, softDeleteLedgerEntry, updateLedgerEntry, summariseLedger, type BusinessUse, type LedgerEntry } from "./ledgerStore.js";
import { setBusinessDescription } from "./profile.js";
import { taxYearFor } from "./taxYear.js";

const CATEGORY_ENUM = SA103_CATEGORIES.map((c) => c.key);
const PERIODS = ["this_week", "last_week", "this_month", "last_month", "tax_year", "last_tax_year"] as const;
type Period = (typeof PERIODS)[number];

export const BUSINESS_TOOLS: Anthropic.Tool[] = [
  {
    name: "set_business_profile",
    description: "Save a one-line description of what the user's business does (e.g. 'plumber in Leeds', 'wedding photographer'). Call it as soon as they tell you; it improves expense categorising.",
    input_schema: { type: "object", properties: { description: { type: "string" } }, required: ["description"] },
  },
  {
    name: "log_expense",
    description:
      "Add money the user spent to their books when they tell you about it in chat (receipts they send are added automatically — don't re-add those). amount is in pounds. Set category and business_use only if the user said or it's unambiguous; otherwise leave them out and the entry waits for review.",
    input_schema: {
      type: "object",
      properties: {
        amount: { type: "number", description: "Pounds, e.g. 32.50" },
        date: { type: "string", description: "YYYY-MM-DD; call get_current_time first for relative days" },
        paid_to: { type: "string" },
        description: { type: "string" },
        category: { type: "string", enum: CATEGORY_ENUM },
        business_use: { type: "string", enum: ["business", "personal"] },
      },
      required: ["amount", "date", "paid_to"],
    },
  },
  {
    name: "log_income",
    description: "Add money the user was paid to their books when they tell you in chat ('Dave paid me £450'). amount is in pounds.",
    input_schema: {
      type: "object",
      properties: {
        amount: { type: "number" },
        date: { type: "string", description: "YYYY-MM-DD" },
        from: { type: "string", description: "Who paid" },
        description: { type: "string" },
      },
      required: ["amount", "date", "from"],
    },
  },
  {
    name: "list_ledger",
    description: "List entries in the user's books, newest first. Use status=needs_review to find what's waiting for the user's check.",
    input_schema: {
      type: "object",
      properties: {
        period: { type: "string", enum: [...PERIODS] },
        direction: { type: "string", enum: ["in", "out"] },
        status: { type: "string", enum: ["confirmed", "needs_review"] },
        category: { type: "string", enum: CATEGORY_ENUM },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "confirm_ledger_entry",
    description:
      "Record the user's answer to a review question about an entry: business or personal, and optionally a different category. Their choice is remembered for that supplier so they aren't asked again. Ask with ask_user_choice buttons, not prose.",
    input_schema: {
      type: "object",
      properties: {
        entry_id: { type: "number" },
        business_use: { type: "string", enum: ["business", "personal"] },
        category: { type: "string", enum: CATEGORY_ENUM },
      },
      required: ["entry_id"],
    },
  },
  {
    name: "update_ledger_entry",
    description: "Correct an entry's amount (pounds), date, who it was with, or description. Every change is kept in the entry's history.",
    input_schema: {
      type: "object",
      properties: {
        entry_id: { type: "number" },
        amount: { type: "number" },
        date: { type: "string" },
        counterparty: { type: "string" },
        description: { type: "string" },
      },
      required: ["entry_id"],
    },
  },
  {
    name: "remove_ledger_entry",
    description: "Take an entry out of the books (wrong, duplicate, not real). It's kept in history, not erased. Confirm with ask_user_choice first unless the user was explicit.",
    input_schema: { type: "object", properties: { entry_id: { type: "number" } }, required: ["entry_id"] },
  },
  {
    name: "get_money_summary",
    description: "Totals of business money in and out for a period, by HMRC category, plus how many entries need review. Personal and unreviewed entries are not counted.",
    input_schema: {
      type: "object",
      properties: { period: { type: "string", enum: [...PERIODS] }, today: { type: "string", description: "Omit; for tests" } },
      required: ["period"],
    },
  },
];

export const BUSINESS_TOOL_NAMES: ReadonlySet<string> = new Set(BUSINESS_TOOLS.map((t) => t.name));

export function periodRange(period: Period, today: string): { from: string; to: string } {
  const d = DateTime.fromISO(today);
  switch (period) {
    case "this_week": return { from: d.startOf("week").toISODate()!, to: today };
    case "last_week": {
      const s = d.startOf("week").minus({ weeks: 1 });
      return { from: s.toISODate()!, to: s.endOf("week").toISODate()! };
    }
    case "this_month": return { from: d.startOf("month").toISODate()!, to: today };
    case "last_month": {
      const s = d.startOf("month").minus({ months: 1 });
      return { from: s.toISODate()!, to: s.endOf("month").toISODate()! };
    }
    case "tax_year": return { from: taxYearFor(today).start, to: today };
    case "last_tax_year": {
      const prev = taxYearFor(DateTime.fromISO(taxYearFor(today).start).minus({ days: 1 }).toISODate()!);
      return { from: prev.start, to: prev.end };
    }
  }
}

function poundsToPence(x: unknown): number {
  if (typeof x !== "number" || !Number.isFinite(x) || x <= 0) throw new Error("amount must be a positive number of pounds");
  return Math.round(x * 100);
}

function present(e: LedgerEntry) {
  return {
    id: e.id,
    direction: e.direction,
    amount: formatPence(e.amountPence),
    date: e.occurredOn,
    counterparty: e.counterparty,
    description: e.description,
    category: e.category ? categoryLabel(e.category) : null,
    business_use: e.businessUse,
    status: e.status,
    source: e.source,
  };
}

const today = () => DateTime.now().toISODate()!;

export async function runBusinessTool(ownerId: number, name: string, input: Record<string, unknown>): Promise<unknown> {
  if (getUserEdition(ownerId) !== "business") return { error: `${name} is only available on the business edition.` };
  try {
    switch (name) {
      case "set_business_profile":
        setBusinessDescription(ownerId, String(input.description ?? ""));
        return { ok: true };
      case "log_expense": {
        const res = await recordExpense(
          ownerId,
          {
            amountPence: poundsToPence(input.amount),
            occurredOn: String(input.date),
            counterparty: String(input.paid_to),
            description: (input.description as string | undefined) ?? null,
            source: "chat",
            category: isCategoryKey(input.category) ? input.category : undefined,
            businessUse: input.business_use as BusinessUse | undefined,
          },
          async () => null // chat entries never call the model: unsure means ask the user
        );
        return { ok: true, entry: present(res.entry) };
      }
      case "log_income": {
        const res = recordIncome(ownerId, {
          amountPence: poundsToPence(input.amount),
          occurredOn: String(input.date),
          counterparty: String(input.from),
          description: (input.description as string | undefined) ?? null,
          source: "chat",
        });
        return { ok: true, entry: present(res.entry) };
      }
      case "list_ledger": {
        const range = input.period ? periodRange(input.period as Period, today()) : {};
        return listLedgerEntries(ownerId, {
          ...range,
          direction: input.direction as "in" | "out" | undefined,
          status: input.status as "confirmed" | "needs_review" | undefined,
          category: input.category as string | undefined,
          limit: (input.limit as number | undefined) ?? 30,
        }).map(present);
      }
      case "confirm_ledger_entry": {
        const e = confirmEntry(ownerId, Number(input.entry_id), {
          businessUse: input.business_use as BusinessUse | undefined,
          category: isCategoryKey(input.category) ? input.category : undefined,
        });
        return e ? { ok: true, entry: present(e) } : { error: `No entry ${input.entry_id}.` };
      }
      case "update_ledger_entry": {
        const e = updateLedgerEntry(
          ownerId,
          Number(input.entry_id),
          {
            amountPence: input.amount === undefined ? undefined : poundsToPence(input.amount),
            occurredOn: input.date as string | undefined,
            counterparty: input.counterparty as string | undefined,
            description: input.description as string | undefined,
          },
          "user"
        );
        return e ? { ok: true, entry: present(e) } : { error: `No entry ${input.entry_id}.` };
      }
      case "remove_ledger_entry": {
        const e = softDeleteLedgerEntry(ownerId, Number(input.entry_id), "user");
        return e ? { ok: true, removed: present(e) } : { error: `No entry ${input.entry_id}.` };
      }
      case "get_money_summary": {
        const { from, to } = periodRange(input.period as Period, (input.today as string | undefined) ?? today());
        const s = summariseLedger(ownerId, from, to);
        return {
          from,
          to,
          income: formatPence(s.incomePence),
          expenses: formatPence(s.expensesPence),
          profit: formatPence(s.incomePence - s.expensesPence),
          by_category: Object.fromEntries(Object.entries(s.byCategory).map(([k, v]) => [categoryLabel(k), formatPence(v)])),
          needs_review: s.needsReviewCount,
        };
      }
      default:
        return { error: `unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: (err as Error).message };
  }
}
```

(`formatPence(-x)` for a loss renders "£-12.00"; acceptable for MVP — the model rephrases.)

- [ ] **Step 4: Create `prompt.ts`**

```ts
import { formatPence, categoryLabel } from "./categories.js";
import { listLedgerEntries } from "./ledgerStore.js";
import { getBusinessDescription } from "./profile.js";

export function businessPromptSection(ownerId: number): string {
  const description = getBusinessDescription(ownerId);
  const review = listLedgerEntries(ownerId, { status: "needs_review", limit: 5 });
  const anyEntries = review.length > 0 || listLedgerEntries(ownerId, { limit: 1 }).length > 0;
  return [
    "BUSINESS EDITION: this user is a UK sole trader and you are their admin assistant for the business — receipts, bills, payments, email and diary.",
    description
      ? `Their business: ${description}.`
      : "You don't know what their business does yet. Early in the conversation, ask in one short line, then call set_business_profile.",
    "Receipts and bills they send are added to their books automatically. Money they mention in chat goes in with log_expense / log_income. Talk in plain English, no accountancy jargon unless they use it.",
    "Anything about tax is an estimate, never advice. For judgement calls (use of home, mixed business/personal use, capital items) suggest they check with an accountant. Client entertainment isn't an allowable expense — log it as personal.",
    anyEntries ? "" : "Their books are empty: invite them to send a photo of any receipt to see how it works.",
    review.length
      ? `Waiting for the user's check (ask about the newest one or two when there's a natural moment, using ask_user_choice buttons, then confirm_ledger_entry):\n${review
          .map((e) => `- #${e.id} ${e.direction === "in" ? "from" : "to"} ${e.counterparty ?? "unknown"} ${formatPence(e.amountPence)} on ${e.occurredOn}, guessed ${categoryLabel(e.category)} / ${e.businessUse}`)
          .join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}
```

- [ ] **Step 5: Update `editions/index.ts`** — import `BUSINESS_TOOLS, BUSINESS_TOOL_NAMES, runBusinessTool` from `../business/tools.js` and `businessPromptSection` from `../business/prompt.js`; set `BUSINESS.extraTools = BUSINESS_TOOLS`, `BUSINESS.promptSection = businessPromptSection`, and replace `runEditionTool`:

```ts
// Dispatch by tool NAME, not by the caller's edition: a business tool reaching runTool for a
// general user must still hit runBusinessTool's own edition check and be refused.
export async function runEditionTool(ownerId: number, name: string, input: Record<string, unknown>): Promise<unknown | undefined> {
  if (BUSINESS_TOOL_NAMES.has(name)) return runBusinessTool(ownerId, name, input);
  return undefined;
}
```

- [ ] **Step 6: Run** `npx vitest run src/business src/editions src/ai` — Expected: PASS.

- [ ] **Step 7: Commit** `git add -A server/src && git commit -m "feat(business): ledger tools and business prompt section"`

---

### Task 6: Receipts and emailed bills into the ledger

**Files:**
- Create: `server/src/business/receipts.ts`
- Modify: `server/src/editions/index.ts` (add `onReceiptSaved`), `server/src/services/documents.ts` (both `storeDerivedEntities(...)` call sites, ~line 785 and ~952), `server/src/services/attention.ts` (~line 125), `server/src/ai/assistant.ts` (`pendingInvoiceStatus` text ~2141)
- Test: `server/src/business/receipts.test.ts`

**Interfaces:**
- Produces: `receiptToLedger(ownerId, doc: { id: number; source?: string | null }, expenses: { data: ExpenseData; status: string }[], guess?: Guesser): Promise<number>` (entries created); `onReceiptSaved(ownerId, doc, derived)` in editions (no-op unless `logsReceipts`).

- [ ] **Step 1: Write the failing test** — `server/src/business/receipts.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { findOrCreateUserByEmail, setUserEdition } from "../db/store.js";
import { receiptToLedger } from "./receipts.js";
import { onReceiptSaved } from "../editions/index.js";
import { listLedgerEntries } from "./ledgerStore.js";

let n = 0;
const user = (edition: "general" | "business") => {
  const u = findOrCreateUserByEmail(`rcpt-${Date.now()}-${++n}@example.com`);
  setUserEdition(u.id, edition);
  return u.id;
};
const expense = (over = {}) => ({
  type: "expense" as const,
  status: "active",
  data: { vendor: "Screwfix", amountPence: 4820, currency: "GBP", date: "2026-10-10", ...over },
});
const noGuess = async () => null;

describe("receiptToLedger", () => {
  it("adds one needs-review entry per GBP expense, linked to the document", async () => {
    const id = user("business");
    expect(await receiptToLedger(id, { id: 501, source: "whatsapp" }, [expense(), expense({ vendor: "Wickes", amountPence: 999 })], noGuess)).toBe(2);
    const rows = listLedgerEntries(id);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.documentId === 501 && r.source === "whatsapp_doc" && r.status === "needs_review")).toBe(true);
  });

  it("is idempotent for the same document", async () => {
    const id = user("business");
    await receiptToLedger(id, { id: 502, source: "whatsapp" }, [expense()], noGuess);
    expect(await receiptToLedger(id, { id: 502, source: "whatsapp" }, [expense()], noGuess)).toBe(0);
    expect(listLedgerEntries(id)).toHaveLength(1);
  });

  it("skips non-GBP expenses rather than storing them as pence", async () => {
    const id = user("business");
    expect(await receiptToLedger(id, { id: 503, source: "whatsapp" }, [expense({ currency: "EUR", amountPence: 1200 })], noGuess)).toBe(0);
    expect(listLedgerEntries(id)).toHaveLength(0);
  });

  it("marks email-sourced documents as email", async () => {
    const id = user("business");
    await receiptToLedger(id, { id: 504, source: "email" }, [expense()], noGuess);
    expect(listLedgerEntries(id)[0].source).toBe("email");
  });
});

describe("onReceiptSaved", () => {
  it("does nothing for general users", async () => {
    const id = user("general");
    await onReceiptSaved(id, { id: 505, source: "whatsapp" }, [expense()]);
    expect(listLedgerEntries(id)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/business/receipts.test.ts` — Expected: FAIL.

- [ ] **Step 3: Create `receipts.ts`**

```ts
// Receipt/bill → ledger, for business users (spec §3a/3b). Called after documents.ts has saved the
// document and its derived expense entities; every derived expense (whatever folder the document
// was filed in — a work hotel is an expense too) becomes one ledger entry awaiting review unless
// the supplier's category is already remembered.
import type { ExpenseData } from "../services/entityValidation.js";
import { recordExpense, type Guesser } from "./ledger.js";
import { guessCategory } from "./categorise.js";

export async function receiptToLedger(
  ownerId: number,
  doc: { id: number; source?: string | null },
  derived: { type: string; data: unknown; status: string }[],
  guess: Guesser = guessCategory
): Promise<number> {
  let created = 0;
  const expenses = derived.filter((d) => d.type === "expense");
  for (let i = 0; i < expenses.length; i++) {
    const data = expenses[i].data as ExpenseData;
    if (data.currency !== "GBP") {
      console.warn(`business/receipts: skipping ${data.currency} expense on document ${doc.id} (GBP only)`);
      continue;
    }
    try {
      const res = await recordExpense(
        ownerId,
        {
          amountPence: data.amountPence,
          occurredOn: data.date,
          counterparty: data.vendor,
          source: doc.source === "email" ? "email" : "whatsapp_doc",
          documentId: doc.id,
          sourceRef: `doc:${doc.id}:${i}`,
        },
        guess
      );
      if (res.created) created++;
    } catch (err) {
      console.error(`business/receipts: couldn't add expense ${i} of document ${doc.id} to the ledger`, err);
    }
  }
  return created;
}
```

Check before writing: `DocumentRow` has a `source` field (`saveDocument` is called with `source: saveMeta.source` / `"email"`). If the row exposes it under another name, pass that.

- [ ] **Step 4: Add the hook to `editions/index.ts`**

```ts
import { receiptToLedger } from "../business/receipts.js";

// Awaited by documents.ts so the assistant's "saved" reply can already see the review question.
// Never throws: a ledger problem must not cost the user their saved document.
export async function onReceiptSaved(
  ownerId: number,
  doc: { id: number; source?: string | null },
  derived: { type: string; data: unknown; status: string }[]
): Promise<void> {
  if (!getEdition(ownerId).logsReceipts) return;
  try {
    await receiptToLedger(ownerId, doc, derived);
  } catch (err) {
    console.error("editions: receipt hook failed", err);
  }
}
```

- [ ] **Step 5: Call it from `documents.ts`** — import `onReceiptSaved` from `../editions/index.js`; directly after each `storeDerivedEntities(...)` call add:

```ts
  await onReceiptSaved(ownerId, doc, derivedEntities);
```

(use `params.ownerId` in `ingestEmailBodyReceipt`).

- [ ] **Step 6: Business offer text in `attention.ts`** (~line 125). Import `getEdition` from `../editions/index.js`. Replace the offer block:

```ts
  const xeroEmail = getXeroForwardingEmail(ownerId);
  const logsReceipts = getEdition(ownerId).logsReceipts;
  const offer =
    item.category === "invoice_due" && item.details.xeroOffer && (xeroEmail || logsReceipts)
      ? item.details.xeroOffer
      : null;
  if (offer) {
    text += logsReceipts
      ? `\n\nReply "yes" and I'll add it to your books${xeroEmail ? " and forward it to Xero" : ""}.`
      : `\n\nReply "yes" and I'll forward it to Xero.`;
  }
```

- [ ] **Step 7: `assistant.ts` `pendingInvoiceStatus`** — reword so it is true for both cases:

```ts
    ? `Pending invoice confirmation: a WhatsApp alert about "${pendingInvoice.subject}" asked the user to reply "yes" to save it (to their books and/or Xero). If their latest message is answering that (yes/no/go ahead/skip), call respond_to_invoice_forward_prompt with confirm accordingly. If it's about something else, ignore this.`
```

and in the `respond_to_invoice_forward_prompt` tool description replace "'looks like an invoice — reply yes and I'll forward it to Xero' prompt" with "'looks like an invoice — reply yes and I'll save it' prompt". Run `grep -rn "forward it to Xero" server/src --include=*.test.ts` and update any test expectation that pinned the old strings to the new ones.

- [ ] **Step 8: Add an attention test** to `server/src/business/receipts.test.ts`:

```ts
import { vi } from "vitest";
// at top of file, BEFORE other imports of attention.ts consumers:
// (place this describe in its own file server/src/business/invoiceOffer.test.ts if mocking order is awkward)
```

Create `server/src/business/invoiceOffer.test.ts` modelled on the existing attention tests (`grep -ln "xeroOffer" server/src/services/*.test.ts` and copy its mocks/setup verbatim), with two cases: (a) business user, no Xero, `invoice_due` with `xeroOffer` → sent text contains `add it to your books` and not `Xero`; (b) general user, no Xero → text contains neither.

- [ ] **Step 9: Run** `npx vitest run` (full suite — documents/attention/assistant are widely tested) — Expected: all PASS.

- [ ] **Step 10: Commit** `git add -A server/src && git commit -m "feat(business): receipts and emailed bills land in the ledger"`

---

### Task 7: Income spotted in email

**Files:**
- Create: `server/src/business/incomeDetector.ts`
- Modify: `server/src/editions/index.ts` (add `onAutomatedMail`), `server/src/services/importantEmailAlerts.ts` (`checkForImportantEmails`, after the `isPostConnectChainInProgress` block, before the WhatsApp gates)
- Test: `server/src/business/incomeDetector.test.ts`

**Interfaces:**
- Produces: `detectIncome(m: { from: string; subject: string; snippet: string; receivedAt: string }): { amountPence: number; counterparty: string; occurredOn: string } | null`; `incomeFromMail(ownerId, messages: { accountId: number; id: string; from: string; subject: string; snippet: string; receivedAt: string }[]): number`; editions `onAutomatedMail(ownerId, messages): void`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { findOrCreateUserByEmail, setUserEdition } from "../db/store.js";
import { detectIncome, incomeFromMail } from "./incomeDetector.js";
import { onAutomatedMail } from "../editions/index.js";
import { listLedgerEntries } from "./ledgerStore.js";

const mail = (from: string, subject: string, snippet = "") => ({ from, subject, snippet, receivedAt: "2026-10-12T09:00:00Z" });

describe("detectIncome", () => {
  it.each([
    [mail("Stripe <notifications@stripe.com>", "Your £1,240.50 payout is on the way"), 124050, "Stripe"],
    [mail("SumUp <no-reply@sumup.com>", "Payout sent", "We've sent £86.00 to your bank account")],
    [mail("PayPal <service@paypal.co.uk>", "You've got money", "Dave Smith sent you £450.00 GBP"), 45000, "Dave Smith"],
    [mail("Xero <messaging@xero.com>", "Invoice INV-0042 has been paid", "Acme Ltd paid £300.00"), 30000],
    [mail("accounts@acme.co.uk", "Remittance advice", "Payment of £300.00 has been made to your account"), 30000],
  ])("spots %o", (m, pence?: number, who?: string) => {
    const r = detectIncome(m);
    expect(r).not.toBeNull();
    if (pence) expect(r!.amountPence).toBe(pence);
    if (who) expect(r!.counterparty).toBe(who);
    expect(r!.occurredOn).toBe("2026-10-12");
  });

  it.each([
    mail("PayPal <service@paypal.co.uk>", "Receipt for your payment to Screwfix", "You paid £48.20"),
    mail("Amazon <auto@amazon.co.uk>", "Your refund of £12.00 has been processed"),
    mail("Stripe <notifications@stripe.com>", "Your payout is on the way", "no amount here"),
    mail("bank@example.com", "You sent £50.00 to Dave"),
  ])("ignores %o", (m) => {
    expect(detectIncome(m)).toBeNull();
  });
});

describe("incomeFromMail / onAutomatedMail", () => {
  let n = 0;
  const user = (edition: "general" | "business") => {
    const u = findOrCreateUserByEmail(`inc-${Date.now()}-${++n}@example.com`);
    setUserEdition(u.id, edition);
    return u.id;
  };
  const msg = { accountId: 1, id: "m1", ...mail("Stripe <notifications@stripe.com>", "Your £100.00 payout is on the way") };

  it("logs detected income for review, once per message", () => {
    const id = user("business");
    expect(incomeFromMail(id, [msg])).toBe(1);
    expect(incomeFromMail(id, [msg])).toBe(0);
    const [row] = listLedgerEntries(id);
    expect(row).toMatchObject({ direction: "in", amountPence: 10000, status: "needs_review", source: "email", sourceRef: "email:1:m1" });
  });

  it("does nothing for general users", () => {
    const id = user("general");
    onAutomatedMail(id, [msg]);
    expect(listLedgerEntries(id)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/business/incomeDetector.test.ts` — Expected: FAIL.

- [ ] **Step 3: Create `incomeDetector.ts`**

```ts
// Payment-received mail → income awaiting review (spec §3c). Deliberately deterministic: these
// senders' formats are stable, a false positive only ever creates a needs_review row the user
// can dismiss, and it costs nothing per email. Never sends anything; the briefing and the
// assistant's prompt surface the review count.
import { recordIncome } from "./ledger.js";

const INCOME = [
  /\bpayout\b/i,
  /you(?:'ve| have) (?:got|received) (?:money|a payment)/i,
  /\bsent you\b/i,
  /payment received/i,
  /remittance advice/i,
  /\b(?:has been |was )?paid\b.*\binvoice\b|\binvoice\b.*\bhas been paid\b/i,
];
const NOT_INCOME = /\brefund|receipt for your payment|your payment to|\byou paid\b|\byou sent\b|\bpayment failed|\bdeclined/i;
const AMOUNT = /£\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)/;
const SENT_YOU = /([A-Z][\w'&.-]*(?: [A-Z][\w'&.-]*){0,3}) (?:sent you|paid)\b/;

function senderName(from: string): string {
  const named = /^\s*"?([^"<]+?)"?\s*</.exec(from);
  return (named?.[1] ?? from.split("@")[0]).trim();
}

export function detectIncome(m: { from: string; subject: string; snippet: string; receivedAt: string }) {
  const text = `${m.subject}\n${m.snippet}`;
  if (NOT_INCOME.test(text) || !INCOME.some((r) => r.test(text))) return null;
  const amount = AMOUNT.exec(m.subject) ?? AMOUNT.exec(m.snippet);
  if (!amount) return null;
  const amountPence = Math.round(Number(amount[1].replace(/,/g, "")) * 100);
  if (!Number.isFinite(amountPence) || amountPence <= 0) return null;
  const payer = SENT_YOU.exec(m.snippet)?.[1];
  return {
    amountPence,
    counterparty: payer ?? senderName(m.from),
    occurredOn: new Date(m.receivedAt).toISOString().slice(0, 10),
  };
}

export function incomeFromMail(
  ownerId: number,
  messages: { accountId: number; id: string; from: string; subject: string; snippet: string; receivedAt: string }[]
): number {
  let created = 0;
  for (const m of messages) {
    const found = detectIncome(m);
    if (!found) continue;
    try {
      const res = recordIncome(ownerId, { ...found, description: m.subject, source: "email", sourceRef: `email:${m.accountId}:${m.id}` });
      if (res.created) created++;
    } catch (err) {
      console.error(`business/incomeDetector: couldn't record income from message ${m.id}`, err);
    }
  }
  return created;
}
```

When running Step 4 of this task, adjust `SENT_YOU` / patterns only as far as needed to make the listed test cases pass — the tests are the contract.

- [ ] **Step 4: Editions hook** in `editions/index.ts`:

```ts
import { incomeFromMail } from "../business/incomeDetector.js";

export function onAutomatedMail(
  ownerId: number,
  messages: { accountId: number; id: string; from: string; subject: string; snippet: string; receivedAt: string }[]
): void {
  if (!getEdition(ownerId).logsReceipts) return;
  try {
    incomeFromMail(ownerId, messages);
  } catch (err) {
    console.error("editions: mail hook failed", err);
  }
}
```

- [ ] **Step 5: Call it from `importantEmailAlerts.ts`** — import `onAutomatedMail`; right after the `if (isPostConnectChainInProgress(ownerId)) { ... return; }` block insert:

```ts
  // Business edition: payment-received mail becomes income awaiting review. Before the WhatsApp
  // gates on purpose — it sends nothing, so it needn't wait for a deliverable number.
  onAutomatedMail(ownerId, unscanned);
```

(`UnifiedMessage` has `accountId`, `id`, `from`, `subject`, `snippet`, `receivedAt`; if `from` is optional on the type, pass `unscanned.filter((m) => m.from)` with a cast — `isImportantEmailCandidate` already requires it.)

- [ ] **Step 6: Run** `npx vitest run src/business src/services/importantEmailAlerts.test.ts` — Expected: PASS.

- [ ] **Step 7: Commit** `git add -A server/src && git commit -m "feat(business): payment emails become income awaiting review"`

---

### Task 8: Briefing money lines, edition CLI, docs

**Files:**
- Create: `server/src/business/briefing.ts`, `server/src/scripts/setEdition.ts`, `changelog/2026-10-16-business-edition.md`, `feature-to-do/business-edition-phase-c.md`
- Modify: `server/src/editions/index.ts` (`editionBriefingFacts`), `server/src/services/briefing.ts` (`BriefingDay.extraFacts`, `briefingFactBlock`, `buildBriefingText`), `server/src/scripts/invite.ts`, `server/package.json`, `README.md`, `feature-to-do/README.md`
- Test: `server/src/business/briefing.test.ts`

**Interfaces:**
- Produces: `businessBriefingFacts(ownerId, today: string): string[]`; `editionBriefingFacts(ownerId, today): string[]`; `BriefingDay.extraFacts?: string[]`.

- [ ] **Step 1: Write the failing test** — `server/src/business/briefing.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { findOrCreateUserByEmail, setUserEdition } from "../db/store.js";
import { businessBriefingFacts } from "./briefing.js";
import { editionBriefingFacts } from "../editions/index.js";
import { insertLedgerEntry } from "./ledgerStore.js";
import { briefingFactBlock, type BriefingDay } from "../services/briefing.js";

let n = 0;
const user = (edition: "general" | "business") => {
  const u = findOrCreateUserByEmail(`brief-${Date.now()}-${++n}@example.com`);
  setUserEdition(u.id, edition);
  return u.id;
};

describe("businessBriefingFacts", () => {
  it("on Mondays summarises last week; any day mentions items to check", () => {
    const id = user("business");
    insertLedgerEntry(id, { direction: "in", amountPence: 124000, occurredOn: "2026-10-07", counterparty: "Dave", businessUse: "business", status: "confirmed", source: "chat" });
    insertLedgerEntry(id, { direction: "out", amountPence: 4820, occurredOn: "2026-10-08", counterparty: "Screwfix", businessUse: "unsure", status: "needs_review", source: "chat" });
    const monday = businessBriefingFacts(id, "2026-10-12");
    expect(monday.join("\n")).toContain("£1,240.00 in");
    expect(monday.join("\n")).toContain("1 entry needs a quick check");
    const tuesday = businessBriefingFacts(id, "2026-10-13");
    expect(tuesday.join("\n")).not.toContain("£1,240.00");
    expect(tuesday.join("\n")).toContain("1 entry needs a quick check");
  });

  it("is empty for a quiet business user and for general users", () => {
    expect(businessBriefingFacts(user("business"), "2026-10-13")).toEqual([]);
    expect(editionBriefingFacts(user("general"), "2026-10-12")).toEqual([]);
  });
});

describe("briefingFactBlock", () => {
  it("includes extra facts when present", () => {
    const day = {
      localTime: "07:30", localWeekday: "Monday", location: "", weather: null, quotes: [],
      unread: { count: 0, shown: [] }, todayEvents: [], upcomingEvents: [], flagged: [], news: [],
      extraFacts: ["Business money last week: £10.00 in, £0.00 out."],
    } as BriefingDay;
    expect(briefingFactBlock(day)).toContain("Business money last week");
  });
});
```

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Create `business/briefing.ts`**

```ts
import { DateTime } from "luxon";
import { formatPence } from "./categories.js";
import { summariseLedger } from "./ledgerStore.js";

// Fact lines for the morning briefing (spec §4): last week's money on Mondays, and a nudge when
// anything is waiting for the user's check. The briefing model words them.
export function businessBriefingFacts(ownerId: number, today: string): string[] {
  const d = DateTime.fromISO(today);
  const facts: string[] = [];
  if (d.weekday === 1) {
    const from = d.minus({ weeks: 1 }).toISODate()!;
    const to = d.minus({ days: 1 }).toISODate()!;
    const s = summariseLedger(ownerId, from, to);
    if (s.incomePence || s.expensesPence) {
      facts.push(`Business money last week (${from} to ${to}): ${formatPence(s.incomePence)} in, ${formatPence(s.expensesPence)} out.`);
    }
  }
  const { needsReviewCount } = summariseLedger(ownerId, today, today);
  if (needsReviewCount > 0) {
    facts.push(`${needsReviewCount} ${needsReviewCount === 1 ? "entry needs" : "entries need"} a quick check in their books — offer to go through them.`);
  }
  return facts;
}
```

- [ ] **Step 4: Editions + briefing wiring**

`editions/index.ts`:

```ts
import { businessBriefingFacts } from "../business/briefing.js";

export function editionBriefingFacts(ownerId: number, today: string): string[] {
  if (getEdition(ownerId).id !== "business") return [];
  try {
    return businessBriefingFacts(ownerId, today);
  } catch (err) {
    console.error("editions: briefing facts failed", err);
    return [];
  }
}
```

`services/briefing.ts`: add to `BriefingDay`:

```ts
  /** Edition-specific fact lines (editions/index.ts), e.g. the business edition's money summary. */
  extraFacts?: string[];
```

In `briefingFactBlock`, after `...attentionFactLines(day.attention),` add `...(day.extraFacts ?? []),`. In `buildBriefingText`, import `editionBriefingFacts` and add to the `renderBriefing` day object: `extraFacts: editionBriefingFacts(ownerId, clock.dateKey),`. In `isQuietDay`, return `false` when `day.extraFacts?.length` (a review nudge is news).

- [ ] **Step 5: Edition CLI**

`scripts/invite.ts`:

```ts
// ... npm run invite -- 447911123456 [--edition business]
import "dotenv/config";
import { addInvitedPhone, normalizePhone, isEditionId } from "../db/store.js";

const phone = process.argv[2];
const flag = process.argv.indexOf("--edition");
const edition = flag > -1 ? process.argv[flag + 1] : undefined;
if (!phone || (edition !== undefined && !isEditionId(edition))) {
  console.error("Usage: npm run invite -- 447911123456 [--edition general|business]");
  process.exit(1);
}

addInvitedPhone(phone, edition);
console.log(`Invited: ${normalizePhone(phone)}${edition ? ` (${edition} edition)` : ""}`);
```

`scripts/setEdition.ts`:

```ts
// Moves an existing user between editions: npm run set-edition -- 447911123456 business
import "dotenv/config";
import { resolveOwnerByPhone, setUserEdition, isEditionId, normalizePhone } from "../db/store.js";

const [phone, edition] = process.argv.slice(2);
if (!phone || !isEditionId(edition)) {
  console.error("Usage: npm run set-edition -- 447911123456 general|business");
  process.exit(1);
}
const ownerId = resolveOwnerByPhone(normalizePhone(phone));
if (ownerId === null) {
  console.error(`No account is bound to ${normalizePhone(phone)}.`);
  process.exit(1);
}
setUserEdition(ownerId, edition);
console.log(`User ${ownerId} is now on the ${edition} edition.`);
```

`server/package.json` scripts: `"set-edition": "tsx src/scripts/setEdition.ts",`.

- [ ] **Step 6: Run full suite + typecheck** `npx vitest run && npx tsc -p tsconfig.json --noEmit` — Expected: all PASS, no type errors.

- [ ] **Step 7: Docs** (per repo `CLAUDE.md`)
  - `README.md` "What Marlowe does": add a **Business edition (UK sole traders)** bullet — what it does, `npm run invite -- <phone> --edition business`, `npm run set-edition`.
  - `changelog/2026-10-16-business-edition.md`: one-line summary, then what changed and why (investor feedback, edition layer, ledger, capture flows, briefing; GBP only; no tax estimates yet).
  - `feature-to-do/business-edition-phase-c.md`: tax estimate, MTD reminders/quarterly export, bank-feed spike, admin-portal edition switch, business-specific onboarding chain, non-GBP receipts, brand name/landing page. Add it to `feature-to-do/README.md`.
  - Spec: change the dedupe line in §2 to the single `(owner_id, source, source_ref)` partial unique index actually built.

- [ ] **Step 8: Commit** `git add -A && git commit -m "feat(business): briefing money lines, edition CLI and docs"`
