# Attention Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every unprompted Marlowe message through one gate that decides interrupt / schedule / brief / drop, so the user gets few, concrete, well-timed messages instead of a notification feed.

**Architecture:** A new `attention_items` table holds one row per real-world event (deduped by `event_key`). Pure rules live in `attentionRules.ts` (tiering, event keys, timing, quiet hours, message text, concreteness check); I/O lives in `attention.ts` (submit, deliver-due, collect-for-briefing/digest). Existing scanners (`importantEmailAlerts.ts`, `reconciliation.ts`, `tripPrep.ts`, `alerts.ts` instant mode) stop sending directly and submit candidates; the briefing and evening digest absorb acknowledgements and non-urgent items.

**Tech Stack:** TypeScript (ESM), Node, better-sqlite3, luxon, vitest, `@anthropic-ai/sdk` (Haiku for classification/enrichment/triage).

**Spec:** `docs/superpowers/specs/2026-09-28-attention-gate-design.md`

## Global Constraints

- Daily cap: **4** capped messages per user per **user-local** day. Cap-exempt categories: `flight_change`, `security_alert`, `person_email` (instant-mode users). User-set reminders (`reminderScheduler.ts`) never go through the gate.
- Over-cap items are **never dropped**: status `held`, delivered in the next digest or briefing, whichever comes first.
- Quiet hours **22:00–07:00 user-local**. Only `flight_change` breaks through. Deferred items surface at 07:00, or at the proactive briefing time if the briefing is on and its send time is between 07:00 and 09:00.
- Every gate-sent message must pass `isConcrete`: at least one `*bold*` specific, and none of: `worth a look`, `check your inbox`, `important-looking`, `and <N> more`, `might need attention`, `just ask and I'll run through`.
- Timing defaults (user-local): flight 24h before departure if the time is known, else 09:00 the day before; hotel 09:00 check-in day; restaurant/other 3h before if the time is known, else 09:00 that day; renewal 09:00 three days before the charge; bill 09:00 two days before due.
- A briefing folds in scheduled reminders due within **2h** after it is sent.
- User timezone comes from `getUserTimezone(ownerId)` (`services/userTimezone.ts`); `null` means use the server's zone. Never throw on `null`.
- All tests share one SQLite DB (`src/test/setup.ts`); `user_phone_numbers.phone` is UNIQUE. New test files use the prefix **`44700011`** (unclaimed).
- Run tests from `server/`: `npx vitest run <path>`. Full suite: `npm test`. Type-check: `npm run build`.
- Commits end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01FDP9pdScdU9ciLSdZHps5P
  ```

## Review Focus

1. **User with no known timezone** (`getUserTimezone` → `null`): every rule must fall back to the server zone, not throw or produce `NaN` times. *Pinned in Task 2.*
2. **Unparseable or date-only event times from the model** (`"next Tuesday"`, `"2026-10-03"`): must degrade to date-only or `brief`, never crash or schedule at epoch 0. *Pinned in Task 2.*
3. **A booking or bill first seen after its date has passed**: must be dropped, never reminded. *Pinned in Task 2 and Task 3.*
4. **A due reminder whose WhatsApp send fails**: must stay `pending`, retry next tick, and not consume the daily cap. *Pinned in Task 3.*
5. **The same event submitted twice** (two ticks, or email + saved document + venue email): exactly one row and no second message. *Pinned in Task 3 and Task 7.*

---

## File Structure

| File | Responsibility |
|---|---|
| `server/src/db/store.ts` (modify) | `attention_items` table, row types, CRUD, `deleteUserCompletely` purge |
| `server/src/services/attentionRules.ts` (create) | Pure rules: tier, event key, timing, quiet hours, cap-day boundary, message builders, `isConcrete` |
| `server/src/services/attention.ts` (create) | I/O: `submitAttentionItem`, `deliverDueAttentionItems`, `collectAttentionForBriefing`, `collectAttentionForDigest`, `commitAttentionBundle` |
| `server/src/services/importantEmailClassifier.ts` (modify) | Add `needs_action` |
| `server/src/services/importantEmailEnrichment.ts` (create) | One Haiku call on the full body: dates, refs, amounts, summary |
| `server/src/services/importantEmailAlerts.ts` (modify) | Classify → enrich → submit; no direct sends |
| `server/src/services/reconciliation.ts` (modify) | Matches → submit as `document_match`; no direct sends |
| `server/src/services/tripPrep.ts` (modify) | `syncBookingReminders`: booking entities → scheduled items |
| `server/src/services/realPersonTriage.ts` (modify) | Also returns a gist + needs-reply per kept email |
| `server/src/services/alerts.ts` (modify) | Gist in digest queue; instant mode submits `person_email`; no overflow line; onboarding → digest |
| `server/src/services/emailDigest.ts` (modify) | Concrete people lines + attention sections |
| `server/src/services/briefing.ts` (modify) | Attention facts, no-filler prompt |
| `server/src/services/onboardingAlertSuppression.ts` (modify) | Remove count-and-flush summary |
| `server/src/services/scheduler.ts` (modify) | Wire sync/deliver/briefing bundle; drop onboarding flush |
| `server/src/ai/assistant.ts` (modify) | `set_email_alerts` description matches the new behaviour |

---

### Task 1: `attention_items` storage

**Files:**
- Modify: `server/src/db/store.ts` (new `db.exec` block after the `proactive_deliveries` block ~line 1102; new exported functions near `recordProactiveDelivery` ~line 2486; `deleteUserCompletely` ~line 3674)
- Test: `server/src/db/attentionItems.test.ts` (create)
- Test: `server/src/db/deleteUserCompletely.test.ts` (modify)

**Interfaces:**
- Produces (exported from `store.ts`):
  ```ts
  export type AttentionTier = "interrupt" | "scheduled" | "brief" | "drop";
  export type AttentionStatus = "pending" | "sent" | "held" | "folded" | "dropped";
  export type AttentionSource = "email" | "document" | "booking" | "reconciliation";
  export interface AttentionDetails {
    summary: string;                       // one concrete sentence, specifics in *bold*
    kind?: "flight" | "hotel" | "restaurant" | "other";
    eventStart?: string | null;            // "YYYY-MM-DD" or ISO date-time (with offset if known)
    dueDate?: string | null;               // "YYYY-MM-DD"
    reference?: string | null;
    flightNumber?: string | null;
    merchant?: string | null;
    amount?: string | null;
    needsAction?: boolean;
    accountId?: number;                    // source email, for the history reference note
    messageId?: string;
    emailSubject?: string;
    emailFrom?: string;
    bookingEntityId?: number;
    xeroOffer?: { accountId: number; messageId: string; subject: string };
  }
  export interface AttentionItemRow {
    id: number; ownerId: number; eventKey: string; source: AttentionSource; category: string;
    tier: AttentionTier; status: AttentionStatus; details: AttentionDetails;
    surfaceAt: number | null; acknowledgedAt: number | null; sentAt: number | null;
    createdAt: number; updatedAt: number;
  }
  export function getAttentionItem(ownerId: number, eventKey: string): AttentionItemRow | null;
  export function insertAttentionItem(ownerId: number, item: {
    eventKey: string; source: AttentionSource; category: string; tier: AttentionTier;
    status: AttentionStatus; details: AttentionDetails; surfaceAt: number | null; acknowledgedAt?: number | null;
  }): AttentionItemRow;
  export function updateAttentionItem(ownerId: number, id: number, patch: Partial<{
    tier: AttentionTier; status: AttentionStatus; details: AttentionDetails; surfaceAt: number | null;
    acknowledgedAt: number | null; sentAt: number | null;
  }>): AttentionItemRow;
  export function listAttentionItems(ownerId: number, filter?: { statuses?: AttentionStatus[]; dueBefore?: number }): AttentionItemRow[];
  export function countCappedAttentionSentSince(ownerId: number, sinceMs: number, exemptCategories: string[]): number;
  ```

- [ ] **Step 1: Write the failing test**

Create `server/src/db/attentionItems.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  findOrCreateUserByEmail,
  getAttentionItem,
  insertAttentionItem,
  updateAttentionItem,
  listAttentionItems,
  countCappedAttentionSentSince,
} from "./store.js";

let counter = 0;
function newOwner(): number {
  counter += 1;
  return findOrCreateUserByEmail(`attention-store-${Date.now()}-${counter}@example.com`).id;
}

const details = { summary: "Your *Hilton Lisbon* stay is confirmed for *12–15 Oct*." };

describe("attention_items store", () => {
  it("inserts and reads back an item by event key, with details round-tripped", () => {
    const ownerId = newOwner();
    const row = insertAttentionItem(ownerId, {
      eventKey: "ref:ABC123",
      source: "email",
      category: "reservation_confirmed",
      tier: "scheduled",
      status: "pending",
      details: { ...details, reference: "ABC123", kind: "hotel" },
      surfaceAt: 1_000,
    });
    const read = getAttentionItem(ownerId, "ref:ABC123");
    expect(read?.id).toBe(row.id);
    expect(read?.details.reference).toBe("ABC123");
    expect(read?.surfaceAt).toBe(1_000);
    expect(read?.acknowledgedAt).toBeNull();
  });

  it("scopes event keys per owner", () => {
    const a = newOwner();
    const b = newOwner();
    insertAttentionItem(a, { eventKey: "ref:SAME", source: "email", category: "x", tier: "brief", status: "pending", details, surfaceAt: null });
    expect(getAttentionItem(b, "ref:SAME")).toBeNull();
    expect(() =>
      insertAttentionItem(b, { eventKey: "ref:SAME", source: "email", category: "x", tier: "brief", status: "pending", details, surfaceAt: null })
    ).not.toThrow();
  });

  it("patches only the given fields and bumps updatedAt", () => {
    const ownerId = newOwner();
    const row = insertAttentionItem(ownerId, { eventKey: "k1", source: "email", category: "x", tier: "scheduled", status: "pending", details, surfaceAt: 5 });
    const updated = updateAttentionItem(ownerId, row.id, { status: "sent", sentAt: 42 });
    expect(updated.status).toBe("sent");
    expect(updated.sentAt).toBe(42);
    expect(updated.tier).toBe("scheduled");
    expect(updated.surfaceAt).toBe(5);
  });

  it("lists pending items due before a time, soonest first", () => {
    const ownerId = newOwner();
    insertAttentionItem(ownerId, { eventKey: "late", source: "email", category: "x", tier: "scheduled", status: "pending", details, surfaceAt: 300 });
    insertAttentionItem(ownerId, { eventKey: "early", source: "email", category: "x", tier: "scheduled", status: "pending", details, surfaceAt: 100 });
    insertAttentionItem(ownerId, { eventKey: "future", source: "email", category: "x", tier: "scheduled", status: "pending", details, surfaceAt: 900 });
    insertAttentionItem(ownerId, { eventKey: "done", source: "email", category: "x", tier: "scheduled", status: "sent", details, surfaceAt: 50 });
    const due = listAttentionItems(ownerId, { statuses: ["pending"], dueBefore: 500 });
    expect(due.map((r) => r.eventKey)).toEqual(["early", "late"]);
  });

  it("counts sent items since a time, excluding exempt categories", () => {
    const ownerId = newOwner();
    const a = insertAttentionItem(ownerId, { eventKey: "a", source: "email", category: "invoice_due", tier: "interrupt", status: "pending", details, surfaceAt: 1 });
    const b = insertAttentionItem(ownerId, { eventKey: "b", source: "email", category: "flight_change", tier: "interrupt", status: "pending", details, surfaceAt: 1 });
    const c = insertAttentionItem(ownerId, { eventKey: "c", source: "email", category: "reservation_confirmed", tier: "scheduled", status: "pending", details, surfaceAt: 1 });
    updateAttentionItem(ownerId, a.id, { status: "sent", sentAt: 1_000 });
    updateAttentionItem(ownerId, b.id, { status: "sent", sentAt: 1_000 });
    updateAttentionItem(ownerId, c.id, { status: "sent", sentAt: 10 }); // before the window
    expect(countCappedAttentionSentSince(ownerId, 500, ["flight_change", "security_alert"])).toBe(1);
  });
});
```

Add to `server/src/db/deleteUserCompletely.test.ts` (import `insertAttentionItem` in the existing import list, and add inside the `describe("deleteUserCompletely", ...)` block):

```ts
  it("does not throw when the owner has an attention_items row", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("attention-item"));
    insertAttentionItem(user.id, {
      eventKey: "ref:DEL123",
      source: "email",
      category: "reservation_confirmed",
      tier: "scheduled",
      status: "pending",
      details: { summary: "Your *Hilton* stay." },
      surfaceAt: Date.now(),
    });

    expect(() => deleteUserCompletely(user.id)).not.toThrow();
    expect(getUser(user.id)).toBeNull();
    expect(findRemainingOwnerReferences(user.id)).toEqual([]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/db/attentionItems.test.ts src/db/deleteUserCompletely.test.ts`
Expected: FAIL — `insertAttentionItem` is not exported.

- [ ] **Step 3: Implement**

In `server/src/db/store.ts`, directly after the `proactive_deliveries` `db.exec` block:

```ts
// One row per real-world event Marlowe might bring up unprompted (a booking, a bill, a flight
// change...), keyed by event_key so the booking email, the venue's own confirmation and a saved
// document about the same thing collapse into one row. services/attention.ts is the only writer.
// See docs/superpowers/specs/2026-09-28-attention-gate-design.md.
db.exec(`
  CREATE TABLE IF NOT EXISTS attention_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id        INTEGER NOT NULL REFERENCES users(id),
    event_key       TEXT NOT NULL,
    source          TEXT NOT NULL,
    category        TEXT NOT NULL,
    tier            TEXT NOT NULL,
    status          TEXT NOT NULL,
    details         TEXT NOT NULL,
    surface_at      INTEGER,
    acknowledged_at INTEGER,
    sent_at         INTEGER,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    UNIQUE (owner_id, event_key)
  );
  CREATE INDEX IF NOT EXISTS idx_attention_owner_status_surface ON attention_items(owner_id, status, surface_at);
`);
```

Near `recordProactiveDelivery`, add the types and functions:

```ts
export type AttentionTier = "interrupt" | "scheduled" | "brief" | "drop";
export type AttentionStatus = "pending" | "sent" | "held" | "folded" | "dropped";
export type AttentionSource = "email" | "document" | "booking" | "reconciliation";

export interface AttentionDetails {
  summary: string;
  kind?: "flight" | "hotel" | "restaurant" | "other";
  eventStart?: string | null;
  dueDate?: string | null;
  reference?: string | null;
  flightNumber?: string | null;
  merchant?: string | null;
  amount?: string | null;
  needsAction?: boolean;
  accountId?: number;
  messageId?: string;
  emailSubject?: string;
  emailFrom?: string;
  bookingEntityId?: number;
  xeroOffer?: { accountId: number; messageId: string; subject: string };
}

export interface AttentionItemRow {
  id: number;
  ownerId: number;
  eventKey: string;
  source: AttentionSource;
  category: string;
  tier: AttentionTier;
  status: AttentionStatus;
  details: AttentionDetails;
  surfaceAt: number | null;
  acknowledgedAt: number | null;
  sentAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface AttentionItemDbRow {
  id: number;
  owner_id: number;
  event_key: string;
  source: AttentionSource;
  category: string;
  tier: AttentionTier;
  status: AttentionStatus;
  details: string;
  surface_at: number | null;
  acknowledged_at: number | null;
  sent_at: number | null;
  created_at: number;
  updated_at: number;
}

function attentionFromDb(r: AttentionItemDbRow): AttentionItemRow {
  let details: AttentionDetails;
  try {
    details = JSON.parse(r.details) as AttentionDetails;
  } catch {
    details = { summary: "" };
  }
  return {
    id: r.id,
    ownerId: r.owner_id,
    eventKey: r.event_key,
    source: r.source,
    category: r.category,
    tier: r.tier,
    status: r.status,
    details,
    surfaceAt: r.surface_at,
    acknowledgedAt: r.acknowledged_at,
    sentAt: r.sent_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function getAttentionItemById(ownerId: number, id: number): AttentionItemRow {
  const row = db.prepare(`SELECT * FROM attention_items WHERE owner_id = ? AND id = ?`).get(ownerId, id) as
    | AttentionItemDbRow
    | undefined;
  if (!row) throw new Error(`attention item ${id} not found`);
  return attentionFromDb(row);
}

export function getAttentionItem(ownerId: number, eventKey: string): AttentionItemRow | null {
  const row = db
    .prepare(`SELECT * FROM attention_items WHERE owner_id = ? AND event_key = ?`)
    .get(ownerId, eventKey) as AttentionItemDbRow | undefined;
  return row ? attentionFromDb(row) : null;
}

export function insertAttentionItem(
  ownerId: number,
  item: {
    eventKey: string;
    source: AttentionSource;
    category: string;
    tier: AttentionTier;
    status: AttentionStatus;
    details: AttentionDetails;
    surfaceAt: number | null;
    acknowledgedAt?: number | null;
  }
): AttentionItemRow {
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO attention_items
         (owner_id, event_key, source, category, tier, status, details, surface_at, acknowledged_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      ownerId,
      item.eventKey,
      item.source,
      item.category,
      item.tier,
      item.status,
      JSON.stringify(item.details),
      item.surfaceAt,
      item.acknowledgedAt ?? null,
      now,
      now
    );
  return getAttentionItemById(ownerId, Number(info.lastInsertRowid));
}

export function updateAttentionItem(
  ownerId: number,
  id: number,
  patch: Partial<{
    tier: AttentionTier;
    status: AttentionStatus;
    details: AttentionDetails;
    surfaceAt: number | null;
    acknowledgedAt: number | null;
    sentAt: number | null;
  }>
): AttentionItemRow {
  const columns: Record<string, string> = {
    tier: "tier",
    status: "status",
    details: "details",
    surfaceAt: "surface_at",
    acknowledgedAt: "acknowledged_at",
    sentAt: "sent_at",
  };
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, column] of Object.entries(columns)) {
    if (!(key in patch)) continue;
    const value = (patch as Record<string, unknown>)[key];
    sets.push(`${column} = ?`);
    params.push(key === "details" ? JSON.stringify(value) : value);
  }
  sets.push("updated_at = ?");
  params.push(Date.now());
  db.prepare(`UPDATE attention_items SET ${sets.join(", ")} WHERE owner_id = ? AND id = ?`).run(...params, ownerId, id);
  return getAttentionItemById(ownerId, id);
}

export function listAttentionItems(
  ownerId: number,
  filter: { statuses?: AttentionStatus[]; dueBefore?: number } = {}
): AttentionItemRow[] {
  const conditions = ["owner_id = ?"];
  const params: unknown[] = [ownerId];
  if (filter.statuses?.length) {
    conditions.push(`status IN (${filter.statuses.map(() => "?").join(", ")})`);
    params.push(...filter.statuses);
  }
  if (filter.dueBefore !== undefined) {
    conditions.push("surface_at IS NOT NULL AND surface_at <= ?");
    params.push(filter.dueBefore);
  }
  const rows = db
    .prepare(
      `SELECT * FROM attention_items WHERE ${conditions.join(" AND ")}
       ORDER BY surface_at IS NULL, surface_at ASC, created_at ASC`
    )
    .all(...params) as AttentionItemDbRow[];
  return rows.map(attentionFromDb);
}

export function countCappedAttentionSentSince(ownerId: number, sinceMs: number, exemptCategories: string[]): number {
  const exempt = exemptCategories.length ? `AND category NOT IN (${exemptCategories.map(() => "?").join(", ")})` : "";
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM attention_items WHERE owner_id = ? AND sent_at IS NOT NULL AND sent_at >= ? ${exempt}`)
    .get(ownerId, sinceMs, ...exemptCategories) as { c: number };
  return row.c;
}
```

In `deleteUserCompletely`, directly after `db.prepare(\`DELETE FROM proactive_deliveries WHERE owner_id = ?\`).run(ownerId);` add:

```ts
    db.prepare(`DELETE FROM attention_items WHERE owner_id = ?`).run(ownerId);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/db/attentionItems.test.ts src/db/deleteUserCompletely.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/db/store.ts server/src/db/attentionItems.test.ts server/src/db/deleteUserCompletely.test.ts
git commit -m "feat: attention_items table for the proactive-message gate"
```

---

### Task 2: Pure attention rules

**Files:**
- Create: `server/src/services/attentionRules.ts`
- Test: `server/src/services/attentionRules.test.ts`

**Interfaces:**
- Consumes: `AttentionDetails`, `AttentionTier` from `../db/store.js` (types only).
- Produces:
  ```ts
  export const DAILY_CAP = 4;
  export const CAP_EXEMPT_CATEGORIES: string[]; // ["flight_change", "security_alert", "person_email"]
  export function parseEventStart(value: string | null | undefined, zone: string | null): { ms: number; hasTime: boolean } | null;
  export function tierFor(category: string, details: AttentionDetails, now: number, zone: string | null): AttentionTier;
  export function eventKeyFor(details: AttentionDetails, fallback: string): string;
  export function surfaceAtFor(category: string, details: AttentionDetails, zone: string | null): number | null;
  export function inQuietHours(ms: number, zone: string | null): boolean;
  export function nextAllowedTime(ms: number, zone: string | null, briefingTime: string | null): number;
  export function localDayStart(ms: number, zone: string | null): number;
  export function formatWhen(ms: number, zone: string | null, now: number): string;
  export function isConcrete(text: string): boolean;
  export function interruptText(category: string, details: AttentionDetails, reminderMoved: boolean): string;
  export function reminderText(category: string, details: AttentionDetails, zone: string | null, now: number): string;
  export function ackLine(details: AttentionDetails, surfaceAt: number, zone: string | null, now: number): string;
  export function briefLine(details: AttentionDetails): string;
  ```

- [ ] **Step 1: Write the failing test**

Create `server/src/services/attentionRules.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import {
  parseEventStart,
  tierFor,
  eventKeyFor,
  surfaceAtFor,
  inQuietHours,
  nextAllowedTime,
  localDayStart,
  formatWhen,
  isConcrete,
  interruptText,
  reminderText,
  ackLine,
  briefLine,
} from "./attentionRules.js";

const ZONE = "Europe/London";
const at = (iso: string) => DateTime.fromISO(iso, { zone: ZONE }).toMillis();
const NOW = at("2026-10-01T12:00");

describe("parseEventStart", () => {
  it("reads a date-only value as the start of that local day, without a time", () => {
    expect(parseEventStart("2026-10-03", ZONE)).toEqual({ ms: at("2026-10-03T00:00"), hasTime: false });
  });
  it("keeps an explicit offset", () => {
    expect(parseEventStart("2026-10-03T08:40:00+01:00", ZONE)).toEqual({ ms: at("2026-10-03T08:40"), hasTime: true });
  });
  it("returns null for anything that isn't a date", () => {
    expect(parseEventStart("next Tuesday", ZONE)).toBeNull();
    expect(parseEventStart("", ZONE)).toBeNull();
    expect(parseEventStart(null, ZONE)).toBeNull();
  });
  it("works with no known timezone", () => {
    const parsed = parseEventStart("2026-10-03", null);
    expect(parsed?.hasTime).toBe(false);
    expect(Number.isFinite(parsed?.ms)).toBe(true);
  });
});

describe("tierFor", () => {
  const s = { summary: "x" };
  it("interrupts for flight changes and security alerts", () => {
    expect(tierFor("flight_change", s, NOW, ZONE)).toBe("interrupt");
    expect(tierFor("security_alert", s, NOW, ZONE)).toBe("interrupt");
  });
  it("interrupts for government mail only when it needs action", () => {
    expect(tierFor("government_mail", { ...s, needsAction: true }, NOW, ZONE)).toBe("interrupt");
    expect(tierFor("government_mail", s, NOW, ZONE)).toBe("brief");
  });
  it("schedules a bill due later, interrupts one due within 2 days or overdue", () => {
    expect(tierFor("invoice_due", { ...s, dueDate: "2026-10-10" }, NOW, ZONE)).toBe("scheduled");
    expect(tierFor("invoice_due", { ...s, dueDate: "2026-10-03" }, NOW, ZONE)).toBe("interrupt");
    expect(tierFor("invoice_due", { ...s, dueDate: "2026-09-20" }, NOW, ZONE)).toBe("interrupt");
  });
  it("interrupts for an undated bill that needs action, briefs one that doesn't", () => {
    expect(tierFor("invoice_due", { ...s, needsAction: true }, NOW, ZONE)).toBe("interrupt");
    expect(tierFor("invoice_due", s, NOW, ZONE)).toBe("brief");
  });
  it("schedules a future reservation, drops a past one, briefs an undated one", () => {
    expect(tierFor("reservation_confirmed", { ...s, eventStart: "2026-10-12" }, NOW, ZONE)).toBe("scheduled");
    expect(tierFor("reservation_confirmed", { ...s, eventStart: "2026-09-12" }, NOW, ZONE)).toBe("drop");
    expect(tierFor("reservation_confirmed", { ...s, eventStart: "sometime" }, NOW, ZONE)).toBe("brief");
  });
  it("still schedules a reservation later today", () => {
    expect(tierFor("reservation_confirmed", { ...s, eventStart: "2026-10-01" }, NOW, ZONE)).toBe("scheduled");
  });
  it("schedules a dated renewal, briefs an undated one, drops a past one", () => {
    expect(tierFor("subscription_renewal", { ...s, dueDate: "2026-10-20" }, NOW, ZONE)).toBe("scheduled");
    expect(tierFor("subscription_renewal", s, NOW, ZONE)).toBe("brief");
    expect(tierFor("subscription_renewal", { ...s, dueDate: "2026-09-01" }, NOW, ZONE)).toBe("drop");
  });
  it("drops routine deliveries, briefs ones that need action", () => {
    expect(tierFor("delivery_notification", s, NOW, ZONE)).toBe("drop");
    expect(tierFor("delivery_notification", { ...s, needsAction: true }, NOW, ZONE)).toBe("brief");
  });
  it("briefs refund updates and document matches; person emails interrupt", () => {
    expect(tierFor("refund_dispute", s, NOW, ZONE)).toBe("brief");
    expect(tierFor("document_match", s, NOW, ZONE)).toBe("brief");
    expect(tierFor("person_email", s, NOW, ZONE)).toBe("interrupt");
  });
});

describe("eventKeyFor", () => {
  it("prefers a normalised reference", () => {
    expect(eventKeyFor({ summary: "", reference: " abc 123 " }, "msg:1:x")).toBe("ref:ABC123");
  });
  it("ignores a reference too short to be distinctive", () => {
    expect(eventKeyFor({ summary: "", reference: "A1" }, "msg:1:x")).toBe("msg:1:x");
  });
  it("uses flight number + date when there is no reference", () => {
    expect(eventKeyFor({ summary: "", flightNumber: "ba 432", eventStart: "2026-10-03T08:40:00+01:00" }, "f")).toBe(
      "flight:BA432:2026-10-03"
    );
  });
  it("uses merchant + date as a last structured resort", () => {
    expect(eventKeyFor({ summary: "", merchant: "Netflix, Inc.", dueDate: "2026-10-03" }, "f")).toBe(
      "merchant:netflix-inc:2026-10-03"
    );
  });
  it("falls back when nothing identifies the event", () => {
    expect(eventKeyFor({ summary: "", merchant: "Netflix" }, "msg:1:x")).toBe("msg:1:x");
  });
});

describe("surfaceAtFor", () => {
  it("flight with a time: 24h before", () => {
    expect(surfaceAtFor("reservation_confirmed", { summary: "", kind: "flight", eventStart: "2026-10-03T08:40:00+01:00" }, ZONE)).toBe(
      at("2026-10-02T08:40")
    );
  });
  it("flight date only: 09:00 the day before", () => {
    expect(surfaceAtFor("reservation_confirmed", { summary: "", kind: "flight", eventStart: "2026-10-03" }, ZONE)).toBe(
      at("2026-10-02T09:00")
    );
  });
  it("hotel: 09:00 on check-in day", () => {
    expect(surfaceAtFor("reservation_confirmed", { summary: "", kind: "hotel", eventStart: "2026-10-12T15:00:00+01:00" }, ZONE)).toBe(
      at("2026-10-12T09:00")
    );
  });
  it("restaurant with a time: 3h before; without: 09:00 that day", () => {
    expect(surfaceAtFor("reservation_confirmed", { summary: "", kind: "restaurant", eventStart: "2026-10-05T20:00:00+01:00" }, ZONE)).toBe(
      at("2026-10-05T17:00")
    );
    expect(surfaceAtFor("reservation_confirmed", { summary: "", kind: "restaurant", eventStart: "2026-10-05" }, ZONE)).toBe(
      at("2026-10-05T09:00")
    );
  });
  it("renewal: 09:00 three days before; bill: 09:00 two days before", () => {
    expect(surfaceAtFor("subscription_renewal", { summary: "", dueDate: "2026-10-20" }, ZONE)).toBe(at("2026-10-17T09:00"));
    expect(surfaceAtFor("invoice_due", { summary: "", dueDate: "2026-10-20" }, ZONE)).toBe(at("2026-10-18T09:00"));
  });
  it("returns null with no usable date", () => {
    expect(surfaceAtFor("reservation_confirmed", { summary: "", eventStart: "soon" }, ZONE)).toBeNull();
  });
});

describe("quiet hours", () => {
  it("is quiet from 22:00 to 07:00 local", () => {
    expect(inQuietHours(at("2026-10-01T22:00"), ZONE)).toBe(true);
    expect(inQuietHours(at("2026-10-02T03:00"), ZONE)).toBe(true);
    expect(inQuietHours(at("2026-10-02T06:59"), ZONE)).toBe(true);
    expect(inQuietHours(at("2026-10-02T07:00"), ZONE)).toBe(false);
    expect(inQuietHours(at("2026-10-01T21:59"), ZONE)).toBe(false);
  });
  it("defers to 07:00 the next morning, or to an early briefing time", () => {
    expect(nextAllowedTime(at("2026-10-01T23:30"), ZONE, null)).toBe(at("2026-10-02T07:00"));
    expect(nextAllowedTime(at("2026-10-02T02:00"), ZONE, null)).toBe(at("2026-10-02T07:00"));
    expect(nextAllowedTime(at("2026-10-02T02:00"), ZONE, "07:30")).toBe(at("2026-10-02T07:30"));
    expect(nextAllowedTime(at("2026-10-02T02:00"), ZONE, "10:00")).toBe(at("2026-10-02T07:00"));
  });
  it("returns the same time outside quiet hours", () => {
    expect(nextAllowedTime(at("2026-10-01T12:00"), ZONE, null)).toBe(at("2026-10-01T12:00"));
  });
  it("does not throw with no known timezone", () => {
    expect(() => inQuietHours(NOW, null)).not.toThrow();
    expect(Number.isFinite(nextAllowedTime(NOW, null, null))).toBe(true);
  });
  it("finds the local day start", () => {
    expect(localDayStart(at("2026-10-01T15:00"), ZONE)).toBe(at("2026-10-01T00:00"));
  });
});

describe("formatWhen", () => {
  it("says today / tomorrow with a time, else a short date", () => {
    expect(formatWhen(at("2026-10-01T17:00"), ZONE, NOW)).toBe("today at 17:00");
    expect(formatWhen(at("2026-10-02T09:00"), ZONE, NOW)).toBe("tomorrow at 09:00");
    expect(formatWhen(at("2026-10-17T09:00"), ZONE, NOW)).toBe("Sat 17 Oct");
  });
});

describe("isConcrete", () => {
  it("needs a bold specific", () => {
    expect(isConcrete("Your flight moved.")).toBe(false);
    expect(isConcrete("Your *BA 432* now leaves *09:55*.")).toBe(true);
  });
  it("rejects the banned vague phrases", () => {
    for (const text of [
      "An email about your *Hotel* came in. Worth a look?",
      "*3* emails — check your inbox",
      "*2* important-looking emails",
      "*Sarah* emailed, and 4 more",
      "*X* might need attention",
      "*2* more — just ask and I'll run through them",
    ]) {
      expect(isConcrete(text)).toBe(false);
    }
  });
});

describe("message builders", () => {
  const flight = {
    summary: "Your *BA 432* to Lisbon now leaves *09:55* (was 08:40).",
    kind: "flight" as const,
    eventStart: "2026-10-02T09:55:00+01:00",
  };
  it("interrupt text leads with the category emoji and notes a moved reminder", () => {
    const text = interruptText("flight_change", flight, true);
    expect(text).toBe("✈️ Your *BA 432* to Lisbon now leaves *09:55* (was 08:40). Nothing to do — I've moved your reminder.");
    expect(isConcrete(text)).toBe(true);
  });
  it("person-email interrupt uses the mail emoji", () => {
    expect(interruptText("person_email", { summary: "*Sarah Kim* — wants to move Thursday's call; needs a reply" }, false)).toBe(
      "📬 *Sarah Kim* — wants to move Thursday's call; needs a reply"
    );
  });
  it("flight reminder says check-in is open", () => {
    const text = reminderText("reservation_confirmed", { ...flight, summary: "Your *BA 432* to Lisbon, ref *X7KQ2P*." }, ZONE, NOW);
    expect(text).toBe("✈️ Reminder: Your *BA 432* to Lisbon, ref *X7KQ2P*. Online check-in should be open now.");
  });
  it("renewal reminder names when it charges", () => {
    const text = reminderText("subscription_renewal", { summary: "Your *Netflix* renews at *£17.99*.", dueDate: "2026-10-03" }, ZONE, NOW);
    expect(text).toBe("🔁 Reminder: Your *Netflix* renews at *£17.99*. It charges Sat 3 Oct — tell me if you want to cancel.");
  });
  it("ack line says what was noted and when Marlowe will bring it up", () => {
    expect(ackLine({ summary: "Your *Netflix* renewal, *£17.99* on *3 Oct*." }, at("2026-09-30T09:00"), ZONE, at("2026-09-28T08:00"))).toBe(
      "Noted: your *Netflix* renewal, *£17.99* on *3 Oct* — I'll remind you Wed 30 Sep."
    );
  });
  it("brief line is the summary", () => {
    expect(briefLine({ summary: "Your *Amazon* refund of *£24* was approved." })).toBe("Your *Amazon* refund of *£24* was approved.");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/services/attentionRules.test.ts`
Expected: FAIL — cannot find module `./attentionRules.js`.

- [ ] **Step 3: Implement**

Create `server/src/services/attentionRules.ts`:

```ts
// Pure rules for the attention gate (attention.ts): which tier an event gets, how events are
// deduped, when a reminder should fire, quiet hours, and the exact text of every message. No I/O,
// so every decision is unit-testable. See docs/superpowers/specs/2026-09-28-attention-gate-design.md.
import { DateTime } from "luxon";
import type { AttentionDetails, AttentionTier } from "../db/store.js";

export const DAILY_CAP = 4;
// Never held by the cap: a flight change or security alert can't wait, and a user who asked for
// every person's email instantly asked for exactly that.
export const CAP_EXEMPT_CATEGORIES = ["flight_change", "security_alert", "person_email"];
// The one category allowed to message during quiet hours.
export const QUIET_HOURS_EXEMPT_CATEGORIES = ["flight_change"];

const QUIET_START_HOUR = 22;
const QUIET_END_HOUR = 7;
const REMINDER_HOUR = 9;

const EMOJI: Record<string, string> = {
  flight_change: "✈️",
  reservation_confirmed: "📅",
  invoice_due: "💳",
  government_mail: "🏛️",
  delivery_notification: "📦",
  security_alert: "🔐",
  subscription_renewal: "🔁",
  refund_dispute: "💰",
  document_match: "📎",
  person_email: "📬",
};

function localNow(ms: number, zone: string | null): DateTime {
  const zoned = zone ? DateTime.fromMillis(ms, { zone }) : DateTime.fromMillis(ms);
  return zoned.isValid ? zoned : DateTime.fromMillis(ms);
}

function localDate(value: string, zone: string | null): DateTime | null {
  const parsed = zone ? DateTime.fromISO(value, { zone }) : DateTime.fromISO(value);
  if (parsed.isValid) return parsed;
  return null;
}

export function parseEventStart(
  value: string | null | undefined,
  zone: string | null
): { ms: number; hasTime: boolean } | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const day = localDate(trimmed, zone);
    return day ? { ms: day.startOf("day").toMillis(), hasTime: false } : null;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(trimmed)) return null;
  const parsed = zone ? DateTime.fromISO(trimmed, { zone, setZone: false }) : DateTime.fromISO(trimmed);
  return parsed.isValid ? { ms: parsed.toMillis(), hasTime: true } : null;
}

// Whole local calendar days from today to `date` (negative = in the past).
function daysUntil(date: string, now: number, zone: string | null): number | null {
  const target = parseEventStart(date, zone);
  if (!target) return null;
  const today = localNow(now, zone).startOf("day");
  const day = localNow(target.ms, zone).startOf("day");
  return Math.round(day.diff(today, "days").days);
}

// An event is over once its day has ended (date-only) or its start time has passed.
function eventOver(eventStart: string | null | undefined, now: number, zone: string | null): boolean | null {
  const parsed = parseEventStart(eventStart, zone);
  if (!parsed) return null;
  if (parsed.hasTime) return parsed.ms < now;
  return localNow(parsed.ms, zone).endOf("day").toMillis() < now;
}

export function tierFor(category: string, details: AttentionDetails, now: number, zone: string | null): AttentionTier {
  switch (category) {
    case "flight_change":
    case "security_alert":
    case "person_email":
      return "interrupt";
    case "government_mail":
      return details.needsAction ? "interrupt" : "brief";
    case "invoice_due": {
      const days = details.dueDate ? daysUntil(details.dueDate, now, zone) : null;
      if (days === null) return details.needsAction ? "interrupt" : "brief";
      return days <= 2 ? "interrupt" : "scheduled";
    }
    case "reservation_confirmed": {
      const over = eventOver(details.eventStart, now, zone);
      if (over === null) return "brief";
      return over ? "drop" : "scheduled";
    }
    case "subscription_renewal": {
      const days = details.dueDate ? daysUntil(details.dueDate, now, zone) : null;
      if (days === null) return "brief";
      return days < 0 ? "drop" : "scheduled";
    }
    case "delivery_notification":
      return details.needsAction ? "brief" : "drop";
    default:
      return "brief";
  }
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function dateOf(value: string | null | undefined): string | null {
  const match = value?.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

export function eventKeyFor(details: AttentionDetails, fallback: string): string {
  const ref = details.reference?.replace(/\s+/g, "").toUpperCase();
  if (ref && ref.length >= 4) return `ref:${ref}`;
  const date = dateOf(details.eventStart) ?? dateOf(details.dueDate);
  const flight = details.flightNumber?.replace(/\s+/g, "").toUpperCase();
  if (flight && date) return `flight:${flight}:${date}`;
  const merchant = details.merchant ? slug(details.merchant) : "";
  if (merchant && date) return `merchant:${merchant}:${date}`;
  return fallback;
}

function atLocalHour(ms: number, zone: string | null, hour: number, dayOffset: number): number {
  return localNow(ms, zone).startOf("day").plus({ days: dayOffset }).set({ hour, minute: 0 }).toMillis();
}

export function surfaceAtFor(category: string, details: AttentionDetails, zone: string | null): number | null {
  if (category === "subscription_renewal" || category === "invoice_due") {
    const due = parseEventStart(details.dueDate, zone);
    if (!due) return null;
    return atLocalHour(due.ms, zone, REMINDER_HOUR, category === "subscription_renewal" ? -3 : -2);
  }
  const start = parseEventStart(details.eventStart, zone);
  if (!start) return null;
  switch (details.kind) {
    case "flight":
      return start.hasTime ? start.ms - 24 * 60 * 60 * 1000 : atLocalHour(start.ms, zone, REMINDER_HOUR, -1);
    case "hotel":
      return atLocalHour(start.ms, zone, REMINDER_HOUR, 0);
    default:
      return start.hasTime ? start.ms - 3 * 60 * 60 * 1000 : atLocalHour(start.ms, zone, REMINDER_HOUR, 0);
  }
}

export function inQuietHours(ms: number, zone: string | null): boolean {
  const hour = localNow(ms, zone).hour;
  return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
}

// When a message due at `ms` may actually go out. An early proactive briefing (07:00–09:00) is the
// natural end of the night, so deferred items wait for it and get folded in instead of pinging first.
export function nextAllowedTime(ms: number, zone: string | null, briefingTime: string | null): number {
  if (!inQuietHours(ms, zone)) return ms;
  const local = localNow(ms, zone);
  const morning = local.hour >= QUIET_START_HOUR ? local.plus({ days: 1 }).startOf("day") : local.startOf("day");
  let [hour, minute] = [QUIET_END_HOUR, 0];
  if (briefingTime && briefingTime >= "07:00" && briefingTime <= "09:00") {
    [hour, minute] = briefingTime.split(":").map(Number);
  }
  return morning.set({ hour, minute }).toMillis();
}

export function localDayStart(ms: number, zone: string | null): number {
  return localNow(ms, zone).startOf("day").toMillis();
}

export function formatWhen(ms: number, zone: string | null, now: number): string {
  const when = localNow(ms, zone);
  const today = localNow(now, zone).startOf("day");
  const days = Math.round(when.startOf("day").diff(today, "days").days);
  if (days === 0) return `today at ${when.toFormat("HH:mm")}`;
  if (days === 1) return `tomorrow at ${when.toFormat("HH:mm")}`;
  return when.toFormat("ccc d LLL");
}

const BANNED_PHRASES = [
  /worth a look/i,
  /check your inbox/i,
  /important-looking/i,
  /\band \d+ more\b/i,
  /might need attention/i,
  /just ask and i'll run through/i,
];

export function isConcrete(text: string): boolean {
  if (!/\*[^*\s][^*]*\*/.test(text)) return false;
  return !BANNED_PHRASES.some((re) => re.test(text));
}

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export function interruptText(category: string, details: AttentionDetails, reminderMoved: boolean): string {
  const emoji = EMOJI[category] ?? "📌";
  if (category === "person_email") return `${emoji} ${details.summary.trim()}`;
  const moved = reminderMoved ? " Nothing to do — I've moved your reminder." : "";
  return `${emoji} ${sentence(details.summary)}${moved}`;
}

export function reminderText(category: string, details: AttentionDetails, zone: string | null, now: number): string {
  const body = sentence(details.summary);
  if (category === "subscription_renewal" && details.dueDate) {
    const due = parseEventStart(details.dueDate, zone);
    const when = due ? formatWhen(atLocalHour(due.ms, zone, REMINDER_HOUR, 0), zone, now) : details.dueDate;
    return `🔁 Reminder: ${body} It charges ${when.replace(/ at 09:00$/, "")} — tell me if you want to cancel.`;
  }
  if (category === "invoice_due" && details.dueDate) {
    const due = parseEventStart(details.dueDate, zone);
    const when = due ? formatWhen(atLocalHour(due.ms, zone, REMINDER_HOUR, 0), zone, now) : details.dueDate;
    return `💳 Reminder: ${body} Due ${when.replace(/ at 09:00$/, "")}.`;
  }
  switch (details.kind) {
    case "flight":
      return `✈️ Reminder: ${body} Online check-in should be open now.`;
    case "hotel":
      return `🏨 Reminder: ${body} Check-in is today.`;
    default:
      return `📅 Reminder: ${body}`;
  }
}

export function ackLine(details: AttentionDetails, surfaceAt: number, zone: string | null, now: number): string {
  const summary = details.summary.trim().replace(/[.!]$/, "");
  const lowered = summary.replace(/^Your\b/, "your");
  return `Noted: ${lowered} — I'll remind you ${formatWhen(surfaceAt, zone, now).replace(/ at 09:00$/, "")}.`;
}

export function briefLine(details: AttentionDetails): string {
  return sentence(details.summary);
}
```

Note on `reminderText` for renewals: `formatWhen` of a date two or more days away already yields a bare date ("Sat 3 Oct"); the `.replace(/ at 09:00$/, "")` only matters for today/tomorrow ("tomorrow at 09:00" → "tomorrow").

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/services/attentionRules.test.ts`
Expected: PASS. If `formatWhen`'s expected strings differ by locale (e.g. "Sat 17 Oct"), luxon defaults to `en-US` unless `Settings.defaultLocale` is set — the format tokens `ccc d LLL` give "Sat 17 Oct" in `en-US`; keep the tokens and fix the test only if the environment's locale differs.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/attentionRules.ts server/src/services/attentionRules.test.ts
git commit -m "feat: pure rules for tiering, timing and wording proactive messages"
```

---

### Task 3: Attention gate I/O

**Files:**
- Create: `server/src/services/attention.ts`
- Test: `server/src/services/attention.test.ts`

**Interfaces:**
- Consumes: Task 1 store functions/types; Task 2 rules; `sendToAllNumbers` (`./proactiveDelivery.js`); `getUserTimezone` (`./userTimezone.js`); `getBriefingSettings` (`./briefing.js`); `isPostConnectChainInProgress` (`./onboardingAlertSuppression.js`); `getXeroForwardingEmail` (`./xero.js`); `setPendingInvoiceForward` (`./xeroInvoiceConfirmation.js`); `emailReferenceNote` (`./emailReference.js`); `isWhatsAppConfigured` (`../providers/whatsapp.js`); `listPhoneNumbersForUser`, `getSetting` (`../db/store.js`).
- Produces:
  ```ts
  export interface AttentionCandidate {
    source: AttentionSource;
    category: string;
    details: AttentionDetails;
    fallbackKey: string;
    acknowledged?: boolean; // true when the user told us about it themselves (a saved document)
  }
  export type SubmitOutcome = "sent" | "scheduled" | "queued" | "merged" | "dropped" | "deferred" | "held" | "failed";
  export async function submitAttentionItem(ownerId: number, candidate: AttentionCandidate): Promise<SubmitOutcome>;
  export async function deliverDueAttentionItems(ownerId: number): Promise<void>;
  export interface AttentionBundle { noted: string[]; needsAttention: string[]; upcoming: string[]; ackIds: number[]; foldIds: number[] }
  export function isEmptyBundle(b: AttentionBundle): boolean;
  export function collectAttentionForBriefing(ownerId: number, now: number): AttentionBundle;
  export function collectAttentionForDigest(ownerId: number, now: number, includeBriefItems: boolean): AttentionBundle;
  export function commitAttentionBundle(ownerId: number, bundle: AttentionBundle, now: number): void;
  ```

- [ ] **Step 1: Write the failing test**

Create `server/src/services/attention.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../providers/whatsapp.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../providers/whatsapp.js")>();
  return {
    ...actual,
    sendWhatsAppMessage: vi.fn(),
    sendWhatsAppTemplate: vi.fn(),
    isWhatsAppConfigured: vi.fn().mockReturnValue(true),
  };
});

const { sendWhatsAppMessage } = await import("../providers/whatsapp.js");
const { findOrCreateUserByEmail, addPhoneNumberForUser, recordInboundMessage, getAttentionItem, listAttentionItems } =
  await import("../db/store.js");
const { setUserTimezone } = await import("./userTimezone.js");
const { saveBriefingSettings } = await import("./briefing.js");
const {
  submitAttentionItem,
  deliverDueAttentionItems,
  collectAttentionForBriefing,
  collectAttentionForDigest,
  commitAttentionBundle,
} = await import("./attention.js");
const { DateTime } = await import("luxon");

const ZONE = "Europe/London";
const at = (iso: string) => DateTime.fromISO(iso, { zone: ZONE }).toJSDate();

let counter = 0;
// Phone prefix "44700011" — see importantEmailAlerts.test.ts on prefixes shared across files.
function newUser() {
  counter += 1;
  const user = findOrCreateUserByEmail(`attention-${Date.now()}-${counter}@example.com`);
  const phone = `44700011${String(counter).padStart(4, "0")}`;
  addPhoneNumberForUser(user.id, phone);
  recordInboundMessage(phone);
  setUserTimezone(user.id, ZONE);
  return user.id;
}

function sentTexts(): string[] {
  return vi.mocked(sendWhatsAppMessage).mock.calls.map(([, text]) => text as string);
}

const hotel = (ref = "HLT12345") => ({
  source: "email" as const,
  category: "reservation_confirmed",
  details: {
    summary: "Your *Hilton Lisbon* stay is confirmed for *12–15 Oct*, ref *" + ref + "*.",
    kind: "hotel" as const,
    eventStart: "2026-10-12",
    reference: ref,
  },
  fallbackKey: `msg:1:${ref}`,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at("2026-10-01T12:00"));
  vi.mocked(sendWhatsAppMessage).mockReset().mockResolvedValue("wamid");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("submitAttentionItem", () => {
  it("stays silent for a future booking and schedules its reminder", async () => {
    const ownerId = newUser();
    expect(await submitAttentionItem(ownerId, hotel())).toBe("scheduled");
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    const row = getAttentionItem(ownerId, "ref:HLT12345");
    expect(row?.tier).toBe("scheduled");
    expect(row?.surfaceAt).toBe(at("2026-10-12T09:00").getTime());
  });

  it("merges the same event from a second source into one row with no message", async () => {
    const ownerId = newUser();
    await submitAttentionItem(ownerId, hotel());
    expect(
      await submitAttentionItem(ownerId, {
        source: "reconciliation",
        category: "document_match",
        details: { summary: '*Hilton booking* — new email: "Your stay"', reference: "HLT12345" },
        fallbackKey: "msg:1:other",
      })
    ).toBe("merged");
    expect(listAttentionItems(ownerId)).toHaveLength(1);
    expect(getAttentionItem(ownerId, "ref:HLT12345")?.details.summary).toContain("Hilton Lisbon");
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it("submitting the identical item twice never sends twice", async () => {
    const ownerId = newUser();
    const change = {
      source: "email" as const,
      category: "security_alert",
      details: { summary: "New sign-in to your *Google* account from *Paris*." },
      fallbackKey: "msg:1:sec",
    };
    expect(await submitAttentionItem(ownerId, change)).toBe("sent");
    expect(await submitAttentionItem(ownerId, change)).toBe("merged");
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
  });

  it("interrupts at once for a flight change and notes a moved reminder on a known booking", async () => {
    const ownerId = newUser();
    await submitAttentionItem(ownerId, {
      source: "email",
      category: "reservation_confirmed",
      details: { summary: "Your *BA 432* to Lisbon on *3 Oct*.", kind: "flight", flightNumber: "BA432", eventStart: "2026-10-03T08:40:00+01:00" },
      fallbackKey: "msg:1:a",
    });
    const outcome = await submitAttentionItem(ownerId, {
      source: "email",
      category: "flight_change",
      details: { summary: "Your *BA 432* to Lisbon now leaves *09:55* (was 08:40).", kind: "flight", flightNumber: "BA432", eventStart: "2026-10-03T09:55:00+01:00" },
      fallbackKey: "msg:1:b",
    });
    expect(outcome).toBe("sent");
    expect(sentTexts()).toEqual([
      "✈️ Your *BA 432* to Lisbon now leaves *09:55* (was 08:40). Nothing to do — I've moved your reminder.",
    ]);
    const row = getAttentionItem(ownerId, "flight:BA432:2026-10-03");
    expect(row?.tier).toBe("scheduled");
    expect(row?.status).toBe("pending");
    expect(row?.surfaceAt).toBe(at("2026-10-02T09:55").getTime());
  });

  it("drops a booking whose date has already passed", async () => {
    const ownerId = newUser();
    const past = hotel("OLD12345");
    past.details.eventStart = "2026-09-20";
    expect(await submitAttentionItem(ownerId, past)).toBe("dropped");
    expect(getAttentionItem(ownerId, "ref:OLD12345")?.status).toBe("dropped");
  });

  it("defers a non-flight interrupt during quiet hours, but sends a flight change", async () => {
    vi.setSystemTime(at("2026-10-01T23:30"));
    const ownerId = newUser();
    expect(
      await submitAttentionItem(ownerId, {
        source: "email",
        category: "government_mail",
        details: { summary: "*HMRC* needs your tax return by *31 Oct*.", needsAction: true },
        fallbackKey: "msg:1:gov",
      })
    ).toBe("deferred");
    expect(
      await submitAttentionItem(ownerId, {
        source: "email",
        category: "flight_change",
        details: { summary: "Your *EZY 8021* is *cancelled*." },
        fallbackKey: "msg:1:ezy",
      })
    ).toBe("sent");
    expect(sentTexts()).toHaveLength(1);
    expect(getAttentionItem(ownerId, "msg:1:gov")?.surfaceAt).toBe(at("2026-10-02T07:00").getTime());
  });

  it("downgrades a message that isn't concrete to the briefing instead of sending it", async () => {
    const ownerId = newUser();
    expect(
      await submitAttentionItem(ownerId, {
        source: "email",
        category: "security_alert",
        details: { summary: "Something happened on an account." },
        fallbackKey: "msg:1:vague",
      })
    ).toBe("queued");
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(getAttentionItem(ownerId, "msg:1:vague")?.tier).toBe("brief");
  });

  it("stores items even with no reachable number, and interrupts stay pending for later", async () => {
    const user = findOrCreateUserByEmail(`attention-nophone-${Date.now()}@example.com`);
    setUserTimezone(user.id, ZONE);
    expect(
      await submitAttentionItem(user.id, {
        source: "email",
        category: "security_alert",
        details: { summary: "New sign-in to your *Google* account." },
        fallbackKey: "msg:1:nophone",
      })
    ).toBe("failed");
    expect(getAttentionItem(user.id, "msg:1:nophone")?.status).toBe("pending");
  });
});

describe("deliverDueAttentionItems", () => {
  it("sends a scheduled reminder once it is due, exactly once", async () => {
    const ownerId = newUser();
    await submitAttentionItem(ownerId, hotel());
    vi.setSystemTime(at("2026-10-12T09:05"));
    await deliverDueAttentionItems(ownerId);
    await deliverDueAttentionItems(ownerId);
    expect(sentTexts()).toEqual([
      "🏨 Reminder: Your *Hilton Lisbon* stay is confirmed for *12–15 Oct*, ref *HLT12345*. Check-in is today.",
    ]);
    expect(getAttentionItem(ownerId, "ref:HLT12345")?.status).toBe("sent");
  });

  it("holds the 5th capped message of the day instead of sending or dropping it", async () => {
    const ownerId = newUser();
    for (let i = 0; i < 5; i++) {
      await submitAttentionItem(ownerId, {
        source: "email",
        category: "government_mail",
        details: { summary: `*Council* letter ${i} needs a reply by *10 Oct*.`, needsAction: true },
        fallbackKey: `msg:1:gov${i}`,
      });
    }
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(4);
    expect(getAttentionItem(ownerId, "msg:1:gov4")?.status).toBe("held");
    // Exempt categories still go through.
    await submitAttentionItem(ownerId, {
      source: "email",
      category: "flight_change",
      details: { summary: "Your *BA 1* is *cancelled*." },
      fallbackKey: "msg:1:ba1",
    });
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(5);
  });

  it("a failed send stays pending, retries next tick, and doesn't use up the cap", async () => {
    const ownerId = newUser();
    await submitAttentionItem(ownerId, hotel());
    vi.setSystemTime(at("2026-10-12T09:05"));
    vi.mocked(sendWhatsAppMessage).mockRejectedValueOnce(new Error("network"));
    await deliverDueAttentionItems(ownerId);
    expect(getAttentionItem(ownerId, "ref:HLT12345")?.status).toBe("pending");
    await deliverDueAttentionItems(ownerId);
    expect(getAttentionItem(ownerId, "ref:HLT12345")?.status).toBe("sent");
  });

  it("sends a quiet-hours-deferred item at 07:00", async () => {
    vi.setSystemTime(at("2026-10-01T23:30"));
    const ownerId = newUser();
    await submitAttentionItem(ownerId, {
      source: "email",
      category: "government_mail",
      details: { summary: "*HMRC* needs your tax return by *31 Oct*.", needsAction: true },
      fallbackKey: "msg:1:gov",
    });
    vi.setSystemTime(at("2026-10-02T06:55"));
    await deliverDueAttentionItems(ownerId);
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    vi.setSystemTime(at("2026-10-02T07:02"));
    await deliverDueAttentionItems(ownerId);
    expect(sentTexts()).toEqual(["🏛️ *HMRC* needs your tax return by *31 Oct*."]);
  });
});

describe("collecting for the briefing and digest", () => {
  it("the briefing acknowledges new bookings once and lists brief/held items", async () => {
    const ownerId = newUser();
    await submitAttentionItem(ownerId, hotel());
    await submitAttentionItem(ownerId, {
      source: "email",
      category: "refund_dispute",
      details: { summary: "Your *Amazon* refund of *£24* was approved." },
      fallbackKey: "msg:1:refund",
    });
    const now = at("2026-10-02T07:30").getTime();
    const bundle = collectAttentionForBriefing(ownerId, now);
    expect(bundle.noted).toEqual([
      "Noted: your *Hilton Lisbon* stay is confirmed for *12–15 Oct*, ref *HLT12345* — I'll remind you Mon 12 Oct.",
    ]);
    expect(bundle.needsAttention).toEqual(["Your *Amazon* refund of *£24* was approved."]);
    commitAttentionBundle(ownerId, bundle, now);
    const again = collectAttentionForBriefing(ownerId, now);
    expect(again.noted).toEqual([]);
    expect(again.needsAttention).toEqual([]);
  });

  it("the briefing folds in reminders due within the next 2 hours so they don't ping separately", async () => {
    const ownerId = newUser();
    await submitAttentionItem(ownerId, hotel());
    const now = at("2026-10-12T07:30").getTime();
    const bundle = collectAttentionForBriefing(ownerId, now);
    expect(bundle.upcoming).toHaveLength(1);
    commitAttentionBundle(ownerId, bundle, now);
    vi.setSystemTime(at("2026-10-12T09:05"));
    await deliverDueAttentionItems(ownerId);
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(getAttentionItem(ownerId, "ref:HLT12345")?.status).toBe("folded");
  });

  it("the digest always carries held items, and brief items only when asked", async () => {
    const ownerId = newUser();
    for (let i = 0; i < 5; i++) {
      await submitAttentionItem(ownerId, {
        source: "email",
        category: "government_mail",
        details: { summary: `*Council* letter ${i} needs a reply by *10 Oct*.`, needsAction: true },
        fallbackKey: `msg:1:gov${i}`,
      });
    }
    await submitAttentionItem(ownerId, {
      source: "email",
      category: "refund_dispute",
      details: { summary: "Your *Amazon* refund of *£24* was approved." },
      fallbackKey: "msg:1:refund",
    });
    const now = at("2026-10-01T21:00").getTime();
    expect(collectAttentionForDigest(ownerId, now, false).needsAttention).toEqual(["*Council* letter 4 needs a reply by *10 Oct*."]);
    expect(collectAttentionForDigest(ownerId, now, true).needsAttention).toHaveLength(2);
  });
});

describe("early briefing absorbs quiet-hours deferrals", () => {
  it("defers to the briefing time when the proactive briefing is between 07:00 and 09:00", async () => {
    vi.setSystemTime(at("2026-10-01T23:30"));
    const ownerId = newUser();
    saveBriefingSettings(ownerId, {
      enabled: true, includeNews: false, topics: [], includeMarkets: false, tickers: [],
      includeWeather: false, weatherLocation: "", proactive: true, sendTime: "07:45",
    });
    await submitAttentionItem(ownerId, {
      source: "email",
      category: "government_mail",
      details: { summary: "*HMRC* needs your tax return by *31 Oct*.", needsAction: true },
      fallbackKey: "msg:1:gov",
    });
    expect(getAttentionItem(ownerId, "msg:1:gov")?.surfaceAt).toBe(at("2026-10-02T07:45").getTime());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/services/attention.test.ts`
Expected: FAIL — cannot find module `./attention.js`.

- [ ] **Step 3: Implement**

Create `server/src/services/attention.ts`:

```ts
// The attention gate: every unprompted message about the user's mail, bookings and bills goes
// through here, so Marlowe behaves like a PA — interrupting only for what can't wait, reminding
// at the moment something matters, and folding everything else into the briefing or digest.
// Decisions live in attentionRules.ts; this file does the storage and sending.
// See docs/superpowers/specs/2026-09-28-attention-gate-design.md.
import {
  getAttentionItem,
  insertAttentionItem,
  updateAttentionItem,
  listAttentionItems,
  countCappedAttentionSentSince,
  listPhoneNumbersForUser,
  type AttentionDetails,
  type AttentionItemRow,
  type AttentionSource,
  type AttentionTier,
} from "../db/store.js";
import { isWhatsAppConfigured } from "../providers/whatsapp.js";
import { sendToAllNumbers } from "./proactiveDelivery.js";
import { getUserTimezone } from "./userTimezone.js";
import { getBriefingSettings } from "./briefing.js";
import { isPostConnectChainInProgress } from "./onboardingAlertSuppression.js";
import { getXeroForwardingEmail } from "./xero.js";
import { setPendingInvoiceForward } from "./xeroInvoiceConfirmation.js";
import { emailReferenceNote } from "./emailReference.js";
import {
  DAILY_CAP,
  CAP_EXEMPT_CATEGORIES,
  QUIET_HOURS_EXEMPT_CATEGORIES,
  tierFor,
  eventKeyFor,
  surfaceAtFor,
  inQuietHours,
  nextAllowedTime,
  localDayStart,
  isConcrete,
  interruptText,
  reminderText,
  ackLine,
  briefLine,
} from "./attentionRules.js";

export interface AttentionCandidate {
  source: AttentionSource;
  category: string;
  details: AttentionDetails;
  fallbackKey: string;
  acknowledged?: boolean;
}

export type SubmitOutcome = "sent" | "scheduled" | "queued" | "merged" | "dropped" | "deferred" | "held" | "failed";

const TIER_RANK: Record<AttentionTier, number> = { drop: 0, brief: 1, scheduled: 2, interrupt: 3 };
const BRIEFING_LOOKAHEAD_MS = 2 * 60 * 60 * 1000;

function definedOnly(details: AttentionDetails): Partial<AttentionDetails> {
  return Object.fromEntries(Object.entries(details).filter(([, v]) => v !== undefined && v !== null && v !== ""));
}

// Email mail is the freshest word on an event, so its fields win; a saved document or a
// reconciliation match only fills gaps (a reconciliation summary is weaker than the email's own).
function mergeDetails(existing: AttentionDetails, incoming: AttentionDetails, source: AttentionSource): AttentionDetails {
  return source === "email"
    ? { ...existing, ...definedOnly(incoming) }
    : { ...definedOnly(incoming), ...definedOnly(existing), summary: existing.summary || incoming.summary };
}

function earlyBriefingTime(ownerId: number): string | null {
  const settings = getBriefingSettings(ownerId);
  return settings.proactive ? settings.sendTime : null;
}

function reachableNumbers(ownerId: number): string[] {
  if (!isWhatsAppConfigured()) return [];
  return listPhoneNumbersForUser(ownerId).map((r) => r.phone);
}

function historyNoteFor(details: AttentionDetails): string | undefined {
  if (details.accountId === undefined || !details.messageId) return undefined;
  return emailReferenceNote({
    accountId: details.accountId,
    id: details.messageId,
    subject: details.emailSubject ?? "",
    from: details.emailFrom ?? "",
  });
}

// Sends one due item now, if the quiet hours and the day's cap allow. Leaves it pending on a send
// failure so the next tick retries it; it only counts against the cap once actually delivered.
async function deliverItem(ownerId: number, item: AttentionItemRow, now: number): Promise<SubmitOutcome> {
  const zone = getUserTimezone(ownerId);
  if (inQuietHours(now, zone) && !QUIET_HOURS_EXEMPT_CATEGORIES.includes(item.category)) {
    updateAttentionItem(ownerId, item.id, { surfaceAt: nextAllowedTime(now, zone, earlyBriefingTime(ownerId)) });
    return "deferred";
  }
  if (
    !CAP_EXEMPT_CATEGORIES.includes(item.category) &&
    countCappedAttentionSentSince(ownerId, localDayStart(now, zone), CAP_EXEMPT_CATEGORIES) >= DAILY_CAP
  ) {
    updateAttentionItem(ownerId, item.id, { status: "held" });
    return "held";
  }

  let text =
    item.tier === "interrupt"
      ? interruptText(item.category, item.details, false)
      : reminderText(item.category, item.details, zone, now);
  if (!isConcrete(text)) {
    updateAttentionItem(ownerId, item.id, { tier: "brief", surfaceAt: null });
    return "queued";
  }
  const offer = item.category === "invoice_due" && item.details.xeroOffer && getXeroForwardingEmail(ownerId);
  if (offer) text += `\n\nReply "yes" and I'll forward it to Xero.`;

  const numbers = reachableNumbers(ownerId);
  if (numbers.length === 0) return "failed";
  const delivered = await sendToAllNumbers(
    ownerId,
    `attention:${item.id}:${item.tier}:${item.surfaceAt ?? 0}`,
    numbers,
    text,
    "alert",
    "attention",
    historyNoteFor(item.details)
  );
  if (!delivered) return "failed";
  updateAttentionItem(ownerId, item.id, { status: "sent", sentAt: now });
  if (offer && item.details.xeroOffer) setPendingInvoiceForward(ownerId, item.details.xeroOffer);
  return "sent";
}

// A change to an event we already know about (a flight moved): one message now, while the row
// itself keeps its reminder, re-timed to the new details.
async function sendChange(ownerId: number, row: AttentionItemRow, category: string, details: AttentionDetails, moved: boolean, now: number): Promise<SubmitOutcome> {
  const zone = getUserTimezone(ownerId);
  if (inQuietHours(now, zone) && !QUIET_HOURS_EXEMPT_CATEGORIES.includes(category)) return "merged";
  const text = interruptText(category, details, moved);
  if (!isConcrete(text)) return "merged";
  const numbers = reachableNumbers(ownerId);
  if (numbers.length === 0) return "failed";
  const delivered = await sendToAllNumbers(
    ownerId,
    `attention:${row.id}:change:${details.summary}`,
    numbers,
    text,
    "alert",
    "attention",
    historyNoteFor(details)
  );
  return delivered ? "sent" : "failed";
}

export async function submitAttentionItem(ownerId: number, candidate: AttentionCandidate): Promise<SubmitOutcome> {
  const now = Date.now();
  const zone = getUserTimezone(ownerId);
  const tier = tierFor(candidate.category, candidate.details, now, zone);
  const eventKey = eventKeyFor(candidate.details, candidate.fallbackKey);
  const existing = getAttentionItem(ownerId, eventKey);

  if (existing) {
    const details = mergeDetails(existing.details, candidate.details, candidate.source);
    const reschedule = existing.tier === "scheduled" && existing.status === "pending";
    const newSurface = reschedule ? surfaceAtFor(existing.category, details, zone) : existing.surfaceAt;
    const moved = reschedule && newSurface !== null && newSurface !== existing.surfaceAt;
    const patch: Parameters<typeof updateAttentionItem>[2] = { details };
    if (reschedule && newSurface !== null) patch.surfaceAt = Math.max(newSurface, now);
    if (existing.status === "dropped" && TIER_RANK[tier] > TIER_RANK.drop && tier !== "interrupt") {
      patch.tier = tier;
      patch.status = "pending";
      patch.surfaceAt = tier === "scheduled" ? Math.max(surfaceAtFor(candidate.category, details, zone) ?? now, now) : null;
    }
    const updated = updateAttentionItem(ownerId, existing.id, patch);
    // Same event, same category, already handled: a repeat, not news.
    if (tier !== "interrupt" || candidate.category === existing.category) return "merged";
    return sendChange(ownerId, updated, candidate.category, candidate.details, moved, now);
  }

  if (tier === "drop") {
    insertAttentionItem(ownerId, { eventKey, source: candidate.source, category: candidate.category, tier, status: "dropped", details: candidate.details, surfaceAt: null });
    return "dropped";
  }
  if (tier === "brief") {
    insertAttentionItem(ownerId, { eventKey, source: candidate.source, category: candidate.category, tier, status: "pending", details: candidate.details, surfaceAt: null });
    return "queued";
  }
  if (tier === "scheduled") {
    const surfaceAt = surfaceAtFor(candidate.category, candidate.details, zone);
    insertAttentionItem(ownerId, {
      eventKey,
      source: candidate.source,
      category: candidate.category,
      tier: surfaceAt === null ? "brief" : "scheduled",
      status: "pending",
      details: candidate.details,
      surfaceAt: surfaceAt === null ? null : Math.max(surfaceAt, now),
      acknowledgedAt: candidate.acknowledged ? now : null,
    });
    return surfaceAt === null ? "queued" : "scheduled";
  }
  const row = insertAttentionItem(ownerId, {
    eventKey,
    source: candidate.source,
    category: candidate.category,
    tier,
    status: "pending",
    details: candidate.details,
    surfaceAt: now,
    acknowledgedAt: now,
  });
  if (isPostConnectChainInProgress(ownerId)) return "deferred";
  return deliverItem(ownerId, row, now);
}

export async function deliverDueAttentionItems(ownerId: number): Promise<void> {
  if (isPostConnectChainInProgress(ownerId)) return;
  const now = Date.now();
  const due = listAttentionItems(ownerId, { statuses: ["pending"], dueBefore: now }).filter(
    (r) => r.tier === "interrupt" || r.tier === "scheduled"
  );
  for (const item of due) await deliverItem(ownerId, item, now);
}

export interface AttentionBundle {
  noted: string[];
  needsAttention: string[];
  upcoming: string[];
  ackIds: number[];
  foldIds: number[];
}

export function isEmptyBundle(b: AttentionBundle): boolean {
  return b.noted.length === 0 && b.needsAttention.length === 0 && b.upcoming.length === 0;
}

function emptyBundle(): AttentionBundle {
  return { noted: [], needsAttention: [], upcoming: [], ackIds: [], foldIds: [] };
}

function collect(ownerId: number, now: number, opts: { acks: boolean; brief: boolean; upcoming: boolean }): AttentionBundle {
  const zone = getUserTimezone(ownerId);
  const bundle = emptyBundle();
  for (const item of listAttentionItems(ownerId, { statuses: ["pending", "held"] })) {
    if (item.status === "held") {
      bundle.needsAttention.push(briefLine(item.details));
      bundle.foldIds.push(item.id);
      continue;
    }
    if (item.tier === "brief" && opts.brief) {
      bundle.needsAttention.push(briefLine(item.details));
      bundle.foldIds.push(item.id);
      continue;
    }
    if (item.tier !== "scheduled" || item.surfaceAt === null) continue;
    if (opts.upcoming && item.surfaceAt <= now + BRIEFING_LOOKAHEAD_MS) {
      bundle.upcoming.push(reminderText(item.category, item.details, zone, now));
      bundle.foldIds.push(item.id);
      if (item.acknowledgedAt === null) bundle.ackIds.push(item.id);
      continue;
    }
    if (opts.acks && item.acknowledgedAt === null) {
      bundle.noted.push(ackLine(item.details, item.surfaceAt, zone, now));
      bundle.ackIds.push(item.id);
    }
  }
  return bundle;
}

export function collectAttentionForBriefing(ownerId: number, now: number): AttentionBundle {
  return collect(ownerId, now, { acks: true, brief: true, upcoming: true });
}

// Held (over-cap) items always ride the digest; acks and brief items only when there's no
// proactive morning briefing to carry them.
export function collectAttentionForDigest(ownerId: number, now: number, includeBriefItems: boolean): AttentionBundle {
  return collect(ownerId, now, { acks: includeBriefItems, brief: includeBriefItems, upcoming: false });
}

// Call only once the briefing/digest carrying `bundle` was actually delivered.
export function commitAttentionBundle(ownerId: number, bundle: AttentionBundle, now: number): void {
  for (const id of bundle.ackIds) updateAttentionItem(ownerId, id, { acknowledgedAt: now });
  for (const id of bundle.foldIds) updateAttentionItem(ownerId, id, { status: "folded" });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/services/attention.test.ts`
Expected: PASS. If the "holds the 5th" test sends 5 instead of 4, check that `countCappedAttentionSentSince` receives `localDayStart(now, zone)` and that `deliverItem` marks `sentAt` before the next submit.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/attention.ts server/src/services/attention.test.ts
git commit -m "feat: attention gate — submit, deliver-due, cap, quiet hours, briefing/digest bundles"
```

---

### Task 4: Classifier `needs_action` + email enrichment

**Files:**
- Modify: `server/src/services/importantEmailClassifier.ts`
- Create: `server/src/services/importantEmailEnrichment.ts`
- Test: `server/src/services/importantEmailClassifier.test.ts` (modify), `server/src/services/importantEmailEnrichment.test.ts` (create)

**Interfaces:**
- Produces:
  ```ts
  // importantEmailClassifier.ts
  export interface ClassifyMatch { category: ImportantEmailCategory; summary: string; needsAction: boolean }
  // importantEmailEnrichment.ts
  export interface EnrichmentInput { category: string; subject: string; from: string; body: string; receivedAt: string; zone: string | null }
  export interface EnrichmentResult {
    summary: string; kind?: "flight" | "hotel" | "restaurant" | "other"; eventStart?: string; dueDate?: string;
    reference?: string; flightNumber?: string; merchant?: string; amount?: string; needsAction?: boolean;
  }
  export function buildEnrichmentPrompt(input: EnrichmentInput): string;
  export function parseEnrichment(raw: unknown): EnrichmentResult | null;
  export async function enrichImportantEmail(input: EnrichmentInput, ownerId: number): Promise<EnrichmentResult | null>;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `server/src/services/importantEmailClassifier.test.ts` (it already imports `parseClassifyMatches` and `buildClassifyPrompt`; add them to the import if missing):

```ts
describe("needs_action", () => {
  it("parses needs_action, defaulting to false", () => {
    const parsed = parseClassifyMatches([
      { index: 0, category: "delivery_notification", summary: "x", needs_action: true },
      { index: 1, category: "delivery_notification", summary: "y" },
    ]);
    expect(parsed.get(0)?.needsAction).toBe(true);
    expect(parsed.get(1)?.needsAction).toBe(false);
  });

  it("asks the model whether the user must do something", () => {
    expect(buildClassifyPrompt([{ index: 0, subject: "s", snippet: "t" }])).toMatch(/needs_action/);
  });
});
```

Create `server/src/services/importantEmailEnrichment.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildEnrichmentPrompt, parseEnrichment } from "./importantEmailEnrichment.js";

describe("buildEnrichmentPrompt", () => {
  it("includes the category, the user's timezone and a trimmed body", () => {
    const prompt = buildEnrichmentPrompt({
      category: "reservation_confirmed",
      subject: "Your booking",
      from: "Hilton <no-reply@hilton.com>",
      body: "x".repeat(10_000),
      receivedAt: "2026-10-01T10:00:00Z",
      zone: "Europe/London",
    });
    expect(prompt).toContain("reservation_confirmed");
    expect(prompt).toContain("Europe/London");
    expect(prompt.length).toBeLessThan(8_000);
  });
});

describe("parseEnrichment", () => {
  it("keeps valid fields and drops malformed ones", () => {
    expect(
      parseEnrichment({
        summary: "Your *Hilton Lisbon* stay, *12–15 Oct*.",
        kind: "hotel",
        event_start: "2026-10-12",
        due_date: "not a date",
        reference: "HLT12345",
        flight_number: "",
        merchant: "Hilton",
        amount: "£420",
        needs_action: false,
      })
    ).toEqual({
      summary: "Your *Hilton Lisbon* stay, *12–15 Oct*.",
      kind: "hotel",
      eventStart: "2026-10-12",
      reference: "HLT12345",
      merchant: "Hilton",
      amount: "£420",
      needsAction: false,
    });
  });

  it("accepts a full ISO date-time with offset", () => {
    expect(parseEnrichment({ summary: "s *x*", event_start: "2026-10-03T08:40:00+01:00" })?.eventStart).toBe(
      "2026-10-03T08:40:00+01:00"
    );
  });

  it("returns null without a summary", () => {
    expect(parseEnrichment({ kind: "hotel" })).toBeNull();
    expect(parseEnrichment(null)).toBeNull();
  });

  it("drops an unknown kind", () => {
    expect(parseEnrichment({ summary: "s", kind: "boat" })?.kind).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/services/importantEmailClassifier.test.ts src/services/importantEmailEnrichment.test.ts`
Expected: FAIL — `needsAction` undefined; module `./importantEmailEnrichment.js` missing.

- [ ] **Step 3: Implement**

In `importantEmailClassifier.ts`:

1. Change `ClassifyMatch` to add `needsAction: boolean;` (with the comment `// True when the user must do something: pay, reply, reschedule, collect, respond by a deadline.`).
2. In `buildClassifyPrompt`, before the final `\n\n${emailList}`, add to the instructions string:
   ```ts
   " Also set needs_action: true only when the user must do something themselves (pay, reply, " +
   "reschedule, collect a parcel, respond by a deadline); false for confirmations, receipts and " +
   "routine status updates."
   ```
3. In `parseClassifyMatches`, set `needsAction: (entry as { needs_action?: unknown }).needs_action === true,` in the `result.set(...)` object.
4. In `CLASSIFY_TOOL.input_schema.properties.matches.items.properties`, add:
   ```ts
   needs_action: { type: "boolean", description: "Whether the user must do something themselves." },
   ```

Create `server/src/services/importantEmailEnrichment.ts`:

```ts
// One small model call per flagged email (never per email): reads the full body so the attention
// gate can schedule reminders from real dates, times, references and amounts rather than a
// truncated preview. See docs/superpowers/specs/2026-09-28-attention-gate-design.md.
import Anthropic from "@anthropic-ai/sdk";
import { recordApiUsage } from "../db/store.js";
import { tidySnippet } from "./htmlToText.js";

export interface EnrichmentInput {
  category: string;
  subject: string;
  from: string;
  body: string;
  receivedAt: string;
  zone: string | null;
}

export interface EnrichmentResult {
  summary: string;
  kind?: "flight" | "hotel" | "restaurant" | "other";
  eventStart?: string;
  dueDate?: string;
  reference?: string;
  flightNumber?: string;
  merchant?: string;
  amount?: string;
  needsAction?: boolean;
}

const MAX_BODY_CHARS = 6_000;
const KINDS = ["flight", "hotel", "restaurant", "other"] as const;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2}|Z)?$/;

export function buildEnrichmentPrompt(input: EnrichmentInput): string {
  const body = tidySnippet(input.body, MAX_BODY_CHARS);
  return (
    `This email was flagged as "${input.category}". The user's timezone is ${input.zone ?? "unknown"}; ` +
    `the email arrived ${input.receivedAt}.\n\n` +
    "Extract the concrete facts. summary: one sentence addressed to the user, starting with 'Your' " +
    "where it fits, with every specific (name, flight/reference number, amount, date, time, place) in " +
    "WhatsApp bold (*text*). event_start: when the booked thing starts — 'YYYY-MM-DDTHH:MM:SS+HH:MM' " +
    "if the email states a time (use the offset of the place it happens), else 'YYYY-MM-DD'. due_date: " +
    "'YYYY-MM-DD' a bill is due or a subscription charges. kind: flight, hotel, restaurant or other, " +
    "for bookings only. needs_action: true only if the user must do something themselves. Leave out " +
    "anything the email doesn't state — never guess a date.\n\n" +
    `From: ${input.from}\nSubject: ${input.subject}\n\n${body}`
  );
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function parseEnrichment(raw: unknown): EnrichmentResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const summary = str(r.summary);
  if (!summary) return null;
  const result: EnrichmentResult = { summary };
  const kind = str(r.kind);
  if (kind && (KINDS as readonly string[]).includes(kind)) result.kind = kind as EnrichmentResult["kind"];
  const eventStart = str(r.event_start);
  if (eventStart && (DATE_ONLY.test(eventStart) || DATE_TIME.test(eventStart))) result.eventStart = eventStart;
  const dueDate = str(r.due_date);
  if (dueDate && DATE_ONLY.test(dueDate)) result.dueDate = dueDate;
  for (const [from, to] of [
    ["reference", "reference"],
    ["flight_number", "flightNumber"],
    ["merchant", "merchant"],
    ["amount", "amount"],
  ] as const) {
    const value = str(r[from]);
    if (value) result[to] = value;
  }
  if (typeof r.needs_action === "boolean") result.needsAction = r.needs_action;
  return result;
}

const ENRICH_MODEL = process.env.ASSISTANT_MODEL_SIMPLE ?? "claude-haiku-4-5";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

const ENRICH_TOOL: Anthropic.Tool = {
  name: "record_email_facts",
  description: "Record the concrete facts stated in the email. Omit any field the email doesn't state.",
  input_schema: {
    type: "object",
    properties: {
      summary: { type: "string" },
      kind: { type: "string", enum: [...KINDS] },
      event_start: { type: "string" },
      due_date: { type: "string" },
      reference: { type: "string" },
      flight_number: { type: "string" },
      merchant: { type: "string" },
      amount: { type: "string" },
      needs_action: { type: "boolean" },
    },
    required: ["summary"],
  },
};

// Not unit-tested directly — same as importantEmailClassifier.ts, this repo doesn't mock the
// Anthropic SDK. The prompt builder and parser above are.
export async function enrichImportantEmail(input: EnrichmentInput, ownerId: number): Promise<EnrichmentResult | null> {
  const response = await getClient().messages.create({
    model: ENRICH_MODEL,
    max_tokens: 1024,
    tools: [ENRICH_TOOL],
    tool_choice: { type: "tool", name: "record_email_facts" },
    messages: [{ role: "user", content: buildEnrichmentPrompt(input) }],
  });
  recordApiUsage(
    ownerId,
    "background",
    ENRICH_MODEL,
    "important_email_enrichment",
    response.usage?.input_tokens ?? 0,
    response.usage?.output_tokens ?? 0,
    response.usage?.cache_read_input_tokens ?? 0,
    response.usage?.cache_creation_input_tokens ?? 0
  );
  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "record_email_facts"
  );
  return parseEnrichment(toolUse?.input);
}
```

Check `tidySnippet`'s signature in `htmlToText.ts` accepts a max length as its second argument (it is called as `tidySnippet(c.snippet, 400)` in `realPersonTriage.ts`), so this usage is valid.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/services/importantEmailClassifier.test.ts src/services/importantEmailEnrichment.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/services/importantEmailClassifier.ts server/src/services/importantEmailClassifier.test.ts server/src/services/importantEmailEnrichment.ts server/src/services/importantEmailEnrichment.test.ts
git commit -m "feat: classifier flags needs_action; enrichment reads dates and refs from the full email"
```

---

### Task 5: Important-email scan submits to the gate

**Files:**
- Modify: `server/src/services/importantEmailAlerts.ts`
- Test: `server/src/services/importantEmailAlerts.test.ts`

**Interfaces:**
- Consumes: `submitAttentionItem` (Task 3), `enrichImportantEmail` (Task 4), `ClassifyMatch.needsAction` (Task 4).
- Produces: `checkForImportantEmails(ownerId)` — unchanged signature; no longer sends directly. `formatImportantEmailAlert` is removed.

- [ ] **Step 1: Update the tests first**

In `importantEmailAlerts.test.ts`:

1. Add an enrichment mock after the classifier mock:
   ```ts
   const mockEnrich = vi.fn();
   vi.mock("./importantEmailEnrichment.js", () => ({
     enrichImportantEmail: (...args: unknown[]) => mockEnrich(...args),
   }));
   ```
   In `beforeEach`, add `mockEnrich.mockReset().mockResolvedValue(null);` and make `mockHubGetMessage` default to `mockResolvedValue({ body: "email body" })`.
2. Add `getAttentionItem` to the store import list and `setUserTimezone` from `./userTimezone.js`; in `registerActivePhone`, call `setUserTimezone(ownerId, "Europe/London")`. Pin the clock outside quiet hours so interrupts send: in `beforeEach` add `vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-01T11:00:00Z"));` and add `afterEach(() => vi.useRealTimers());` (import `afterEach`). Tests that rely on "the last 24 hours" of mail build `receivedAt` from `new Date()`, which follows the fake clock, so they are unaffected.
3. Delete these tests (their behaviour is removed by design): `"caps alerts per tick and sends a summary for the overflow"`, the whole `describe("formatImportantEmailAlert", …)` block, `"greets the user by their saved name when one is set"`, `"holds the mail checkpoint when an alert fails to deliver"`, `"leaves a matched message unmarked (retriable) when delivery fails"`, `"on retry after a partial failure, only resends to the number that missed it"`, `"does not store an entity when delivery fails"`. Remove `formatImportantEmailAlert` from the dynamic import.
4. Replace `"sends a WhatsApp alert for a classified match, formatted with the category"` with:
   ```ts
   it("interrupts at once for a flight change, using the enriched summary", async () => {
     const user = findOrCreateUserByEmail(uniqueEmail("ie-flight"));
     registerActivePhone(user.id);
     await baseline(user.id);
     mockHubListNewMessages.mockResolvedValueOnce([fakeMessage({ id: "f1", subject: "Schedule change" })]);
     mockClassify.mockResolvedValueOnce(new Map([[0, { category: "flight_change", summary: "Flight changed", needsAction: false }]]));
     mockEnrich.mockResolvedValueOnce({ summary: "Your *BA 432* now leaves *09:55*.", flightNumber: "BA432", eventStart: "2026-10-03T09:55:00+01:00" });

     await checkForImportantEmails(user.id);

     expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
     expect(vi.mocked(sendWhatsAppMessage).mock.calls[0][1]).toBe("✈️ Your *BA 432* now leaves *09:55*.");
     expect(hasAlerted(user.id, "important-email:1:f1")).toBe(true);
   });

   it("stays silent for a booking confirmation and schedules a reminder instead", async () => {
     const user = findOrCreateUserByEmail(uniqueEmail("ie-booking"));
     registerActivePhone(user.id);
     await baseline(user.id);
     mockHubListNewMessages.mockResolvedValueOnce([fakeMessage({ id: "h1", subject: "Booking confirmed" })]);
     mockClassify.mockResolvedValueOnce(new Map([[0, { category: "reservation_confirmed", summary: "Booked", needsAction: false }]]));
     mockEnrich.mockResolvedValueOnce({ summary: "Your *Hilton Lisbon* stay, *12–15 Dec*.", kind: "hotel", eventStart: "2099-12-12", reference: "HLT999" });

     await checkForImportantEmails(user.id);

     expect(sendWhatsAppMessage).not.toHaveBeenCalled();
     expect(getAttentionItem(user.id, "ref:HLT999")?.tier).toBe("scheduled");
     expect(hasAlerted(user.id, "important-email:1:h1")).toBe(true);
   });

   it("drops routine delivery updates without enriching them", async () => {
     const user = findOrCreateUserByEmail(uniqueEmail("ie-delivery"));
     registerActivePhone(user.id);
     await baseline(user.id);
     mockHubListNewMessages.mockResolvedValueOnce([fakeMessage({ id: "d1", subject: "Out for delivery" })]);
     mockClassify.mockResolvedValueOnce(new Map([[0, { category: "delivery_notification", summary: "Out for delivery", needsAction: false }]]));

     await checkForImportantEmails(user.id);

     expect(mockEnrich).not.toHaveBeenCalled();
     expect(sendWhatsAppMessage).not.toHaveBeenCalled();
   });

   it("falls back to the classifier's summary when enrichment fails", async () => {
     const user = findOrCreateUserByEmail(uniqueEmail("ie-enrich-fail"));
     registerActivePhone(user.id);
     await baseline(user.id);
     mockHubListNewMessages.mockResolvedValueOnce([fakeMessage({ id: "s1", subject: "New sign-in" })]);
     mockClassify.mockResolvedValueOnce(new Map([[0, { category: "security_alert", summary: "New sign-in to your *Google* account.", needsAction: false }]]));
     mockEnrich.mockRejectedValueOnce(new Error("boom"));

     await checkForImportantEmails(user.id);

     expect(vi.mocked(sendWhatsAppMessage).mock.calls[0][1]).toBe("🔐 New sign-in to your *Google* account.");
   });
   ```
5. In the invoice-offer `describe`, update each test's classifier result to include `needsAction: true` and set `mockEnrich` to return `{ summary: "Your *Acme* invoice for *£120* is due.", needsAction: true }` (no `dueDate`, so the tier is `interrupt` and it sends immediately). The assertions about `Reply "yes"` and `getPendingInvoiceForward` stay. Replace `"only offers the CTA once per tick even with multiple invoice_due matches"` with a test asserting both invoices are sent and `getPendingInvoiceForward(user.id)?.messageId` equals the **second** message's id (the single pending slot holds the latest offer).
6. Wherever an existing test asserts text contains the old `formatImportantEmailAlert` output (emoji + greeting), change the classifier mock to include `needsAction` and assert the `interruptText` form (`"<emoji> <summary>"`, no greeting).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/services/importantEmailAlerts.test.ts`
Expected: FAIL — booking still sends an alert, enrichment never called.

- [ ] **Step 3: Implement**

In `importantEmailAlerts.ts`:

1. Remove imports: `createHash`, `sendToAllNumbers`, `setPendingInvoiceForward`, `getXeroForwardingEmail`, `emailReferenceNote`, `tidySnippet` stays (used below). Add:
   ```ts
   import { submitAttentionItem } from "./attention.js";
   import { enrichImportantEmail } from "./importantEmailEnrichment.js";
   import { getUserTimezone } from "./userTimezone.js";
   import type { AttentionDetails } from "../db/store.js";
   ```
2. Delete `MAX_ALERTS_PER_CHECK`, `formatImportantEmailAlert`, and `notifyAll`.
3. Replace everything in `checkForImportantEmails` from `const matches = unscanned` to the end of the function with:

```ts
  const matches = unscanned
    .map((m, index) => ({ m, match: classified.get(index) }))
    .filter((x): x is { m: UnifiedMessage; match: ClassifyMatch } => !!x.match);

  // Every match is handed to the attention gate (attention.ts), which decides whether it interrupts
  // now, becomes a timed reminder, waits for the briefing, or is dropped as routine — and retries
  // its own failed sends, so a match is fully handled once submitted.
  for (const { m, match } of matches) {
    const details = await detailsFor(ownerId, m, match);
    await submitAttentionItem(ownerId, {
      source: "email",
      category: match.category,
      details,
      fallbackKey: `msg:${m.accountId}:${m.id}`,
    });
    markAlerted(ownerId, messageKey(m));
    saveFlaggedEmail(ownerId, m, { ...match, summary: details.summary });
  }
}

// Routine delivery progress is dropped by the gate anyway, so it isn't worth a body fetch or an
// enrichment call; everything else gets both so reminders use the email's real dates.
async function detailsFor(ownerId: number, m: UnifiedMessage, match: ClassifyMatch): Promise<AttentionDetails> {
  const base: AttentionDetails = {
    summary: match.summary?.trim() || tidySnippet(m.snippet),
    needsAction: match.needsAction,
    accountId: m.accountId,
    messageId: m.id,
    emailSubject: m.subject,
    emailFrom: m.from,
  };
  if (match.category === "delivery_notification" && !match.needsAction) return base;

  const full = await hubGetMessage(ownerId, m.accountId, m.id).catch(() => null);
  const enriched = full?.body?.trim()
    ? await enrichImportantEmail(
        {
          category: match.category,
          subject: m.subject,
          from: m.from,
          body: full.body,
          receivedAt: m.receivedAt,
          zone: getUserTimezone(ownerId),
        },
        ownerId
      ).catch((err) => {
        console.error(`importantEmailAlerts: enrichment failed for owner ${ownerId}`, err);
        return null;
      })
    : null;
  const details: AttentionDetails = { ...base, ...(enriched ?? {}), summary: enriched?.summary || base.summary };
  if (enriched?.needsAction === undefined) details.needsAction = base.needsAction;
  if (match.category === "invoice_due" && (full?.attachments?.length || full?.body?.trim())) {
    details.xeroOffer = { accountId: m.accountId, messageId: m.id, subject: m.subject };
  }
  return details;
}
```

4. Update the file-header "Known overlap" comment on `checkForImportantEmails` to: `// Dedupe with reconciliation.ts and tripPrep.ts happens in the attention gate by event_key.`

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/services/importantEmailAlerts.test.ts src/services/attention.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/services/importantEmailAlerts.ts server/src/services/importantEmailAlerts.test.ts
git commit -m "feat: important-email scan hands matches to the attention gate instead of pinging"
```

---

### Task 6: Reconciliation submits to the gate

**Files:**
- Modify: `server/src/services/reconciliation.ts`
- Test: `server/src/services/reconciliation.test.ts`

**Interfaces:**
- Consumes: `submitAttentionItem` (Task 3).
- Produces: `checkNewEmailsAgainstRecentDocuments(ownerId)` — unchanged signature, never sends. `buildMatchNotification` and `EmailDocumentMatch` are removed; `matchTier` and `MatchKeys` stay.

- [ ] **Step 1: Update the tests first**

In `reconciliation.test.ts`:

1. Change the `./hub.js` mock to spread the real module so `attention.ts`'s transitive imports resolve:
   ```ts
   vi.mock("./hub.js", async (importOriginal) => {
     const actual = await importOriginal<typeof import("./hub.js")>();
     return {
       ...actual,
       hubListMessages: (...args: unknown[]) => mockHubListMessages(...args),
       hubListNewMessages: (...args: unknown[]) => mockHubListNewMessages(...args),
       holdNewMessageCheckpoint: (...args: unknown[]) => mockHoldCheckpoint(...args),
     };
   });
   ```
2. Remove `buildMatchNotification` and `takeSuppressedOnboardingAlertCount` imports; add `getAttentionItem, listAttentionItems` to the store import.
3. Delete the whole `describe("buildMatchNotification", …)` block and these tests: `"sends one message for several matching emails…"`, `"lists at most five emails in one message…"`, `"leaves matched emails unscanned and holds the mail checkpoint when delivery fails…"`, `"records but does not send while onboarding is still in progress"`, `"leaves everything unscanned (without holding the checkpoint) when WhatsApp isn't configured"`, `"does not notify twice for the same email across ticks"`.
4. Replace `"notifies when a new email's subject contains a recent document's reference code, naming the email"` with:
   ```ts
   it("records a matching email against the document's event, without messaging", async () => {
     // (reuse this file's existing setup helper that saves a document with referenceCode "ABC12345";
     //  keep its user/phone creation lines exactly as the old test had them)
     mockHubListNewMessages.mockResolvedValueOnce([fakeEmail({ id: "e1", subject: "Update on booking ABC12345" })]);

     await checkNewEmailsAgainstRecentDocuments(user.id);

     expect(sendWhatsAppMessage).not.toHaveBeenCalled();
     const row = getAttentionItem(user.id, "ref:ABC12345");
     expect(row?.category).toBe("document_match");
     expect(row?.details.summary).toContain("Update on booking ABC12345");
   });

   it("merges into an existing item for the same booking instead of adding one", async () => {
     // same setup as above, then:
     await submitAttentionItem(user.id, {
       source: "email",
       category: "reservation_confirmed",
       details: { summary: "Your *Hotel Eva* stay, ref *ABC12345*.", kind: "hotel", eventStart: "2099-01-01", reference: "ABC12345" },
       fallbackKey: "msg:1:orig",
     });
     mockHubListNewMessages.mockResolvedValueOnce([fakeEmail({ id: "e2", subject: "ABC12345 — see you soon" })]);

     await checkNewEmailsAgainstRecentDocuments(user.id);

     expect(listAttentionItems(user.id)).toHaveLength(1);
     expect(getAttentionItem(user.id, "ref:ABC12345")?.details.summary).toContain("Hotel Eva");
   });
   ```
   Import `submitAttentionItem` from `./attention.js` in the dynamic imports. Use the file's existing names for the fake-email builder and document-seeding helper (read the top ~95 lines of the file and reuse them; rename `fakeEmail` above to whatever the file uses).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/services/reconciliation.test.ts`
Expected: FAIL — a WhatsApp message is still sent / no attention row exists.

- [ ] **Step 3: Implement**

Rewrite the body of `reconciliation.ts` after `matchTier` as:

```ts
const RECENT_DOCUMENT_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

function scanKey(m: UnifiedMessage): string {
  return `recon-scan:${m.accountId}:${m.id}`;
}

// Runs on the scheduler tick. A match is handed to the attention gate as a "document_match": if the
// gate already knows this booking (from its confirmation email or the saved document) it merges
// silently; otherwise it's one line in the next briefing/digest. Never messages on its own.
export async function checkNewEmailsAgainstRecentDocuments(ownerId: number): Promise<void> {
  const recentKeys = listRecentMatchKeys(ownerId, Date.now() - RECENT_DOCUMENT_WINDOW_MS);
  if (recentKeys.length === 0) return;

  let messages: UnifiedMessage[];
  try {
    messages = await hubListNewMessages(ownerId);
  } catch (err) {
    console.error(`reconciliation: failed to list messages for owner ${ownerId}`, err);
    return;
  }

  for (const m of messages) {
    if (hasAlerted(ownerId, scanKey(m))) continue;
    const text = `${m.subject} ${m.snippet}`;
    const row = recentKeys.find(
      (r) =>
        matchTier({ referenceCode: r.referenceCode ?? undefined, flightNumber: r.flightNumber ?? undefined }, text) ===
        "strong"
    );
    if (row) {
      await submitAttentionItem(ownerId, {
        source: "reconciliation",
        category: "document_match",
        details: {
          summary: `*${row.docTitle ?? "A saved document"}* — new email: "${m.subject}"`,
          reference: row.referenceCode ?? undefined,
          flightNumber: row.flightNumber ?? undefined,
          eventStart: row.eventDate ?? undefined,
          accountId: m.accountId,
          messageId: m.id,
          emailSubject: m.subject,
          emailFrom: m.from,
        },
        fallbackKey: `msg:${m.accountId}:${m.id}`,
      });
    }
    markAlerted(ownerId, scanKey(m));
  }
}
```

Imports become:

```ts
import { hubListNewMessages } from "./hub.js";
import { hasAlerted, markAlerted, listRecentMatchKeys } from "../db/store.js";
import { submitAttentionItem } from "./attention.js";
import type { UnifiedMessage } from "../providers/types.js";
```

Delete `MAX_LISTED_MATCHES`, `identifierPart`, `EmailDocumentMatch`, `buildMatchNotification`. Replace the file-header paragraph about alert spam with one line: `// Matches go to the attention gate (attention.ts) — see the 2026-09-28 attention-gate spec.` (keep the 2026-08-24 design-doc reference and the removed-second-check history paragraph).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/services/reconciliation.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/services/reconciliation.ts server/src/services/reconciliation.test.ts
git commit -m "feat: document-match emails merge into the attention gate instead of pinging"
```

---

### Task 7: Trip prep becomes booking reminders

**Files:**
- Modify: `server/src/services/tripPrep.ts`
- Test: `server/src/services/tripPrep.test.ts` (rewrite)

**Interfaces:**
- Consumes: `submitAttentionItem` (Task 3); `listEntities`, `updateEntity` (store); `userLocalClock` (`./userTimezone.js`).
- Produces: `export async function syncBookingReminders(ownerId: number): Promise<void>`; `export function flightNumberFrom(name: string): string | null`; `export function bookingSummary(data: BookingData): string`. `checkTripPrepNudges` and `isTripPrepDue` are removed.

- [ ] **Step 1: Write the failing test**

Replace `server/src/services/tripPrep.test.ts` entirely with:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../providers/whatsapp.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../providers/whatsapp.js")>();
  return {
    ...actual,
    sendWhatsAppMessage: vi.fn(),
    sendWhatsAppTemplate: vi.fn(),
    isWhatsAppConfigured: vi.fn().mockReturnValue(true),
  };
});

const { sendWhatsAppMessage } = await import("../providers/whatsapp.js");
const { findOrCreateUserByEmail, addPhoneNumberForUser, recordInboundMessage, saveEntity, getEntity, getAttentionItem, listAttentionItems } =
  await import("../db/store.js");
const { setUserTimezone } = await import("./userTimezone.js");
const { syncBookingReminders, flightNumberFrom, bookingSummary } = await import("./tripPrep.js");
const { submitAttentionItem } = await import("./attention.js");
const { DateTime } = await import("luxon");
import type { BookingData } from "./entityValidation.js";

const ZONE = "Europe/London";
const at = (iso: string) => DateTime.fromISO(iso, { zone: ZONE }).toJSDate();

let counter = 0;
// Keeps this file's historical prefix "447000070".
function newUser() {
  counter += 1;
  const user = findOrCreateUserByEmail(`trip-prep-${Date.now()}-${counter}@example.com`);
  const phone = `447000070${String(counter).padStart(3, "0")}`;
  addPhoneNumberForUser(user.id, phone);
  recordInboundMessage(phone);
  setUserTimezone(user.id, ZONE);
  return user.id;
}

function booking(overrides: Partial<BookingData>): BookingData {
  return { kind: "flight", name: "FR1234 LIS→FAO", reference: null, startDate: "2026-10-05", endDate: null, ...overrides };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at("2026-10-01T12:00"));
  vi.mocked(sendWhatsAppMessage).mockReset().mockResolvedValue("wamid");
});

afterEach(() => vi.useRealTimers());

describe("flightNumberFrom", () => {
  it("pulls the flight number out of a booking name", () => {
    expect(flightNumberFrom("FR1234 LIS→FAO")).toBe("FR1234");
    expect(flightNumberFrom("BA 432 to Lisbon")).toBe("BA432");
    expect(flightNumberFrom("Hotel Eva, Faro")).toBeNull();
  });
});

describe("bookingSummary", () => {
  it("bolds the name, date and reference", () => {
    expect(bookingSummary(booking({ reference: "X7KQ2P" }))).toBe("Your flight *FR1234 LIS→FAO* on *5 Oct*, ref *X7KQ2P*.");
    expect(bookingSummary(booking({ kind: "hotel", name: "Hotel Eva, Faro", startDate: "2026-10-12", endDate: "2026-10-15" }))).toBe(
      "Your stay at *Hotel Eva, Faro* from *12 Oct* to *15 Oct*."
    );
  });
});

describe("syncBookingReminders", () => {
  it("turns a future booking into a silent, already-acknowledged reminder", async () => {
    const ownerId = newUser();
    const entity = saveEntity<BookingData>(ownerId, { type: "booking", data: booking({}) });

    await syncBookingReminders(ownerId);

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    const row = getAttentionItem(ownerId, "flight:FR1234:2026-10-05");
    expect(row?.tier).toBe("scheduled");
    expect(row?.acknowledgedAt).not.toBeNull();
    expect(row?.surfaceAt).toBe(at("2026-10-04T09:00").getTime());
    expect(getEntity<BookingData>(ownerId, entity.id)?.data.tripPrepNotifiedAt).toBeTypeOf("number");
  });

  it("is idempotent across ticks", async () => {
    const ownerId = newUser();
    saveEntity<BookingData>(ownerId, { type: "booking", data: booking({}) });
    await syncBookingReminders(ownerId);
    await syncBookingReminders(ownerId);
    expect(listAttentionItems(ownerId)).toHaveLength(1);
  });

  it("merges with the same booking already learned from email", async () => {
    const ownerId = newUser();
    await submitAttentionItem(ownerId, {
      source: "email",
      category: "reservation_confirmed",
      details: { summary: "Your *Hotel Eva* stay, ref *EVA12345*.", kind: "hotel", eventStart: "2026-10-12", reference: "EVA12345" },
      fallbackKey: "msg:1:eva",
    });
    saveEntity<BookingData>(ownerId, {
      type: "booking",
      data: booking({ kind: "hotel", name: "Hotel Eva, Faro", reference: "EVA12345", startDate: "2026-10-12" }),
    });

    await syncBookingReminders(ownerId);

    expect(listAttentionItems(ownerId)).toHaveLength(1);
    expect(getAttentionItem(ownerId, "ref:EVA12345")?.details.summary).toBe("Your *Hotel Eva* stay, ref *EVA12345*.");
  });

  it("ignores bookings in the past, using the user's own date", async () => {
    const ownerId = newUser();
    saveEntity<BookingData>(ownerId, { type: "booking", data: booking({ startDate: "2026-09-30" }) });
    await syncBookingReminders(ownerId);
    expect(listAttentionItems(ownerId)).toHaveLength(0);
  });

  it("sends the reminder when it falls due", async () => {
    const ownerId = newUser();
    saveEntity<BookingData>(ownerId, { type: "booking", data: booking({ reference: "X7KQ2P" }) });
    await syncBookingReminders(ownerId);
    vi.setSystemTime(at("2026-10-04T09:05"));
    const { deliverDueAttentionItems } = await import("./attention.js");
    await deliverDueAttentionItems(ownerId);
    expect(vi.mocked(sendWhatsAppMessage).mock.calls[0][1]).toBe(
      "✈️ Reminder: Your flight *FR1234 LIS→FAO* on *5 Oct*, ref *X7KQ2P*. Online check-in should be open now."
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/services/tripPrep.test.ts`
Expected: FAIL — `syncBookingReminders` not exported.

- [ ] **Step 3: Implement**

Replace `server/src/services/tripPrep.ts` with:

```ts
// Bookings the user saved (a boarding pass, a hotel confirmation — documents.ts extracts them as
// `booking` entities) become timed reminders in the attention gate: flight check-in the day before,
// hotel on check-in morning. The gate owns timing, quiet hours and dedupe with the same booking's
// confirmation email; this just hands each future booking over once.
import { DateTime } from "luxon";
import { listEntities, updateEntity } from "../db/store.js";
import { submitAttentionItem } from "./attention.js";
import { userLocalClock } from "./userTimezone.js";
import type { BookingData } from "./entityValidation.js";

export function flightNumberFrom(name: string): string | null {
  const match = name.match(/\b([A-Z]{2}|[A-Z]\d|\d[A-Z])\s?(\d{1,4})\b/);
  return match ? `${match[1]}${match[2]}` : null;
}

function shortDate(date: string): string {
  const parsed = DateTime.fromISO(date);
  return parsed.isValid ? parsed.toFormat("d LLL") : date;
}

export function bookingSummary(data: BookingData): string {
  const ref = data.reference ? `, ref *${data.reference}*` : "";
  if (data.kind === "flight") return `Your flight *${data.name}* on *${shortDate(data.startDate)}*${ref}.`;
  const until = data.endDate ? ` to *${shortDate(data.endDate)}*` : "";
  return `Your stay at *${data.name}* from *${shortDate(data.startDate)}*${until}${ref}.`;
}

export async function syncBookingReminders(ownerId: number): Promise<void> {
  const today = userLocalClock(ownerId).dateKey;
  for (const booking of listEntities<BookingData>(ownerId, { type: "booking" })) {
    const data = booking.data;
    if (data.tripPrepNotifiedAt || data.startDate < today) continue;
    await submitAttentionItem(ownerId, {
      source: "booking",
      category: "reservation_confirmed",
      details: {
        summary: bookingSummary(data),
        kind: data.kind,
        eventStart: data.startDate,
        reference: data.reference,
        flightNumber: data.kind === "flight" ? flightNumberFrom(data.name) : null,
        merchant: data.kind === "hotel" ? data.name : null,
        bookingEntityId: booking.id,
      },
      fallbackKey: `booking:${booking.id}`,
      // The user sent us this document themselves and already got a "saved" reply.
      acknowledged: true,
    });
    // Marks "handed to the attention gate", so it's never submitted twice.
    updateEntity<BookingData>(ownerId, booking.id, { data: { ...data, tripPrepNotifiedAt: Date.now() } });
  }
}
```

Update the `tripPrepNotifiedAt` comment in `entityValidation.ts:260` to: `// set by tripPrep.ts once the booking has been handed to the attention gate — one-shot per booking`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/services/tripPrep.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/services/tripPrep.ts server/src/services/tripPrep.test.ts server/src/services/entityValidation.ts
git commit -m "feat: saved bookings become attention-gate reminders; fixes server-date trip nudges"
```

---

### Task 8: People's emails — gist from triage, concrete instant pings

**Files:**
- Modify: `server/src/services/realPersonTriage.ts`, `server/src/services/alerts.ts`, `server/src/services/emailDigest.ts` (only the `DigestEmail` type + `queueForEmailDigest` here)
- Test: `server/src/services/realPersonTriage.test.ts`, `server/src/services/alerts.test.ts`

**Interfaces:**
- Consumes: `submitAttentionItem` (Task 3).
- Produces:
  ```ts
  // realPersonTriage.ts
  export interface TriageGist { gist: string; needsReply: boolean }
  export interface TriageResult { skips: Map<number, TriageSkipReason>; gists: Map<number, TriageGist> }
  export function parseTriageGists(kept: unknown): Map<number, TriageGist>;
  export async function triageRealPersonEmails(candidates, recentAlerts, ownerId): Promise<TriageResult>;
  // emailDigest.ts
  export interface DigestEmail { id: string; accountId: number; from: string; subject: string; gist?: string; needsReply?: boolean }
  // alerts.ts
  export function personLine(from: string, subject: string, gist?: TriageGist): string;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `realPersonTriage.test.ts` (import `parseTriageGists`, `buildTriagePrompt`):

```ts
describe("parseTriageGists", () => {
  it("keeps well-formed gists and drops the rest", () => {
    const gists = parseTriageGists([
      { index: 0, gist: "wants to move Thursday's call to Friday", needs_reply: true },
      { index: 1, gist: "" },
      { index: "2", gist: "x" },
      { index: 3, gist: "sent the signed contract" },
    ]);
    expect(gists.get(0)).toEqual({ gist: "wants to move Thursday's call to Friday", needsReply: true });
    expect(gists.has(1)).toBe(false);
    expect(gists.has(2)).toBe(false);
    expect(gists.get(3)).toEqual({ gist: "sent the signed contract", needsReply: false });
  });

  it("asks for a gist of what the sender wants", () => {
    expect(buildTriagePrompt([{ index: 0, from: "a", subject: "b", snippet: "c" }], [])).toMatch(/gist/);
  });
});
```

In `alerts.test.ts`:

1. Change the triage mock default in `beforeEach` to `mockTriage.mockReset().mockResolvedValue({ skips: new Map(), gists: new Map() });` and every `mockTriage.mockResolvedValueOnce(new Map([...]))` to `mockResolvedValueOnce({ skips: new Map([...]), gists: new Map() })`.
2. Add `setUserTimezone` import and call `setUserTimezone(ownerId, "Europe/London")` inside `registerActivePhone`; add `vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-01T11:00:00Z"));` to `beforeEach` and `vi.useRealTimers()` in an `afterEach` (import `afterEach`) so instant pings aren't in quiet hours.
3. Remove `takeSuppressedOnboardingAlertCount` import. Replace `"records but does not send while onboarding is still in progress"` with:
   ```ts
   it("puts mail into the digest instead of pinging while onboarding is still in progress", async () => {
     const user = findOrCreateUserByEmail(uniqueEmail("onboarding"));
     registerActivePhone(user.id);
     await baseline(user.id);
     markOnboardingConnected(user.id);
     mockHubListNewMessages.mockResolvedValueOnce([fakeMessage({ id: "p1", from: "Jane <jane@x.com>", subject: "Hi" })]);

     await checkForNewImportantMessages(user.id);

     expect(sendWhatsAppMessage).not.toHaveBeenCalled();
     expect(queuedEmailDigestCount(user.id)).toBe(1);
   });
   ```
   (import `markOnboardingConnected` from `./onboardingAlertSuppression.js` and `queuedEmailDigestCount` from `./emailDigest.js`; keep this file's own `baseline`/`fakeMessage`/`uniqueEmail` helper names.)
4. Replace `"greets the user by name and shows the sender's display name, never a raw email address"`, `"omits the greeting when no name is known yet"` and `"sends a tidied preview: entities decoded"` with:
   ```ts
   it("instant mode sends one concrete line: bold sender, what they want, whether to reply", async () => {
     const user = findOrCreateUserByEmail(uniqueEmail("instant-gist"));
     registerActivePhone(user.id);
     await baseline(user.id);
     mockHubListNewMessages.mockResolvedValueOnce([fakeMessage({ id: "g1", from: '"Sarah Kim" <sarah@x.com>', subject: "Thursday" })]);
     mockTriage.mockResolvedValueOnce({
       skips: new Map(),
       gists: new Map([[0, { gist: "wants to move Thursday's call to Friday", needsReply: true }]]),
     });

     await checkForNewImportantMessages(user.id);

     expect(vi.mocked(sendWhatsAppMessage).mock.calls[0][1]).toBe(
       "📬 *Sarah Kim* — wants to move Thursday's call to Friday; needs a reply"
     );
   });

   it("without a gist, names the sender and subject — never a raw address or snippet", async () => {
     const user = findOrCreateUserByEmail(uniqueEmail("instant-nogist"));
     registerActivePhone(user.id);
     await baseline(user.id);
     mockHubListNewMessages.mockResolvedValueOnce([
       fakeMessage({ id: "n1", from: "dave@example.com", subject: "Quote &amp; plans", snippet: "raw &lt;html&gt;" }),
     ]);

     await checkForNewImportantMessages(user.id);

     const text = vi.mocked(sendWhatsAppMessage).mock.calls[0][1] as string;
     expect(text).toBe('📬 *dave* emailed: "Quote & plans"');
   });

   it("in instant mode, mail past the per-check limit goes to the digest, not an 'and N more' line", async () => {
     const user = findOrCreateUserByEmail(uniqueEmail("instant-overflow"));
     registerActivePhone(user.id);
     await baseline(user.id);
     mockHubListNewMessages.mockResolvedValueOnce(
       Array.from({ length: 7 }, (_, i) => fakeMessage({ id: `o${i}`, from: `P${i} <p${i}@x.com>`, subject: `S${i}` }))
     );

     await checkForNewImportantMessages(user.id);

     expect(sendWhatsAppMessage).toHaveBeenCalledTimes(5);
     expect(queuedEmailDigestCount(user.id)).toBe(2);
     for (const [, text] of vi.mocked(sendWhatsAppMessage).mock.calls) expect(text).not.toMatch(/more/);
   });

   it("digest mode stores the gist on the queued email", async () => {
     const user = findOrCreateUserByEmail(uniqueEmail("digest-gist"));
     registerActivePhone(user.id);
     setRealPersonAlertMode(user.id, "digest");
     await baseline(user.id);
     mockHubListNewMessages.mockResolvedValueOnce([fakeMessage({ id: "dg", from: "Sarah <s@x.com>", subject: "Thu" })]);
     mockTriage.mockResolvedValueOnce({ skips: new Map(), gists: new Map([[0, { gist: "wants to move the call", needsReply: true }]]) });

     await checkForNewImportantMessages(user.id);

     expect(JSON.parse(getSetting(user.id, "email_digest_queue") ?? "[]")[0]).toMatchObject({
       gist: "wants to move the call",
       needsReply: true,
     });
   });
   ```
   (`setRealPersonAlertMode` is already used in this file's `registerActivePhone`; import `getSetting` from the store if not already.)
5. The diagnostics test `"names onboarding suppression as the reason when it swallows mail"` should now expect the log line to match `/onboarding: queued \d+ for the digest/`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/services/realPersonTriage.test.ts src/services/alerts.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

**`realPersonTriage.ts`:**

1. Add types:
   ```ts
   export interface TriageGist {
     gist: string;
     needsReply: boolean;
   }
   export interface TriageResult {
     skips: Map<number, TriageSkipReason>;
     gists: Map<number, TriageGist>;
   }
   ```
2. In `buildTriagePrompt`, change the last instruction sentence `"...When unsure, do not skip. Omit indices that should alert.\n\n"` to:
   ```ts
   "A real person writing to the user, or any email that needs their attention and isn't covered by an " +
   "earlier alert, must NOT be skipped. When unsure, do not skip.\n" +
   "For every email you do NOT skip, add it to `kept` with a gist: a few words on what the sender " +
   "wants or says, written after their name (e.g. \"wants to move Thursday's call to Friday\", " +
   "\"sent the signed contract\") — concrete, no greeting, no quotes — and needs_reply: true if they " +
   "are waiting on an answer from the user.\n\n"
   ```
3. Add the parser:
   ```ts
   export function parseTriageGists(kept: unknown): Map<number, TriageGist> {
     const result = new Map<number, TriageGist>();
     if (!Array.isArray(kept)) return result;
     for (const entry of kept) {
       const e = entry as { index?: unknown; gist?: unknown; needs_reply?: unknown } | null;
       if (e && typeof e.index === "number" && typeof e.gist === "string" && e.gist.trim()) {
         result.set(e.index, { gist: e.gist.trim(), needsReply: e.needs_reply === true });
       }
     }
     return result;
   }
   ```
4. Rename `TRIAGE_TOOL` name to `"triage_emails"`, description `"Report which numbered emails should NOT alert, and a gist for every one that should."`, and add to `properties`:
   ```ts
   kept: {
     type: "array",
     items: {
       type: "object",
       properties: {
         index: { type: "number" },
         gist: { type: "string" },
         needs_reply: { type: "boolean" },
       },
       required: ["index", "gist"],
     },
   },
   ```
   with `required: ["skips", "kept"]`.
5. `triageRealPersonEmails` returns `Promise<TriageResult>`: empty candidates → `{ skips: new Map(), gists: new Map() }`; `tool_choice` name `"triage_emails"`; the `find` matches `b.name === "triage_emails"`; return
   ```ts
   const input = toolUse?.input as { skips?: unknown; kept?: unknown } | undefined;
   return { skips: parseTriageSkips(input?.skips), gists: parseTriageGists(input?.kept) };
   ```

**`emailDigest.ts`** (type + queue only in this task):

```ts
export interface DigestEmail {
  id: string;
  accountId: number;
  from: string;
  subject: string;
  gist?: string;
  needsReply?: boolean;
}

export function queueForEmailDigest(ownerId: number, emails: DigestEmail[]): void {
  if (emails.length === 0) return;
  writeQueue(ownerId, [
    ...readQueue(ownerId),
    ...emails.map(({ id, accountId, from, subject, gist, needsReply }) => ({ id, accountId, from, subject, gist, needsReply })),
  ]);
}
```

**`alerts.ts`:**

1. Imports: remove `sendProactiveMessage`, `emailReferenceNote`, `incrementSuppressedOnboardingAlerts`, `tidySnippet`. Keep `getSetting` (baseline key). Add:
   ```ts
   import { submitAttentionItem } from "./attention.js";
   import type { TriageGist } from "./realPersonTriage.js";
   import { personLine } from "./personLine.js";
   ```
2. Delete `notify`.
3. Create `server/src/services/personLine.ts` (its own module so `emailDigest.ts` can use it without importing `alerts.ts`, which imports `emailDigest.ts`):
   ```ts
   import { senderDisplayName } from "./hub.js";
   import { tidySnippet } from "./htmlToText.js";
   import type { TriageGist } from "./realPersonTriage.js";

   // One line per person who emailed: bold name, then what they want. Shared by instant pings
   // (alerts.ts) and the evening digest (emailDigest.ts) so both read the same.
   export function personLine(from: string, subject: string, gist?: Pick<TriageGist, "gist" | "needsReply">): string {
     const name = senderDisplayName(from);
     if (gist?.gist) return `*${name}* — ${gist.gist}${gist.needsReply ? "; needs a reply" : ""}`;
     return `*${name}* emailed: "${tidySnippet(subject)}"`;
   }
   ```
4. Change `triageUnseen` to return `{ skipped: Set<UnifiedMessage>; gists: Map<UnifiedMessage, TriageGist> }`: on success, map `verdicts.skips` keys to `skipped` and `verdicts.gists` entries to `gists.set(unseen[index], gist)`; on failure return empty set/map.
5. Replace the block from `// See importantEmailAlerts.ts's identical check` through the end of `checkForNewImportantMessages` with:
   ```ts
   const { skipped, gists } = await triageUnseen(ownerId, unseen);
   for (const m of unseen) if (skipped.has(m)) markAlerted(ownerId, messageKey(m));
   const toAlert = unseen.filter((m) => !skipped.has(m));
   if (toAlert.length === 0) {
     logScan(`skipped ${skipped.size} (marketing or repeats an earlier alert)`, unseen.length);
     return;
   }
   const queued = (ms: UnifiedMessage[]) =>
     ms.map((m) => ({ ...m, gist: gists.get(m)?.gist, needsReply: gists.get(m)?.needsReply }));

   // Digest mode, or mid-onboarding (never interleave pings with the setup questions): hold for
   // emailDigest.ts's once-a-day summary. Marked alerted at once so nothing is queued twice.
   const onboarding = isOnboardingSuppressionActive(ownerId);
   if (onboarding || realPersonAlertMode(ownerId) === "digest") {
     queueForEmailDigest(ownerId, queued(toAlert));
     for (const m of toAlert) markAlerted(ownerId, messageKey(m));
     logScan(
       `${onboarding ? "onboarding: " : ""}queued ${toAlert.length} for the digest${skipped.size ? `, skipped ${skipped.size}` : ""}`,
       unseen.length
     );
     return;
   }

   // Instant mode: each goes through the attention gate (quiet hours apply; cap-exempt, since the
   // user asked for every email). Past the per-check limit, the rest wait for the digest.
   const toSend = toAlert.slice(0, MAX_ALERTS_PER_CHECK);
   for (const m of toSend) {
     await submitAttentionItem(ownerId, {
       source: "email",
       category: "person_email",
       details: {
         summary: personLine(m.from, m.subject, gists.get(m)),
         accountId: m.accountId,
         messageId: m.id,
         emailSubject: m.subject,
         emailFrom: m.from,
       },
       fallbackKey: `person:${m.accountId}:${m.id}`,
     });
     markAlerted(ownerId, messageKey(m));
   }
   const rest = toAlert.slice(MAX_ALERTS_PER_CHECK);
   if (rest.length > 0) {
     queueForEmailDigest(ownerId, queued(rest));
     for (const m of rest) markAlerted(ownerId, messageKey(m));
   }
   logScan(
     `sent ${toSend.length}${rest.length ? `, ${rest.length} to the digest` : ""}` + (skipped.size ? `, skipped ${skipped.size}` : ""),
     unseen.length
   );
   ```
   Also remove the now-unused `userName`/`greeting` lines, and the old onboarding block above triage (`isOnboardingSuppressionActive` check that counted and returned) — the new block above replaces it. Keep the `isWhatsAppConfigured` and phone-number gates where they are.
6. Note the `queueForEmailDigest(ownerId, queued(...))` spreads a `UnifiedMessage`; `queueForEmailDigest` picks only the `DigestEmail` fields, so the extra fields are dropped.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/services/realPersonTriage.test.ts src/services/alerts.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/services/realPersonTriage.ts server/src/services/realPersonTriage.test.ts server/src/services/alerts.ts server/src/services/alerts.test.ts server/src/services/emailDigest.ts server/src/services/personLine.ts
git commit -m "feat: people's emails say what the sender wants; instant pings go through the gate"
```

---

### Task 9: Evening digest — concrete lines + attention sections

**Files:**
- Modify: `server/src/services/emailDigest.ts`
- Test: `server/src/services/emailDigest.test.ts`

**Interfaces:**
- Consumes: `personLine` (Task 8, `./personLine.js`), `collectAttentionForDigest`, `commitAttentionBundle`, `isEmptyBundle`, `AttentionBundle` (Task 3), `getBriefingSettings` (`./briefing.js`).
- Produces: `export function digestMessage(userName: string | null, queue: DigestEmail[], attention: AttentionBundle, digestTime: string, maxChars?: number): string` (exported for tests).

- [ ] **Step 1: Update the tests first**

In `emailDigest.test.ts`:

1. Import `digestMessage` and `submitAttentionItem` (`./attention.js`) and `saveBriefingSettings` (`./briefing.js`).
2. Replace `"sends one summary line once the digest time has passed, then empties the queue"` assertions with:
   ```ts
   expect(text).toContain("9pm summary");
   expect(text).toContain('*Sarah Jones* emailed: "Lunch on Sunday?"');
   expect(text).toContain('*Dr Patel* emailed: "Your results"');
   ```
3. Replace `"names the first few and counts the rest"` with:
   ```ts
   it("names everyone concretely and never says 'and N more'", async () => {
     const user = newUser("digest-many");
     registerActivePhone(user.id);
     queueForEmailDigest(
       user.id,
       Array.from({ length: 8 }, (_, i) => email(`m${i}`, `Person ${i} <p${i}@x.com>`, `Subject ${i}`))
     );
     setLocalTime("21:05");
     await flushEmailDigestIfDue(user.id);
     const text = vi.mocked(sendWhatsAppMessage).mock.calls[0][1] as string;
     expect(text).not.toMatch(/and \d+ more/);
     expect(text).toContain("Also from *Person 5*, *Person 6*, *Person 7*");
   });
   ```
4. Add:
   ```ts
   it("uses the triage gist and flags replies", () => {
     const text = digestMessage(null, [{ id: "a", accountId: 1, from: "Sarah Kim <s@x.com>", subject: "Thu", gist: "wants to move Thursday's call", needsReply: true }], { noted: [], needsAttention: [], upcoming: [], ackIds: [], foldIds: [] }, "21:00");
     expect(text).toContain("*Sarah Kim* — wants to move Thursday's call; needs a reply");
   });

   it("carries attention acks and brief items when the morning briefing is off, then marks them done", async () => {
     const user = newUser("digest-attention");
     registerActivePhone(user.id);
     setLocalTime("12:00");
     await submitAttentionItem(user.id, {
       source: "email",
       category: "refund_dispute",
       details: { summary: "Your *Amazon* refund of *£24* was approved." },
       fallbackKey: "msg:1:refund",
     });
     setLocalTime("21:05");
     await flushEmailDigestIfDue(user.id);
     const text = vi.mocked(sendWhatsAppMessage).mock.calls[0][1] as string;
     expect(text).toContain("Your *Amazon* refund of *£24* was approved.");

     vi.mocked(sendWhatsAppMessage).mockClear();
     setLocalTime("21:05", 11);
     await flushEmailDigestIfDue(user.id);
     expect(sendWhatsAppMessage).not.toHaveBeenCalled();
   });

   it("leaves brief items for the morning briefing when it's on", async () => {
     const user = newUser("digest-briefing-on");
     registerActivePhone(user.id);
     saveBriefingSettings(user.id, { enabled: true, includeNews: false, topics: [], includeMarkets: false, tickers: [], includeWeather: false, weatherLocation: "", proactive: true, sendTime: "07:30" });
     setLocalTime("12:00");
     await submitAttentionItem(user.id, {
       source: "email",
       category: "refund_dispute",
       details: { summary: "Your *Amazon* refund of *£24* was approved." },
       fallbackKey: "msg:1:refund2",
     });
     setLocalTime("21:05");
     await flushEmailDigestIfDue(user.id);
     expect(sendWhatsAppMessage).not.toHaveBeenCalled();
   });

   it("still sends attention lines when people's email alerts are off", async () => {
     const user = newUser("digest-people-off");
     registerActivePhone(user.id);
     setRealPersonAlertsEnabled(user.id, false);
     setLocalTime("12:00");
     await submitAttentionItem(user.id, {
       source: "email",
       category: "refund_dispute",
       details: { summary: "Your *Amazon* refund of *£24* was approved." },
       fallbackKey: "msg:1:refund3",
     });
     setLocalTime("21:05");
     await flushEmailDigestIfDue(user.id);
     expect(vi.mocked(sendWhatsAppMessage).mock.calls[0][1]).toContain("*Amazon*");
   });
   ```
5. In the first-digest intro tests, update any assertion on the intro wording to the new sentence in Step 3 (`"Urgent things like flight changes still come straight away"`).
6. `"keeps the whole check-in question inside a template even with long names and subjects"` must still pass: the template branch uses the same length guard (Step 3 caps the message at 1000 characters).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/services/emailDigest.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `emailDigest.ts`:

1. Imports: add
   ```ts
   import { personLine } from "./personLine.js";
   import { getBriefingSettings } from "./briefing.js";
   import {
     collectAttentionForDigest,
     commitAttentionBundle,
     isEmptyBundle,
     type AttentionBundle,
   } from "./attention.js";
   ```
   Remove `senderDisplayName` import if unused.
2. Replace `MAX_NAMED`, `MAX_SUBJECT_LENGTH`, `MAX_NAME_LENGTH`, `shorten`, and `digestMessage` with:
   ```ts
   const MAX_LINES = 5;
   // A template body is capped at 1000 characters. The first digest also carries the ~420-character
   // check-in question, so it gets a smaller budget (see flushEmailDigestIfDue).
   const MAX_DIGEST_CHARS = 950;
   const MAX_DIGEST_CHARS_WITH_INTRO = 550;

   export function digestMessage(
     userName: string | null,
     queue: DigestEmail[],
     attention: AttentionBundle,
     digestTime: string,
     maxChars = MAX_DIGEST_CHARS
   ): string {
     const lead = `📬 ${userName ? `${userName}, here's` : "Here's"} your ${formatDigestTime(digestTime)} summary:`;
     const sections: string[] = [];
     if (queue.length) {
       const lines = queue
         .slice(0, MAX_LINES)
         .map((m) => `• ${personLine(m.from, m.subject, m.gist ? { gist: m.gist, needsReply: !!m.needsReply } : undefined)}`);
       const others = queue.slice(MAX_LINES).map((m) => `*${senderDisplayName(m.from)}*`);
       if (others.length) lines.push(`Also from ${others.join(", ")}.`);
       sections.push(lines.join("\n"));
     }
     if (attention.needsAttention.length) sections.push(attention.needsAttention.map((l) => `• ${l}`).join("\n"));
     if (attention.noted.length) sections.push(attention.noted.map((l) => `• ${l}`).join("\n"));
     let text = `${lead}\n${sections.join("\n\n")}`;
     if (text.length > maxChars) text = `${text.slice(0, maxChars - 1).replace(/\s+\S*$/, "")}…`;
     return text;
   }
   ```
   Keep the existing `senderDisplayName` import from `./hub.js`.
   The truncation can cut through a bold span; acceptable — it only triggers for very long digests, and the email ids are in chat history via the reference notes.
3. Update `introExplanation`:
   ```ts
   return (
     `\n\nWe're trying something new: instead of pinging you every time someone emails, I now send ` +
     `one summary of people's emails each day at ${formatDigestTime(digestTime)}. Urgent things like ` +
     `flight changes still come straight away, and bookings and bills become reminders when they ` +
     `matter. Want to keep the daily summary?`
   );
   ```
4. Rewrite `flushEmailDigestIfDue` from `// They turned people's emails off` to the end:
   ```ts
   if (!realPersonAlertsEnabled(ownerId)) writeQueue(ownerId, []);

   const queue = readQueue(ownerId);
   const now = Date.now();
   const attention = collectAttentionForDigest(ownerId, now, !getBriefingSettings(ownerId).proactive);
   if (queue.length === 0 && isEmptyBundle(attention)) {
     setSetting(ownerId, LAST_SENT_KEY, dateKey);
     return;
   }

   if (!isWhatsAppConfigured()) return;
   const numbers = listPhoneNumbersForUser(ownerId).map((r) => r.phone);
   if (numbers.length === 0) return;

   const askToKeep =
     queue.length > 0 && getSetting(ownerId, INTRO_SENT_KEY) === null && !realPersonAlertModeChosen(ownerId);
   const historyNote = [
     ...queue.slice(0, MAX_LINES).map((m) => emailReferenceNote(m)),
     ...(askToKeep ? [INTRO_HISTORY_NOTE] : []),
   ].join("\n");
   const digestTime = emailDigestTime(ownerId);
   const digest = digestMessage(
     getSetting(ownerId, "user_name"),
     queue,
     attention,
     digestTime,
     askToKeep ? MAX_DIGEST_CHARS_WITH_INTRO : MAX_DIGEST_CHARS
   );
   ```
   then keep the existing `send`/button logic and `sendToAllNumbers` call unchanged, and change the success block to:
   ```ts
   if (sent) {
     writeQueue(ownerId, []);
     commitAttentionBundle(ownerId, attention, now);
     setSetting(ownerId, LAST_SENT_KEY, dateKey);
     if (askToKeep) setSetting(ownerId, INTRO_SENT_KEY, "true");
   }
   ```
   `historyNote` may be an empty string when only attention lines are sent; pass `historyNote || undefined` to `sendToAllNumbers`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/services/emailDigest.test.ts src/services/alerts.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/services/emailDigest.ts server/src/services/emailDigest.test.ts
git commit -m "feat: evening digest says what each person wants and carries noted/held items"
```

---

### Task 10: Briefing — acknowledgements, no filler

**Files:**
- Modify: `server/src/services/briefing.ts`, `server/src/services/scheduler.ts` (`runDailyCheckForUser` only)
- Test: `server/src/services/briefing.test.ts`, `server/src/services/scheduler.briefingTime.test.ts`

**Interfaces:**
- Consumes: `collectAttentionForBriefing`, `commitAttentionBundle`, `isEmptyBundle`, `AttentionBundle` (Task 3).
- Produces:
  ```ts
  export function attentionFactLines(bundle: AttentionBundle | undefined): string[];
  export function briefingSystemPrompt(assistantName: string, persona: string): string;
  export async function getTodaysBriefing(ownerId: number, attention?: AttentionBundle): Promise<{ date: string; content: string }>;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `briefing.test.ts` (add `attentionFactLines`, `briefingSystemPrompt` to its import):

```ts
describe("attentionFactLines", () => {
  const empty = { noted: [], needsAttention: [], upcoming: [], ackIds: [], foldIds: [] };
  it("adds nothing when there's nothing to say", () => {
    expect(attentionFactLines(undefined)).toEqual([]);
    expect(attentionFactLines(empty)).toEqual([]);
  });
  it("labels each kind of item so the model keeps them apart", () => {
    const lines = attentionFactLines({
      ...empty,
      noted: ["Noted: your *Netflix* renewal — I'll remind you Wed 30 Sep."],
      needsAttention: ["Your *Amazon* refund of *£24* was approved."],
      upcoming: ["🏨 Reminder: Your *Hilton* stay. Check-in is today."],
    });
    expect(lines[0]).toMatch(/^Coming up in the next couple of hours/);
    expect(lines[0]).toContain("*Hilton*");
    expect(lines.join("\n")).toContain("Noted since the last briefing");
    expect(lines.join("\n")).toContain("Worth knowing");
  });
});

describe("briefingSystemPrompt", () => {
  it("omits empty sections instead of forcing a 'none' line, and drops the unread count", () => {
    const prompt = briefingSystemPrompt("Marlowe", "");
    expect(prompt).not.toMatch(/always get a line/);
    expect(prompt).not.toMatch(/the count plus/);
    expect(prompt).toMatch(/Omit any section with nothing worth saying/);
    expect(prompt).toMatch(/Noted since the last briefing/);
  });
});
```

In `scheduler.briefingTime.test.ts`, add:

```ts
it("passes this morning's attention items to the briefing and marks them done once sent", async () => {
  const { user } = newSubscriber("Europe/London");
  vi.setSystemTime(new Date("2026-10-01T10:00:00Z"));
  const { submitAttentionItem } = await import("./attention.js");
  await submitAttentionItem(user.id, {
    source: "email",
    category: "refund_dispute",
    details: { summary: "Your *Amazon* refund of *£24* was approved." },
    fallbackKey: "msg:1:refund-bt",
  });
  const { getTodaysBriefing } = await import("./briefing.js");

  vi.setSystemTime(new Date("2026-10-02T06:45:00Z")); // 07:45 London
  await runDailyCheckForUser(user.id);

  const attention = vi.mocked(getTodaysBriefing).mock.calls.at(-1)?.[1];
  expect(attention?.needsAttention).toEqual(["Your *Amazon* refund of *£24* was approved."]);
  const { collectAttentionForBriefing } = await import("./attention.js");
  expect(collectAttentionForBriefing(user.id, Date.now()).needsAttention).toEqual([]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/services/briefing.test.ts src/services/scheduler.briefingTime.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `briefing.ts`:

1. `import type { AttentionBundle } from "./attention.js";` (type-only import: no runtime cycle with `attention.ts` → `briefing.ts`).
2. Add:
   ```ts
   export function attentionFactLines(bundle: AttentionBundle | undefined): string[] {
     if (!bundle) return [];
     const lines: string[] = [];
     if (bundle.upcoming.length) {
       lines.push(`Coming up in the next couple of hours — lead the briefing with these, keeping the *bold* specifics: ${bundle.upcoming.join(" | ")}`);
     }
     if (bundle.needsAttention.length) {
       lines.push(`Worth knowing (one short line each, keep the *bold* specifics): ${bundle.needsAttention.join(" | ")}`);
     }
     if (bundle.noted.length) {
       lines.push(`Noted since the last briefing (one short line each, keep the *bold* specifics and the "I'll remind you" part word for word): ${bundle.noted.join(" | ")}`);
     }
     return lines;
   }

   export function briefingSystemPrompt(assistantName: string, persona: string): string {
     return `You are ${assistantName}, the user's personal assistant, writing their morning briefing.${
       persona ? ` The user described their preferences: ${persona}` : ""
     } Write it like a sharp PA: only what matters today, terse and scannable, using ONLY the facts given below — never supplement them with your own general knowledge, training data, or plausible-sounding guesses. This is a hard rule: fabricating a headline, email, event or date is a serious error.

   Structure, in this order, and omit any section with nothing worth saying — no "nothing scheduled", no "no new emails":
   - Coming up: ONLY if a "Coming up in the next couple of hours" fact is present. These lead.
   - Location: ONLY if a "Currently in ..." fact is present. One short clause (don't say "just arrived" or "welcome to" unless the fact says arrived today).
   - Weather: ONLY if a "Weather in ..." fact is present. One short clause.
   - Calendar: today's events from "Today's calendar events". Add a note from "Calendar events in the next 3 days" only if it needs prep now (a flight, checking out).
   - People: ONLY a person's email from "Unread emails today" or "Emails that look like they need a reply" that genuinely looks like it needs the user — name at most 2, say what they want if the subject makes it clear. Never state a count of unread emails.
   - Worth knowing: ONLY if a "Worth knowing" fact is present.
   - Noted since the last briefing: ONLY if that fact is present — keep each item's "I'll remind you" wording.
   - Markets: ONLY if a "Markets:" fact is present. One short line, mentioning direction.
   - News: ONLY if a "Top news headlines" fact is present. One line per headline, max 3.

   Keep WhatsApp *bold* markers from the facts. No headers, no preamble, no sign-off. Keep the whole thing under 120 words. If nothing at all is worth saying, reply with one short line saying the day looks clear.`;
   }
   ```
3. In `buildBriefingText(ownerId, attention?: AttentionBundle)`: add `...attentionFactLines(attention),` as the **first** element of the `facts` array, and replace the inline `system:` template with `system: briefingSystemPrompt(assistantName, persona),`. Change the `Unread emails today (${unread.length}): …` fact label to `Unread emails today from people or services: …` (list unchanged; the count is gone from the text the model sees).
4. Change `getTodaysBriefing`:
   ```ts
   // A briefing cached earlier today (e.g. the Assistant page opened it) doesn't know about attention
   // items that arrived since, so the proactive send regenerates it whenever it has some to include.
   export async function getTodaysBriefing(
     ownerId: number,
     attention?: AttentionBundle
   ): Promise<{ date: string; content: string }> {
     const date = userLocalClock(ownerId).dateKey;
     const hasAttention = !!attention && attentionFactLines(attention).length > 0;
     const existing = getBriefing(ownerId, date);
     if (existing && !hasAttention) return existing;
     const content = await buildBriefingText(ownerId, attention);
     return saveBriefing(ownerId, date, content);
   }
   ```

In `scheduler.ts` `runDailyCheckForUser`, replace the `try` block body up to `sendToAllNumbers` with:

```ts
    const now = Date.now();
    const attention = collectAttentionForBriefing(ownerId, now);
    const briefing = await getTodaysBriefing(ownerId, attention);
    const alert = getEnabledTools(ownerId).has("travel") ? schengenAlertLine(ownerId) : null;
    const message = alert ? `${briefing.content}\n\n${alert}` : briefing.content;
    const itemKey = `daily-briefing:${dateKey}`;
    if (await sendToAllNumbers(ownerId, itemKey, numbers, message, "digest", "scheduler")) {
      setSetting(ownerId, "last_proactive_send_date", dateKey);
      commitAttentionBundle(ownerId, attention, now);
    }
```

and import `collectAttentionForBriefing, commitAttentionBundle` from `./attention.js`. In `scheduler.test.ts`, add a mock so the mocked store isn't touched:

```ts
vi.mock("./attention.js", () => ({
  collectAttentionForBriefing: vi.fn(() => ({ noted: [], needsAttention: [], upcoming: [], ackIds: [], foldIds: [] })),
  commitAttentionBundle: vi.fn(),
  deliverDueAttentionItems: vi.fn(() => Promise.resolve()),
}));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/services/briefing.test.ts src/services/scheduler.briefingTime.test.ts src/services/scheduler.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/services/briefing.ts server/src/services/briefing.test.ts server/src/services/scheduler.ts server/src/services/scheduler.test.ts server/src/services/scheduler.briefingTime.test.ts
git commit -m "feat: briefing acknowledges what Marlowe noted and drops empty filler lines"
```

---

### Task 11: Scheduler wiring + remove the onboarding count summary

**Files:**
- Modify: `server/src/services/scheduler.ts`, `server/src/services/onboardingAlertSuppression.ts`, `server/src/services/postConnectSetup.ts` (comment only)
- Test: `server/src/services/scheduler.test.ts`, `server/src/services/onboardingAlertSuppression.test.ts`, `server/src/services/postConnectSetup.test.ts`

**Interfaces:**
- Consumes: `deliverDueAttentionItems` (Task 3), `syncBookingReminders` (Task 7).
- Produces: `onboardingAlertSuppression.ts` exports only `markOnboardingConnected`, `isPostConnectChainInProgress`, `isOnboardingSuppressionActive`.

- [ ] **Step 1: Update the tests first**

`scheduler.test.ts`:
1. Remove the `./onboardingAlertSuppression.js` mock, its import, its `mockClear`, and the test `"flushes any due onboarding alert summary for every tenant"`.
2. Replace the `./tripPrep.js` expectations if any; add `vi.mock("./tripPrep.js", () => ({ syncBookingReminders: vi.fn(() => Promise.resolve()) }));`.
3. Add:
   ```ts
   it("delivers due attention items for every tenant after the mail scans", async () => {
     const { deliverDueAttentionItems } = await import("./attention.js");
     vi.mocked(deliverDueAttentionItems).mockClear();
     const first = tickGuarded();
     await vi.waitFor(() => expect(checkNewEmailsAgainstRecentDocuments).toHaveBeenCalledTimes(1));
     expect(deliverDueAttentionItems).not.toHaveBeenCalled();
     releaseReconciliationCheck();
     await first;
     expect(deliverDueAttentionItems).toHaveBeenCalledWith(1);
   });
   ```

`onboardingAlertSuppression.test.ts`: delete the `describe("onboarding alert suppression counter", …)` and `describe("flushOnboardingAlertSummaryIfDue", …)` blocks and their imports; keep the `isOnboardingSuppressionActive` / `isPostConnectChainInProgress` tests.

`postConnectSetup.test.ts`: remove `incrementSuppressedOnboardingAlerts`, `takeSuppressedOnboardingAlertCount` from the import at line ~40; in `"never mentions a suppressed-alert backlog in the closing message, even if one exists at this moment"`, delete the `incrementSuppressedOnboardingAlerts(ownerId, 3);` line and the final `expect(takeSuppressedOnboardingAlertCount(ownerId)).toBe(3);`, rename it to `"never mentions an inbox backlog in the closing message"`, and replace its leading comment with: `// The closing message never reports mail found during setup — that goes to the digest (people) or the attention gate (everything else).`

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/services/scheduler.test.ts`
Expected: FAIL — `deliverDueAttentionItems` never called.

- [ ] **Step 3: Implement**

`scheduler.ts`:
1. Imports: remove `flushOnboardingAlertSummaryIfDue` and `checkTripPrepNudges`; add `import { syncBookingReminders } from "./tripPrep.js";` and add `deliverDueAttentionItems` to the `./attention.js` import from Task 10.
2. `runTripPrepCheckForUser` calls `await syncBookingReminders(ownerId);` (keep the travel-tool gate and error log text `trip-prep sync failed`).
3. Delete `runOnboardingAlertSummaryFlushForUser` and its call inside `withMessageCache`.
4. After the `withMessageCache(...)` block and before `flushEmailDigestIfDue`, add:
   ```ts
    // After every source has submitted this tick, so a reminder or deferred alert that fell due
    // goes out once, in order, under the day's cap.
    await deliverDueAttentionItems(ownerId).catch((err) =>
      console.error(`scheduler: attention delivery failed for user ${ownerId}`, err)
    );
   ```

`onboardingAlertSuppression.ts`:
1. Delete `COUNT_KEY`, `incrementSuppressedOnboardingAlerts`, `takeSuppressedOnboardingAlertCount`, `flushOnboardingAlertSummaryIfDue`, and the imports they alone used (`listPhoneNumbersForUser`, `isWhatsAppConfigured`, `sendProactiveMessage`).
2. Rewrite the file header's paragraphs about "record-but-don't-send", the count, and `flushOnboardingAlertSummaryIfDue` to:
   ```ts
   // Keeps proactive messages out of the post-connect onboarding conversation. alerts.ts routes
   // people's mail to the evening digest while isOnboardingSuppressionActive is true; the attention
   // gate (attention.ts) holds its sends while isPostConnectChainInProgress is true and delivers them
   // once the question chain has finished. Nothing found during setup is summarised as a bare count.
   ```
   Keep the explanation of why the grace period exists (the paragraph starting `(2) is the one that actually matters`).

`postConnectSetup.ts` (~line 112): replace the comment block above `sendClosingMessage` with:
```ts
// Note: this never mentions mail found while setting up — people's emails go to the evening
// digest and everything else through the attention gate (attention.ts), each concretely.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/services/scheduler.test.ts src/services/onboardingAlertSuppression.test.ts src/services/postConnectSetup.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/services/scheduler.ts server/src/services/scheduler.test.ts server/src/services/onboardingAlertSuppression.ts server/src/services/onboardingAlertSuppression.test.ts server/src/services/postConnectSetup.ts server/src/services/postConnectSetup.test.ts
git commit -m "feat: scheduler delivers due attention items; drop the onboarding count summary"
```

---

### Task 12: Assistant wording, full verification

**Files:**
- Modify: `server/src/ai/assistant.ts` (the `set_email_alerts` tool description ~line 903)
- Test: whole suite + build

- [ ] **Step 1: Update the tool description**

In `assistant.ts`, replace the `set_email_alerts` description's sentence
`"...\`important\` — pings about genuinely important automated mail (flight changes, reservations, deliveries, invoices due, security alerts, etc.), always instant. Both are on by default, and real people's emails are by default held for one summary message a day (people_mode \"digest\", sent at digest_time, default 21:00) while important mail comes through instantly; ..."`
with:
`"...\`important\` — Marlowe watching automated mail (flights, bookings, bills, renewals, deliveries, security alerts): urgent changes like a flight change come straight away, bookings/bills/renewals become reminders at the right moment, and the rest goes into the briefing or evening summary. Both are on by default, and real people's emails are by default held for one summary message a day (people_mode \"digest\", sent at digest_time, default 21:00); ..."`
Keep the rest of the description (the examples of what to pass) unchanged.

- [ ] **Step 2: Grep for leftovers**

Run: `cd server && grep -rn "flushOnboardingAlertSummaryIfDue\|incrementSuppressedOnboardingAlerts\|takeSuppressedOnboardingAlertCount\|checkTripPrepNudges\|isTripPrepDue\|buildMatchNotification\|formatImportantEmailAlert" src`
Expected: no output. Fix any remaining reference.

Run: `cd server && grep -rn "worth a look\|check your inbox\|important-looking\|might need attention" src --include=*.ts | grep -v test | grep -v attentionRules.ts`
Expected: no output.

- [ ] **Step 3: Full test suite**

Run: `cd server && npm test`
Expected: all tests pass. Any failure in a file not touched by this plan is most likely a test that asserted old alert wording or mocked a removed export — update it to the new behaviour described in the spec, not the other way round.

- [ ] **Step 4: Type-check / build**

Run: `cd server && npm run build`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add server/src/ai/assistant.ts
git commit -m "docs: set_email_alerts describes the attention-gate behaviour"
```

---

## Self-Review Notes (for the executor)

- `attention.ts` imports `briefing.ts` (for `getBriefingSettings`), and `briefing.ts` imports `attention.ts` for a **type only** — keep it `import type` or the cycle becomes a runtime import.
- `emailDigest.ts` imports `personLine.ts`, not `alerts.ts` (which imports `emailDigest.ts`).
- The daily cap counts `sent_at` rows since the user's local midnight; exempt categories are excluded in SQL, so no separate counter can drift.
- `sendToAllNumbers` item keys: `attention:<id>:<tier>:<surfaceAt>` for normal sends and `attention:<id>:change:<summary>` for a change to a known event — both unique per actual message, so per-number retry works as before.
