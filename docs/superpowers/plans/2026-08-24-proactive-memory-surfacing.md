# Proactive Memory Surfacing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the assistant volunteer a remembered fact unprompted — mid-conversation when it's
relevant, or as a standalone WhatsApp message when a fact's moment arrives (a stated deadline, a
recurring commitment).

**Architecture:** In-conversation proactivity is a pure system-prompt wording change (the 40
recent memory notes are already injected every turn). Out-of-band proactivity adds two nullable
columns to `memory_notes` (`trigger_at`, `last_surfaced_at`) and one new optional field on the
existing `remember` tool, plus a new scheduled check cloned from the existing `alerts.ts`/
`scheduler.ts` pattern.

**Tech Stack:** TypeScript, better-sqlite3, Vitest, existing Anthropic SDK tool-calling
infrastructure already used by `assistant.ts`.

**Spec:** `docs/superpowers/specs/2026-08-24-proactive-memory-surfacing-design.md`

## Global Constraints

- No recurrence-rule engine — a triggered reminder is marked done and never re-arms itself.
- No Setup-page toggle to disable out-of-band reminders in v1 (deliberate divergence from
  `alerts.ts`'s opt-in-by-default precedent — see the spec).
- A reminder's `last_surfaced_at` is stamped **only on confirmed send success** — never
  unconditionally — so a WhatsApp failure retries on the next tick instead of silently losing a
  time-sensitive reminder.
- Every new DB read/write is scoped by `owner_id` (existing multi-tenant convention).

---

## Task 1: Schema and store functions for memory triggers

**Files:**
- Modify: `server/src/db/store.ts`
- Test: `server/src/db/memoryNotesStore.test.ts` (new)

**Interfaces:**
- Produces: `interface MemoryNoteRow { id: number; content: string; createdAt: number; triggerAt: number | null; lastSurfacedAt: number | null }`
- Produces: `addMemoryNote(ownerId: number, content: string, triggerAt?: string | null): MemoryNoteRow` (signature change — third param is new and optional, so every existing call site keeps compiling unchanged)
- Produces: `listDueMemoryReminders(ownerId: number, nowMs: number): MemoryNoteRow[]`
- Produces: `markMemorySurfaced(ownerId: number, id: number): void`

- [ ] **Step 1: Write the failing test**

Create `server/src/db/memoryNotesStore.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { findOrCreateUserByEmail, addMemoryNote, listDueMemoryReminders, markMemorySurfaced } from "./store.js";

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

describe("addMemoryNote — triggerAt handling", () => {
  it("stores no trigger when triggerAt is omitted", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("no-trigger"));
    const note = addMemoryNote(user.id, "The Acme account is my priority business");
    expect(note.triggerAt).toBeNull();
    expect(note.lastSurfacedAt).toBeNull();
  });

  it("parses a valid ISO date into an epoch timestamp", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("valid-trigger"));
    const note = addMemoryNote(user.id, "Visa expires soon", "2026-09-12T00:00:00Z");
    expect(note.triggerAt).toBe(new Date("2026-09-12T00:00:00Z").getTime());
  });

  it("falls back to no trigger for an unparseable date instead of throwing", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("bad-trigger"));
    const note = addMemoryNote(user.id, "Some fact", "not a real date");
    expect(note.triggerAt).toBeNull();
  });
});

describe("listDueMemoryReminders", () => {
  it("returns a note whose trigger time has passed and hasn't been surfaced yet", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("due-basic"));
    const past = new Date(Date.now() - 60_000).toISOString();
    addMemoryNote(user.id, "Overdue reminder", past);

    const due = listDueMemoryReminders(user.id, Date.now());
    expect(due).toHaveLength(1);
    expect(due[0].content).toBe("Overdue reminder");
  });

  it("excludes notes whose trigger time is in the future", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("due-future"));
    const future = new Date(Date.now() + 60_000).toISOString();
    addMemoryNote(user.id, "Not yet due", future);

    const due = listDueMemoryReminders(user.id, Date.now());
    expect(due).toHaveLength(0);
  });

  it("excludes notes that have already been surfaced", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("due-surfaced"));
    const past = new Date(Date.now() - 60_000).toISOString();
    const note = addMemoryNote(user.id, "Already handled", past);
    markMemorySurfaced(user.id, note.id);

    const due = listDueMemoryReminders(user.id, Date.now());
    expect(due).toHaveLength(0);
  });

  it("excludes ordinary notes with no trigger at all", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("due-notrigger"));
    addMemoryNote(user.id, "Just a fact, no deadline");

    const due = listDueMemoryReminders(user.id, Date.now());
    expect(due).toHaveLength(0);
  });

  it("scopes results by owner", () => {
    const userA = findOrCreateUserByEmail(uniqueEmail("due-owner-a"));
    const userB = findOrCreateUserByEmail(uniqueEmail("due-owner-b"));
    const past = new Date(Date.now() - 60_000).toISOString();
    addMemoryNote(userA.id, "A's reminder", past);

    expect(listDueMemoryReminders(userB.id, Date.now())).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/db/memoryNotesStore.test.ts`
Expected: FAIL — `listDueMemoryReminders`/`markMemorySurfaced` aren't exported yet, and
`addMemoryNote` doesn't accept a third argument.

- [ ] **Step 3: Add the migration**

In `server/src/db/store.ts`, immediately after the existing `documents` column migration block
(right after the `if (!documentColumns.includes("category")) { ... }` block, before
`export const uploadsDir = ...`):

```ts
// Powers proactive memory surfacing: an optional point in time a memory becomes worth mentioning
// unprompted (a stated deadline, a recurring commitment), and when it was last pushed so it never
// repeats. Both nullable — an ordinary fact/preference leaves both null, unchanged from before.
const memoryNoteColumns = (
  db.prepare(`PRAGMA table_info(memory_notes)`).all() as { name: string }[]
).map((c) => c.name);
if (!memoryNoteColumns.includes("trigger_at")) {
  db.exec(`ALTER TABLE memory_notes ADD COLUMN trigger_at INTEGER`);
}
if (!memoryNoteColumns.includes("last_surfaced_at")) {
  db.exec(`ALTER TABLE memory_notes ADD COLUMN last_surfaced_at INTEGER`);
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_notes_trigger ON memory_notes (owner_id, trigger_at)`);
```

- [ ] **Step 4: Update `MemoryNoteRow` and the existing read/write functions**

In `server/src/db/store.ts`, replace the existing `MemoryNoteRow` interface and the three
functions below it:

```ts
export interface MemoryNoteRow {
  id: number;
  content: string;
  createdAt: number;
  triggerAt: number | null;
  lastSurfacedAt: number | null;
}

const MEMORY_NOTE_COLUMNS = `id, content, created_at AS createdAt, trigger_at AS triggerAt, last_surfaced_at AS lastSurfacedAt`;

export function listMemoryNotes(ownerId: number): MemoryNoteRow[] {
  return db
    .prepare(`SELECT ${MEMORY_NOTE_COLUMNS} FROM memory_notes WHERE owner_id = ? ORDER BY id DESC`)
    .all(ownerId) as MemoryNoteRow[];
}

// Used when building the assistant's system prompt (unlike listMemoryNotes, which the Setup
// page uses to show the full vault) — caps how many notes get resent as tokens on every single
// call so the prompt doesn't grow forever as the vault accumulates facts over months of use.
export function listRecentMemoryNotes(ownerId: number, limit = 40): MemoryNoteRow[] {
  return db
    .prepare(`SELECT ${MEMORY_NOTE_COLUMNS} FROM memory_notes WHERE owner_id = ? ORDER BY id DESC LIMIT ?`)
    .all(ownerId, limit) as MemoryNoteRow[];
}

// triggerAt comes from the model as an ISO 8601 string (see the remember tool in assistant.ts) —
// parsed here rather than trusted as-is, since a malformed or hallucinated date string should
// never crash a save or silently store garbage. Invalid/unparseable dates are treated exactly
// like "no trigger" (same fault-tolerant spirit as record_travel_movement elsewhere), not an
// error — the note itself still saves.
export function addMemoryNote(ownerId: number, content: string, triggerAt?: string | null): MemoryNoteRow {
  const parsedMs = triggerAt ? new Date(triggerAt).getTime() : NaN;
  const triggerAtMs = Number.isFinite(parsedMs) ? parsedMs : null;

  const info = db
    .prepare(`INSERT INTO memory_notes (owner_id, content, created_at, trigger_at) VALUES (?, ?, ?, ?)`)
    .run(ownerId, content, Date.now(), triggerAtMs);
  return db
    .prepare(`SELECT ${MEMORY_NOTE_COLUMNS} FROM memory_notes WHERE id = ?`)
    .get(info.lastInsertRowid) as MemoryNoteRow;
}
```

- [ ] **Step 5: Add the due-lookup and mark-surfaced functions**

In `server/src/db/store.ts`, immediately after the existing `removeMemoryNote` function:

```ts
export function removeMemoryNote(ownerId: number, id: number): void {
  db.prepare(`DELETE FROM memory_notes WHERE id = ? AND owner_id = ?`).run(id, ownerId);
}

// Indexed lookup (idx_memory_notes_trigger, see the migration above), not a scan — cost stays
// proportional to how many reminders are actually due, not how many memories exist in total.
export function listDueMemoryReminders(ownerId: number, nowMs: number): MemoryNoteRow[] {
  return db
    .prepare(
      `SELECT ${MEMORY_NOTE_COLUMNS} FROM memory_notes
       WHERE owner_id = ? AND trigger_at IS NOT NULL AND trigger_at <= ? AND last_surfaced_at IS NULL
       ORDER BY trigger_at ASC`
    )
    .all(ownerId, nowMs) as MemoryNoteRow[];
}

export function markMemorySurfaced(ownerId: number, id: number): void {
  db.prepare(`UPDATE memory_notes SET last_surfaced_at = ? WHERE id = ? AND owner_id = ?`).run(
    Date.now(),
    id,
    ownerId
  );
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd server && npx vitest run src/db/memoryNotesStore.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 7: Typecheck and run the full suite**

Run: `cd server && npx tsc --noEmit && npx vitest run`
Expected: clean typecheck, all existing tests still pass — `addMemoryNote`'s two existing call
sites (`assistant.ts`'s `remember` case, `memoryRoutes.ts`'s `POST /api/memory`) both call it with
only 2 arguments today, which stays valid since the third parameter is optional.

- [ ] **Step 8: Commit**

```bash
cd server
git add src/db/store.ts src/db/memoryNotesStore.test.ts
git commit -m "Add trigger_at/last_surfaced_at to memory_notes, due-reminder lookup functions"
```

---

## Task 2: `remember` tool gains `triggerAt`

**Files:**
- Modify: `server/src/ai/assistant.ts`
- Test: `server/src/ai/assistant.test.ts` (extend)

**Interfaces:**
- Consumes: `addMemoryNote(ownerId, content, triggerAt?)` (Task 1)

- [ ] **Step 1: Write the failing test**

In `server/src/ai/assistant.test.ts`, add to the existing `describe("runTool defense-in-depth", ...)`
block (it already imports `runTool`, `findOrCreateUserByEmail`; add `listMemoryNotes` to the
existing `../db/store.js` import):

```ts
import { findOrCreateUserByEmail, setToolEnabled, getEnabledTools, listMemoryNotes } from "../db/store.js";
```

```ts
describe("remember tool — triggerAt", () => {
  it("stores a parsed triggerAt when the model provides one", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("remember-trigger"));
    const result = await runTool(user.id, "remember", {
      note: "Visa renewal is due",
      triggerAt: "2026-09-12T00:00:00Z",
    });
    expect(result).toEqual({ ok: true });

    const [saved] = listMemoryNotes(user.id);
    expect(saved.content).toBe("Visa renewal is due");
    expect(saved.triggerAt).toBe(new Date("2026-09-12T00:00:00Z").getTime());
  });

  it("stores no trigger when the model omits triggerAt, same as before", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("remember-notrigger"));
    const result = await runTool(user.id, "remember", { note: "Ordinary preference" });
    expect(result).toEqual({ ok: true });

    const [saved] = listMemoryNotes(user.id);
    expect(saved.triggerAt).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/ai/assistant.test.ts`
Expected: FAIL — the `remember` tool schema doesn't accept `triggerAt`, and the dispatch case
doesn't pass it through, so `saved.triggerAt` is `null` in both cases (first test fails).

- [ ] **Step 3: Add `triggerAt` to the tool schema**

In `server/src/ai/assistant.ts`, update the existing `remember` tool definition:

```ts
  {
    name: "remember",
    description:
      "Save a fact or preference about the user for future conversations — e.g. which account belongs to which business, a standing instruction, or context they've shared. Call this whenever the user tells you something worth recalling later, without waiting to be asked. Keep it to one clear sentence.",
    input_schema: {
      type: "object",
      properties: {
        note: { type: "string", description: "One clear sentence to remember" },
        triggerAt: {
          type: "string",
          description:
            "Optional ISO 8601 date/datetime. Set this only if what the user shared has a natural " +
            "future trigger point — a deadline, a recurring commitment, a stated future plan. Leave " +
            "unset for ordinary facts or preferences with no time dimension.",
        },
      },
      required: ["note"],
    },
  },
```

- [ ] **Step 4: Pass `triggerAt` through in the dispatch case**

In `server/src/ai/assistant.ts`, update the `remember` case:

```ts
    case "remember":
      addMemoryNote(ownerId, input.note as string, input.triggerAt as string | undefined);
      return { ok: true };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && npx vitest run src/ai/assistant.test.ts`
Expected: PASS (all existing tests plus the 2 new ones)

- [ ] **Step 6: Typecheck and run the full suite**

Run: `cd server && npx tsc --noEmit && npx vitest run`
Expected: clean typecheck, all tests pass.

- [ ] **Step 7: Commit**

```bash
cd server
git add src/ai/assistant.ts src/ai/assistant.test.ts
git commit -m "Add optional triggerAt to the remember tool"
```

---

## Task 3: In-conversation proactive-surfacing prompt change

**Files:**
- Modify: `server/src/ai/assistant.ts`
- Test: `server/src/ai/assistant.test.ts` (extend)

This task is independent of Tasks 1–2 — it's a pure string change to how the already-existing
memory list is framed in the system prompt.

- [ ] **Step 1: Write the failing test**

In `server/src/ai/assistant.test.ts`, add to the existing `describe("buildSystemPrompt", ...)`
block:

```ts
  it("frames memory as something the assistant may proactively volunteer", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("prompt-proactive-memory"));
    const prompt = buildSystemPrompt(user.id);
    expect(prompt).toContain("may naturally bring up");
    expect(prompt).not.toContain("Things you've learned about the user over past conversations");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/ai/assistant.test.ts`
Expected: FAIL — the prompt still contains the old passive phrasing.

- [ ] **Step 3: Change the prompt wording**

In `server/src/ai/assistant.ts`, replace:

```ts
    `Things you've learned about the user over past conversations:\n${memoryList}`,
```

with:

```ts
    `Things you remember about the user. You may naturally bring up one of these when it's ` +
      `genuinely relevant to what's being discussed — the way someone who was actually paying ` +
      `attention would — without forcing it or repeating something you've already brought up ` +
      `this conversation:\n${memoryList}`,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/ai/assistant.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck and run the full suite**

Run: `cd server && npx tsc --noEmit && npx vitest run`
Expected: clean typecheck, all tests pass.

- [ ] **Step 6: Commit**

```bash
cd server
git add src/ai/assistant.ts src/ai/assistant.test.ts
git commit -m "Reframe injected memory list to permit proactive, unprompted mentions"
```

---

## Task 4: Out-of-band reminder check, wired into the scheduler

**Files:**
- Create: `server/src/services/memoryReminders.ts`
- Modify: `server/src/services/scheduler.ts`
- Test: `server/src/services/memoryReminders.test.ts` (new)

**Interfaces:**
- Consumes: `listDueMemoryReminders`, `markMemorySurfaced`, `listPhoneNumbersForUser`,
  `addMemoryNote` from `../db/store.js` (Task 1); `sendWhatsAppMessage`, `isWhatsAppConfigured`
  from `../providers/whatsapp.js`
- Produces: `checkDueMemoryReminders(ownerId: number): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `server/src/services/memoryReminders.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../providers/whatsapp.js", () => ({
  sendWhatsAppMessage: vi.fn(),
  isWhatsAppConfigured: vi.fn().mockReturnValue(true),
}));

const { sendWhatsAppMessage, isWhatsAppConfigured } = await import("../providers/whatsapp.js");
const { findOrCreateUserByEmail, addPhoneNumberForUser, addMemoryNote, listDueMemoryReminders } =
  await import("../db/store.js");
const { checkDueMemoryReminders } = await import("./memoryReminders.js");

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

// All test files share one SQLite database for the whole `vitest run` (see test/setup.ts), and
// user_phone_numbers.phone is UNIQUE — so phone numbers need a prefix no other test file uses,
// not just uniqueness within this file. Existing files already claim "44700000" and "44700001"
// (see pendingRegistration.test.ts / whatsappRegistration.test.ts) — this file uses "44700004".
function freshPhone(): string {
  counter += 1;
  return `44700004${String(counter).padStart(4, "0")}`;
}

beforeEach(() => {
  vi.mocked(sendWhatsAppMessage).mockReset();
  vi.mocked(isWhatsAppConfigured).mockReturnValue(true);
});

describe("checkDueMemoryReminders", () => {
  it("sends a WhatsApp message for a due reminder and marks it surfaced", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("reminder-due"));
    const phoneNumber = freshPhone();
    addPhoneNumberForUser(user.id, phoneNumber);
    const past = new Date(Date.now() - 60_000).toISOString();
    addMemoryNote(user.id, "Visa renewal is due", past);

    await checkDueMemoryReminders(user.id);

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    const [phone, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(phone).toBe(phoneNumber);
    expect(text).toContain("Visa renewal is due");
    expect(listDueMemoryReminders(user.id, Date.now())).toHaveLength(0);
  });

  it("does nothing when there are no due reminders", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("reminder-none"));
    addPhoneNumberForUser(user.id, freshPhone());

    await checkDueMemoryReminders(user.id);

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it("does not mark a reminder surfaced if the send fails, so it retries next tick", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("reminder-fail"));
    addPhoneNumberForUser(user.id, freshPhone());
    const past = new Date(Date.now() - 60_000).toISOString();
    addMemoryNote(user.id, "Important deadline", past);
    vi.mocked(sendWhatsAppMessage).mockRejectedValueOnce(new Error("network error"));

    await checkDueMemoryReminders(user.id);

    expect(listDueMemoryReminders(user.id, Date.now())).toHaveLength(1);
  });

  it("does nothing when WhatsApp isn't configured", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("reminder-unconfigured"));
    addPhoneNumberForUser(user.id, freshPhone());
    const past = new Date(Date.now() - 60_000).toISOString();
    addMemoryNote(user.id, "Some reminder", past);
    vi.mocked(isWhatsAppConfigured).mockReturnValue(false);

    await checkDueMemoryReminders(user.id);

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(listDueMemoryReminders(user.id, Date.now())).toHaveLength(1);
  });

  it("does nothing when the user has no registered WhatsApp number", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("reminder-nophone"));
    const past = new Date(Date.now() - 60_000).toISOString();
    addMemoryNote(user.id, "Some reminder", past);

    await checkDueMemoryReminders(user.id);

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/services/memoryReminders.test.ts`
Expected: FAIL — `memoryReminders.js` doesn't exist yet.

- [ ] **Step 3: Implement `checkDueMemoryReminders`**

Create `server/src/services/memoryReminders.ts`:

```ts
// Out-of-band proactive memory surfacing — a scheduled push when a memory's trigger_at arrives,
// the same shape as the existing real-time email alerts (alerts.ts). See
// docs/superpowers/specs/2026-08-24-proactive-memory-surfacing-design.md.

import { listDueMemoryReminders, markMemorySurfaced, listPhoneNumbersForUser } from "../db/store.js";
import { sendWhatsAppMessage, isWhatsAppConfigured } from "../providers/whatsapp.js";

const MAX_REMINDERS_PER_CHECK = 5;

export async function checkDueMemoryReminders(ownerId: number): Promise<void> {
  if (!isWhatsAppConfigured()) return;

  const due = listDueMemoryReminders(ownerId, Date.now());
  if (due.length === 0) return;

  const numbers = listPhoneNumbersForUser(ownerId).map((r) => r.phone);
  if (numbers.length === 0) return;

  // Capped per tick, not per reminder ever: anything past the cap is simply still "due" (ordered
  // oldest-first) on the next 5-minute tick, so a burst naturally drains over a few ticks instead
  // of firing a wall of messages — no separate overflow bookkeeping needed.
  const toSend = due.slice(0, MAX_REMINDERS_PER_CHECK);

  for (const note of toSend) {
    const text = `💭 Just remembered: ${note.content}`;
    let allSucceeded = true;
    for (const number of numbers) {
      try {
        await sendWhatsAppMessage(number, text);
      } catch (err) {
        console.error("memoryReminders: failed to send reminder", err);
        allSucceeded = false;
      }
    }
    // Only stamp last_surfaced_at once every number actually got it — a partial/total failure
    // means this reminder stays due and is retried in full on the next tick, rather than being
    // silently half-delivered or lost. Deliberately different from alerts.ts's notify(), which
    // marks unconditionally — see the design doc for why that's the wrong call for a one-time,
    // time-sensitive reminder.
    if (allSucceeded) {
      markMemorySurfaced(ownerId, note.id);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/services/memoryReminders.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Wire into `scheduler.ts`**

In `server/src/services/scheduler.ts`, add the import:

```ts
import { checkDueMemoryReminders } from "./memoryReminders.js";
```

Add a new wrapper function, right after the existing `runAlertsCheckForUser`:

```ts
async function runMemoryReminderCheckForUser(ownerId: number): Promise<void> {
  try {
    await checkDueMemoryReminders(ownerId);
  } catch (err) {
    console.error(`scheduler: memory reminder check failed for user ${ownerId}`, err);
  }
}
```

Add the call inside `tick()`, alongside the other checks:

```ts
async function tick(): Promise<void> {
  for (const ownerId of listAllUserIds()) {
    await runDailyCheckForUser(ownerId).catch((err) =>
      console.error(`scheduler: daily check failed for user ${ownerId}`, err)
    );
    await runAlertsCheckForUser(ownerId).catch((err) =>
      console.error(`scheduler: alerts check failed for user ${ownerId}`, err)
    );
    await runMemoryReminderCheckForUser(ownerId).catch((err) =>
      console.error(`scheduler: memory reminder check failed for user ${ownerId}`, err)
    );
  }
}
```

(If Task 4 of the document/email cross-referencing plan already added a
`runReconciliationCheckForUser` call here too, add this call alongside it rather than replacing
it — both belong in the same loop.)

- [ ] **Step 6: Typecheck and run the full suite**

Run: `cd server && npx tsc --noEmit && npx vitest run`
Expected: clean typecheck, all tests pass.

- [ ] **Step 7: Commit**

```bash
cd server
git add src/services/memoryReminders.ts src/services/memoryReminders.test.ts src/services/scheduler.ts
git commit -m "Add out-of-band memory reminder check, wire into scheduler tick"
```

---

## Task 5: Manual end-to-end verification

**Files:** none (verification only, no code changes)

Covers the one thing automated tests can't: a real conversation actually causing the model to set
`triggerAt`, and a real WhatsApp send. Requires a dev environment with `ANTHROPIC_API_KEY` and,
for the WhatsApp send half, `WHATSAPP_TOKEN`/`WHATSAPP_PHONE_NUMBER_ID`/`WHATSAPP_VERIFY_TOKEN`
configured.

- [ ] **Step 1: Confirm the model volunteers a memory unprompted**

Have a WhatsApp/web conversation where you mention something memorable (e.g. "the Hargrove
account is my biggest client"), then in a later, unrelated-seeming message ask something that
should plausibly remind the assistant of it (e.g. "what should I focus on today?"). Confirm it at
least sometimes brings the fact up unprompted rather than only when asked directly — this is a
live model judgment call, not a deterministic guarantee, so try a couple of realistic phrasings
rather than expecting it on the very first attempt.

- [ ] **Step 2: Confirm the model sets `triggerAt` for a natural deadline**

Message the assistant something with a clear future date ("My passport needs renewing by
15 October 2026"). Check the Setup page's memory list (`GET /api/memory`) or query
`memory_notes` directly — confirm a row was saved with `trigger_at` set to on or near that date.

- [ ] **Step 3: Confirm the out-of-band push fires when due**

Temporarily set a memory's `trigger_at` to a few minutes in the future (directly via SQL against
the dev database, or by asking the assistant to remember something with a near-future date), wait
for the trigger time to pass plus one scheduler tick (5 minutes, or temporarily lower
`CHECK_INTERVAL_MS` in `scheduler.ts` for this test run only, reverting after), and confirm a
"💭 Just remembered: ..." WhatsApp message arrives.

- [ ] **Step 4: Confirm no duplicate push on the next tick**

Wait for one more tick and confirm the same reminder doesn't fire again — `last_surfaced_at`
should already be set.

- [ ] **Step 5: Clean up test data**

Delete any test memory notes created during this verification (via the Setup page's memory list,
or `DELETE FROM memory_notes WHERE ...` directly) so they don't linger in the shared dev database.

---

## Self-Review Notes

- **Spec coverage:** schema (Task 1) ✓, `remember` tool's `triggerAt` field (Task 2) ✓,
  in-conversation prompt reframing (Task 3) ✓, out-of-band scheduled check with per-user daily-ish
  cap (Task 4's `MAX_REMINDERS_PER_CHECK`) ✓, mark-only-on-success error handling (Task 4) ✓, no
  recurrence engine (not built anywhere in this plan) ✓, no Setup-page toggle (not built) ✓.
- **Type consistency check:** `MemoryNoteRow` is updated once in Task 1 and used identically by
  every later task (`assistant.test.ts` in Task 2 reads `.triggerAt` off it; `memoryReminders.ts`
  in Task 4 reads `.content`/`.id` off it). `addMemoryNote`'s new third parameter is optional
  everywhere it's referenced, so Task 1's own change doesn't break the two pre-existing call sites
  it doesn't touch (`memoryRoutes.ts`, and `assistant.ts`'s `remember` case before Task 2 updates
  it).
- **No placeholders:** every step has real, complete code.
