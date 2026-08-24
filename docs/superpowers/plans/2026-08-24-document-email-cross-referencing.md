# Document ↔ Email Cross-Referencing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a saved document (boarding pass, receipt, booking confirmation) and an email
clearly refer to the same real-world thing — sharing a reference code or flight number — notice
the connection and proactively tell the user over WhatsApp.

**Architecture:** The document extraction call (already happening at save time) gains one more
optional tool so it also emits machine-checkable identifiers (`record_match_keys`) alongside the
existing title/category/travel-movement extraction — zero new LLM calls. A new
`server/src/services/reconciliation.ts` owns all matching logic (pure, deterministic, testable
without any LLM or network call) and both directions of the check: synchronously after a document
saves (scan recent email for its identifiers), and on the existing 5-minute scheduler tick (scan
new email for any recent document's identifiers). No LLM call is ever made on the email side in
this version — matching is exact substring comparison against subject+snippet text.

**Tech Stack:** TypeScript, better-sqlite3, Vitest, existing Anthropic SDK tool-calling
infrastructure already used by `documents.ts`.

**Spec:** `docs/superpowers/specs/2026-08-24-document-email-cross-referencing-design.md`

## Global Constraints

- v1 ships **strong-tier matching only** (exact shared `referenceCode` or `flightNumber`) — no
  weak/vendor+date tier, no LLM call on the email side, per the spec.
- No backfill for documents saved before this ships.
- No new UI surface — this ships as a WhatsApp notification only.
- Matching is document↔email only, not document↔document.
- Every new DB write is scoped by `owner_id` (this app is multi-tenant — see `store.ts`'s existing
  pattern on every table).

---

## Task 1: `document_match_keys` table and store functions

**Files:**
- Modify: `server/src/db/store.ts`
- Test: `server/src/db/documentMatchKeysStore.test.ts` (new)

**Interfaces:**
- Produces: `saveMatchKeys(ownerId: number, documentId: number, keys: { referenceCode?: string | null; flightNumber?: string | null; vendor?: string | null; eventDate?: string | null }): void`
- Produces: `listRecentMatchKeys(ownerId: number, sinceMs: number): DocumentMatchKeysRow[]`
- Produces: `interface DocumentMatchKeysRow { documentId: number; referenceCode: string | null; flightNumber: string | null; vendor: string | null; eventDate: string | null; docTitle: string | null }`

- [ ] **Step 1: Write the failing test**

Create `server/src/db/documentMatchKeysStore.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { findOrCreateUserByEmail, saveDocument, saveMatchKeys, listRecentMatchKeys } from "./store.js";

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

function saveTestDoc(ownerId: number, title: string) {
  return saveDocument(ownerId, {
    phone: "447000000001",
    filename: null,
    mimeType: "image/jpeg",
    storedPath: "/tmp/fake",
    caption: null,
    title,
    extractedText: "some text",
    category: "travel",
  });
}

describe("document_match_keys", () => {
  it("round-trips saved keys through listRecentMatchKeys, joined with the document title", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("keys-roundtrip"));
    const doc = saveTestDoc(user.id, "Delta Boarding Pass");

    saveMatchKeys(user.id, doc.id, {
      referenceCode: "K4X9QP",
      flightNumber: "DL1234",
      vendor: "Delta",
      eventDate: "2026-09-12",
    });

    const rows = listRecentMatchKeys(user.id, Date.now() - 1000);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      documentId: doc.id,
      referenceCode: "K4X9QP",
      flightNumber: "DL1234",
      vendor: "Delta",
      eventDate: "2026-09-12",
      docTitle: "Delta Boarding Pass",
    });
  });

  it("does not write a row when every field is absent", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("keys-empty"));
    const doc = saveTestDoc(user.id, "Empty Keys Doc");

    saveMatchKeys(user.id, doc.id, {});

    const rows = listRecentMatchKeys(user.id, Date.now() - 1000);
    expect(rows).toHaveLength(0);
  });

  it("excludes rows created before the sinceMs cutoff", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("keys-window"));
    const doc = saveTestDoc(user.id, "Old Doc");
    saveMatchKeys(user.id, doc.id, { referenceCode: "OLD123" });

    // A cutoff in the future excludes everything that already exists.
    const rows = listRecentMatchKeys(user.id, Date.now() + 60_000);
    expect(rows).toHaveLength(0);
  });

  it("scopes results by owner", () => {
    const userA = findOrCreateUserByEmail(uniqueEmail("keys-owner-a"));
    const userB = findOrCreateUserByEmail(uniqueEmail("keys-owner-b"));
    const docA = saveTestDoc(userA.id, "A's Doc");
    saveMatchKeys(userA.id, docA.id, { referenceCode: "AAAA11" });

    const rowsForB = listRecentMatchKeys(userB.id, Date.now() - 1000);
    expect(rowsForB).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/db/documentMatchKeysStore.test.ts`
Expected: FAIL — `saveMatchKeys`/`listRecentMatchKeys` are not exported from `store.ts` yet.

- [ ] **Step 3: Add the table and index to the schema block**

In `server/src/db/store.ts`, find the multi-tenant table block ending at:

```ts
  CREATE INDEX IF NOT EXISTS idx_pending_reg_token_hash ON pending_whatsapp_registrations(token_hash);
`);
```

Insert a new table just before the closing `` `); `` :

```ts
  CREATE TABLE IF NOT EXISTS document_match_keys (
    document_id INTEGER PRIMARY KEY REFERENCES documents(id),
    owner_id INTEGER NOT NULL REFERENCES users(id),
    reference_code TEXT,
    flight_number TEXT,
    vendor TEXT,
    event_date TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_document_match_keys_owner ON document_match_keys(owner_id, created_at);
`);
```

- [ ] **Step 4: Add the store functions**

In `server/src/db/store.ts`, immediately after the existing `deleteDocument` function:

```ts
export function deleteDocument(ownerId: number, id: number): void {
  db.prepare(`DELETE FROM documents WHERE id = ? AND owner_id = ?`).run(id, ownerId);
}

// Machine-checkable identifiers (reference code, flight number, vendor, event date) pulled from
// a document's extraction call, used by reconciliation.ts to notice when a document and an email
// refer to the same real-world thing. One row per document — a document can be re-extracted at
// most once in practice, but ON CONFLICT keeps this safe if that ever changes.
export interface DocumentMatchKeysRow {
  documentId: number;
  referenceCode: string | null;
  flightNumber: string | null;
  vendor: string | null;
  eventDate: string | null;
  docTitle: string | null;
}

// No-op when every field is absent — don't write an empty row that would never match anything
// and would just be dead weight in listRecentMatchKeys's scan.
export function saveMatchKeys(
  ownerId: number,
  documentId: number,
  keys: {
    referenceCode?: string | null;
    flightNumber?: string | null;
    vendor?: string | null;
    eventDate?: string | null;
  }
): void {
  const hasAny = keys.referenceCode || keys.flightNumber || keys.vendor || keys.eventDate;
  if (!hasAny) return;

  db.prepare(
    `INSERT INTO document_match_keys (document_id, owner_id, reference_code, flight_number, vendor, event_date, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(document_id) DO UPDATE SET
       reference_code = excluded.reference_code,
       flight_number = excluded.flight_number,
       vendor = excluded.vendor,
       event_date = excluded.event_date,
       created_at = excluded.created_at`
  ).run(
    documentId,
    ownerId,
    keys.referenceCode ?? null,
    keys.flightNumber ?? null,
    keys.vendor ?? null,
    keys.eventDate ?? null,
    Date.now()
  );
}

// Joined with documents.title so callers (reconciliation.ts) have everything needed to compose a
// notification without a second lookup.
export function listRecentMatchKeys(ownerId: number, sinceMs: number): DocumentMatchKeysRow[] {
  return db
    .prepare(
      `SELECT k.document_id AS documentId, k.reference_code AS referenceCode, k.flight_number AS flightNumber,
              k.vendor AS vendor, k.event_date AS eventDate, d.title AS docTitle
       FROM document_match_keys k
       JOIN documents d ON d.id = k.document_id
       WHERE k.owner_id = ? AND k.created_at >= ?
       ORDER BY k.created_at DESC`
    )
    .all(ownerId, sinceMs) as DocumentMatchKeysRow[];
}
```

- [ ] **Step 5: Add cleanup to the account-deletion function**

In `server/src/db/store.ts`'s `deleteUserCompletely`, add one line alongside the other per-table
deletes (right after the `documents` line):

```ts
    db.prepare(`DELETE FROM documents WHERE owner_id = ?`).run(ownerId);
    db.prepare(`DELETE FROM document_match_keys WHERE owner_id = ?`).run(ownerId);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd server && npx vitest run src/db/documentMatchKeysStore.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 7: Typecheck and run the full suite**

Run: `cd server && npx tsc --noEmit && npx vitest run`
Expected: clean typecheck, all existing tests still pass (no behavior change to any existing table
or function).

- [ ] **Step 8: Commit**

```bash
cd server
git add src/db/store.ts src/db/documentMatchKeysStore.test.ts
git commit -m "Add document_match_keys table and store functions"
```

---

## Task 2: `matchTier` and notification wording (pure, no dependencies)

**Files:**
- Create: `server/src/services/reconciliation.ts`
- Test: `server/src/services/reconciliation.test.ts` (new)

**Interfaces:**
- Produces: `interface MatchKeys { referenceCode?: string; flightNumber?: string; vendor?: string; eventDate?: string }`
- Produces: `matchTier(keys: MatchKeys, text: string): "strong" | null`
- Produces: `buildMatchNotification(docTitle: string, keys: MatchKeys): string`

This task has no dependency on Task 1 — it's pure string logic, safe to build and merge
independently.

- [ ] **Step 1: Write the failing test**

Create `server/src/services/reconciliation.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { matchTier, buildMatchNotification, type MatchKeys } from "./reconciliation.js";

describe("matchTier", () => {
  it("matches on an exact reference code, case-insensitively", () => {
    const keys: MatchKeys = { referenceCode: "K4X9QP" };
    expect(matchTier(keys, "Your trip is confirmed, ref k4x9qp, departing soon.")).toBe("strong");
  });

  it("matches on an exact flight number", () => {
    const keys: MatchKeys = { flightNumber: "DL1234" };
    expect(matchTier(keys, "Update on your flight DL1234 to Berlin")).toBe("strong");
  });

  it("returns null when neither identifier appears in the text", () => {
    const keys: MatchKeys = { referenceCode: "K4X9QP", flightNumber: "DL1234" };
    expect(matchTier(keys, "Your Amazon order has shipped")).toBeNull();
  });

  it("returns null when there is no reference code or flight number to check, even if vendor/date match", () => {
    const keys: MatchKeys = { vendor: "Delta", eventDate: "2026-09-12" };
    expect(matchTier(keys, "Delta flight update, 2026-09-12")).toBeNull();
  });

  it("ignores identifiers shorter than the minimum length to avoid false positives", () => {
    const keys: MatchKeys = { flightNumber: "AA1" };
    expect(matchTier(keys, "AA1 is mentioned right here")).toBeNull();
  });

  it("returns null for an empty MatchKeys object", () => {
    expect(matchTier({}, "any text at all")).toBeNull();
  });
});

describe("buildMatchNotification", () => {
  it("includes the document title, identifier, and date", () => {
    const msg = buildMatchNotification("Delta Boarding Pass", { flightNumber: "DL1234", eventDate: "2026-09-12" });
    expect(msg).toContain("Delta Boarding Pass");
    expect(msg).toContain("DL1234");
    expect(msg).toContain("2026-09-12");
  });

  it("prefers referenceCode over flightNumber when both are present", () => {
    const msg = buildMatchNotification("Hotel Booking", { referenceCode: "K4X9QP", flightNumber: "DL1234" });
    expect(msg).toContain("K4X9QP");
    expect(msg).not.toContain("DL1234");
  });

  it("omits a stray date segment when eventDate is absent", () => {
    const msg = buildMatchNotification("Hotel Booking", { referenceCode: "K4X9QP" });
    expect(msg).not.toContain("undefined");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/services/reconciliation.test.ts`
Expected: FAIL — `reconciliation.js` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Create `server/src/services/reconciliation.ts`:

```ts
// Cross-referencing between saved documents and email — see
// docs/superpowers/specs/2026-08-24-document-email-cross-referencing-design.md for the full
// design and why this stays entirely deterministic in v1 (no LLM call on the email side at all).

export interface MatchKeys {
  referenceCode?: string;
  flightNumber?: string;
  vendor?: string;
  eventDate?: string;
}

// Below this length, a substring match against free-text email content is too likely to be a
// coincidence (e.g. a 3-character flight number like "AA1" appearing in unrelated text) —
// accepting some missed short-identifier matches in exchange for far fewer false positives.
const MIN_IDENTIFIER_LENGTH = 4;

// v1 ships strong-tier matching only (see the design doc) — this only ever compares a document's
// structured keys against a raw text blob (an email's subject + snippet), never two structured
// MatchKeys objects against each other, since email never gets its own LLM extraction call in
// this version. Returns "strong" | null; a "weak" tier is deliberately not implemented yet.
export function matchTier(keys: MatchKeys, text: string): "strong" | null {
  const haystack = text.toLowerCase();

  if (keys.referenceCode && keys.referenceCode.length >= MIN_IDENTIFIER_LENGTH) {
    if (haystack.includes(keys.referenceCode.toLowerCase())) return "strong";
  }
  if (keys.flightNumber && keys.flightNumber.length >= MIN_IDENTIFIER_LENGTH) {
    if (haystack.includes(keys.flightNumber.toLowerCase())) return "strong";
  }
  return null;
}

export function buildMatchNotification(docTitle: string, keys: MatchKeys): string {
  const identifier = keys.referenceCode ?? keys.flightNumber ?? "";
  const datePart = keys.eventDate ? `, ${keys.eventDate}` : "";
  return `📎 Heads up — an email about "${docTitle}" (${identifier}${datePart}) just came in. Worth a look?`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/services/reconciliation.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
cd server
git add src/services/reconciliation.ts src/services/reconciliation.test.ts
git commit -m "Add matchTier and buildMatchNotification (pure matching logic)"
```

---

## Task 3: `record_match_keys` extraction tool

**Files:**
- Modify: `server/src/services/documents.ts`
- Test: `server/src/services/documents.test.ts` (extend)

**Interfaces:**
- Consumes: `MatchKeys` from `./reconciliation.js` (Task 2)
- Produces: `parseExtractionResponse` (exported, was private) now returns `matchKeys: MatchKeys | null` as a fourth field
- Produces: `interface ExtractionResult { text: string; title: string | null; category: DocumentCategory | null; movement: TravelMovement | null; matchKeys: MatchKeys | null }` — replaces the inline object-shape return type duplicated three times in this file

- [ ] **Step 1: Write the failing test**

In `server/src/services/documents.test.ts`, add (alongside the existing
`resolveDocumentCategory` tests, same file, same `describe`-per-concern style):

```ts
import { describe, it, expect } from "vitest";
import { resolveDocumentCategory, parseExtractionResponse } from "./documents.js";
import type Anthropic from "@anthropic-ai/sdk";

// Minimal fake shaped like an Anthropic.Message — only the fields parseExtractionResponse
// actually reads (content, stop_reason) are populated; cast past the rest of the real SDK type's
// required fields, which don't matter for this pure parsing logic.
function fakeResponse(content: Anthropic.Message["content"], stopReason = "end_turn"): Anthropic.Message {
  return { content, stop_reason: stopReason } as unknown as Anthropic.Message;
}

describe("parseExtractionResponse — match keys", () => {
  it("extracts matchKeys when the model calls record_match_keys", () => {
    const response = fakeResponse([
      { type: "tool_use", id: "1", name: "name_document", input: { title: "Delta Boarding Pass", category: "travel" } },
      { type: "tool_use", id: "2", name: "record_match_keys", input: { referenceCode: "K4X9QP", flightNumber: "DL1234" } },
      { type: "text", text: "Boarding pass for DL1234." },
    ]);
    const result = parseExtractionResponse(response);
    expect(result.matchKeys).toEqual({ referenceCode: "K4X9QP", flightNumber: "DL1234" });
  });

  it("returns null matchKeys when the model doesn't call record_match_keys", () => {
    const response = fakeResponse([
      { type: "tool_use", id: "1", name: "name_document", input: { title: "Amazon Receipt", category: "receipts_bookings" } },
      { type: "text", text: "A receipt with no travel identifiers." },
    ]);
    const result = parseExtractionResponse(response);
    expect(result.matchKeys).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/services/documents.test.ts`
Expected: FAIL — `parseExtractionResponse` isn't exported yet, and `matchKeys` doesn't exist on
its return value.

- [ ] **Step 3: Add the tool schema**

In `server/src/services/documents.ts`, add the import and the new tool definition right after the
existing `TRAVEL_MOVEMENT_TOOL` constant:

```ts
import { validateTravelMovement, type TravelMovement } from "./travelValidation.js";
import { fetchPageText, type FetchFailureReason } from "./safeLinkFetcher.js";
import { type MatchKeys } from "./reconciliation.js";
```

```ts
// Optional — the model only calls this if the document contains an identifier actually worth
// indexing for later cross-referencing against email. Folded into the same extraction call as
// name_document/record_travel_movement, so this costs nothing extra — see
// docs/superpowers/specs/2026-08-24-document-email-cross-referencing-design.md.
const RECORD_MATCH_KEYS_TOOL: Anthropic.Tool = {
  name: "record_match_keys",
  description:
    "Call this only if the document contains a machine-checkable identifier worth cross-" +
    "referencing against email later — a booking/confirmation/reference code, a flight number, " +
    "or a clear vendor name with a specific date. Skip it entirely if none of these are actually " +
    "present and legible; never guess or invent one.",
  input_schema: {
    type: "object",
    properties: {
      referenceCode: { type: "string", description: "Booking/confirmation/reference code exactly as shown" },
      flightNumber: { type: "string", description: "e.g. DL1234" },
      vendor: { type: "string", description: "Airline/hotel/company name, e.g. Delta, Hilton" },
      eventDate: { type: "string", description: "ISO 8601 date, e.g. 2026-09-12" },
    },
  },
};
```

- [ ] **Step 4: Add the shared `ExtractionResult` type and update `parseExtractionResponse`**

Replace the three duplicated inline return-type shapes with one named interface, and export
`parseExtractionResponse`. In `server/src/services/documents.ts`:

```ts
// Pure on purpose, exported for its own unit tests — same reasoning as resolveDocumentCategory.
interface ExtractionResult {
  text: string;
  title: string | null;
  category: DocumentCategory | null;
  movement: TravelMovement | null;
  matchKeys: MatchKeys | null;
}

export function parseExtractionResponse(response: Anthropic.Message): ExtractionResult {
  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "record_travel_movement"
  );
  const nameUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "name_document"
  );
  const matchKeysUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "record_match_keys"
  );

  const nameInput = nameUse?.input as { title?: unknown; category?: unknown } | undefined;
  const rawTitle = nameInput?.title;
  const title =
    typeof rawTitle === "string" && rawTitle.trim()
      ? rawTitle.trim().slice(0, MAX_TITLE_LENGTH)
      : null;
  const category = resolveDocumentCategory(nameInput?.category);

  let text = textBlock?.text ?? "(couldn't extract any text from this file)";
  if (response.stop_reason === "max_tokens") {
    console.warn("documents: extraction hit max_tokens — output may be truncated");
    text += "\n\n(Note: this extraction was cut off before finishing — some details, possibly including dates, may be missing.)";
  }

  return {
    text,
    title,
    category,
    movement: toolUse ? (toolUse.input as TravelMovement) : null,
    matchKeys: matchKeysUse ? (matchKeysUse.input as MatchKeys) : null,
  };
}
```

- [ ] **Step 5: Update both callers' return-type annotations and tool arrays**

In `extractDocument`, change the return type annotation from the inline shape to `Promise<ExtractionResult>`, and add the new tool to the array:

```ts
async function extractDocument(buffer: Buffer, mimeType: string): Promise<ExtractionResult> {
```

```ts
    tools: [NAME_DOCUMENT_TOOL, TRAVEL_MOVEMENT_TOOL, RECORD_MATCH_KEYS_TOOL],
```

In `extractFactsFromLinkText`, the same two changes:

```ts
async function extractFactsFromLinkText(
  pageText: string,
  sourceUrl: string,
  uploadedAt: Date
): Promise<ExtractionResult> {
```

```ts
    tools: [NAME_DOCUMENT_TOOL, TRAVEL_MOVEMENT_TOOL, RECORD_MATCH_KEYS_TOOL],
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd server && npx vitest run src/services/documents.test.ts`
Expected: PASS (all existing `resolveDocumentCategory` tests plus the 2 new ones)

- [ ] **Step 7: Typecheck and run the full suite**

Run: `cd server && npx tsc --noEmit && npx vitest run`
Expected: clean typecheck, all tests pass. `ingestWhatsAppMedia`/`ingestWhatsAppLink` still
destructure only `{ text, title, category, movement }` from the extraction result at this point —
that's fine, `matchKeys` being unused there until Task 4 causes no error since it's just one more
property on the object, not a required destructure.

- [ ] **Step 8: Commit**

```bash
cd server
git add src/services/documents.ts src/services/documents.test.ts
git commit -m "Add record_match_keys extraction tool, extract ExtractionResult type"
```

---

## Task 4: Document → email direction

**Files:**
- Modify: `server/src/services/reconciliation.ts`
- Modify: `server/src/services/documents.ts`
- Test: `server/src/services/reconciliation.test.ts` (extend)

**Interfaces:**
- Consumes: `hubListMessages` from `../services/hub.js`; `saveMatchKeys` from `../db/store.js`
  (Task 1); `hasAlerted`, `markAlerted`, `listPhoneNumbersForUser` from `../db/store.js`;
  `sendWhatsAppMessage`, `isWhatsAppConfigured` from `../providers/whatsapp.js`; `type
  UnifiedMessage` from `../providers/types.js`
- Produces: `checkDocumentAgainstRecentEmails(ownerId: number, documentId: number, docTitle: string, keys: MatchKeys): Promise<void>`

- [ ] **Step 1: Write the failing test**

**Replace** the two existing lines at the very top of `server/src/services/reconciliation.test.ts`
(`import { describe, it, expect } from "vitest";` and
`import { matchTier, buildMatchNotification, type MatchKeys } from "./reconciliation.js";`) with
the block below. `MatchKeys` stays a normal static type-only import (erased at compile time, so it
doesn't collide with anything); the value imports become dynamic because `vi.mock` must be called
before the mocked modules — or anything that transitively imports them, like
`reconciliation.js` — are loaded:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MatchKeys } from "./reconciliation.js";

vi.mock("../providers/whatsapp.js", () => ({
  sendWhatsAppMessage: vi.fn(),
  isWhatsAppConfigured: vi.fn().mockReturnValue(true),
}));

const mockHubListMessages = vi.fn();
vi.mock("./hub.js", () => ({
  hubListMessages: (...args: unknown[]) => mockHubListMessages(...args),
}));

const { sendWhatsAppMessage } = await import("../providers/whatsapp.js");
const { findOrCreateUserByEmail, saveDocument, addPhoneNumberForUser } = await import("../db/store.js");
const { matchTier, buildMatchNotification, checkDocumentAgainstRecentEmails } = await import(
  "./reconciliation.js"
);

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

// All test files share one SQLite database for the whole `vitest run` (see test/setup.ts), and
// user_phone_numbers.phone is UNIQUE — so phone numbers need a prefix no other test file uses,
// not just uniqueness within this file. Existing files already claim "44700000" and "44700001"
// (see pendingRegistration.test.ts / whatsappRegistration.test.ts) — this file uses "44700002".
function freshPhone(): string {
  counter += 1;
  return `44700002${String(counter).padStart(4, "0")}`;
}

function fakeMessage(overrides: Partial<{ id: string; accountId: number; subject: string; snippet: string }>) {
  return {
    id: "msg-1",
    accountId: 1,
    accountEmail: "test@example.com",
    provider: "google" as const,
    subject: "",
    from: "airline@delta.com",
    snippet: "",
    receivedAt: new Date().toISOString(),
    unread: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(sendWhatsAppMessage).mockClear();
  mockHubListMessages.mockReset();
});

describe("checkDocumentAgainstRecentEmails", () => {
  it("notifies when a recent email's subject contains the document's reference code", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("doc-to-email"));
    const phoneNumber = freshPhone();
    addPhoneNumberForUser(user.id, phoneNumber);
    const doc = saveDocument(user.id, {
      phone: phoneNumber,
      filename: null,
      mimeType: "image/jpeg",
      storedPath: "/tmp/fake",
      caption: null,
      title: "Delta Boarding Pass",
      extractedText: "text",
      category: "travel",
    });
    mockHubListMessages.mockResolvedValue([
      fakeMessage({ id: "m1", subject: "Update on ref K4X9QP" }),
    ]);

    await checkDocumentAgainstRecentEmails(user.id, doc.id, doc.title!, { referenceCode: "K4X9QP" });

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    const [phone, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(phone).toBe(phoneNumber);
    expect(text).toContain("Delta Boarding Pass");
  });

  it("does not notify when no recent email matches", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("doc-to-email-nomatch"));
    const phoneNumber = freshPhone();
    addPhoneNumberForUser(user.id, phoneNumber);
    const doc = saveDocument(user.id, {
      phone: phoneNumber,
      filename: null,
      mimeType: "image/jpeg",
      storedPath: "/tmp/fake",
      caption: null,
      title: "Delta Boarding Pass",
      extractedText: "text",
      category: "travel",
    });
    mockHubListMessages.mockResolvedValue([fakeMessage({ id: "m2", subject: "Your Amazon order shipped" })]);

    await checkDocumentAgainstRecentEmails(user.id, doc.id, doc.title!, { referenceCode: "K4X9QP" });

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it("does not notify twice for the same document/email pair", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("doc-to-email-dedup"));
    const phoneNumber = freshPhone();
    addPhoneNumberForUser(user.id, phoneNumber);
    const doc = saveDocument(user.id, {
      phone: phoneNumber,
      filename: null,
      mimeType: "image/jpeg",
      storedPath: "/tmp/fake",
      caption: null,
      title: "Delta Boarding Pass",
      extractedText: "text",
      category: "travel",
    });
    mockHubListMessages.mockResolvedValue([fakeMessage({ id: "m3", subject: "Update on ref K4X9QP" })]);

    await checkDocumentAgainstRecentEmails(user.id, doc.id, doc.title!, { referenceCode: "K4X9QP" });
    await checkDocumentAgainstRecentEmails(user.id, doc.id, doc.title!, { referenceCode: "K4X9QP" });

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
  });

  it("does nothing and never calls hubListMessages when there is no reference code or flight number", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("doc-to-email-nokeys"));
    const doc = saveDocument(user.id, {
      phone: freshPhone(),
      filename: null,
      mimeType: "image/jpeg",
      storedPath: "/tmp/fake",
      caption: null,
      title: "Vendor Only Doc",
      extractedText: "text",
      category: "travel",
    });

    await checkDocumentAgainstRecentEmails(user.id, doc.id, doc.title!, { vendor: "Delta" });

    expect(mockHubListMessages).not.toHaveBeenCalled();
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });
});
```

Note: `matchTier` and `buildMatchNotification` are re-imported here (not re-tested) only because
this file now has one `vi.mock` block at the top that must precede all imports — Vitest hoists
`vi.mock` calls, so the existing Task 2 tests further down in the same file continue working
unchanged.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/services/reconciliation.test.ts`
Expected: FAIL — `checkDocumentAgainstRecentEmails` is not exported yet.

- [ ] **Step 3: Implement `checkDocumentAgainstRecentEmails`**

Add to `server/src/services/reconciliation.ts`:

```ts
import { hubListMessages } from "./hub.js";
import { sendWhatsAppMessage, isWhatsAppConfigured } from "../providers/whatsapp.js";
import { hasAlerted, markAlerted, listPhoneNumbersForUser } from "../db/store.js";
import type { UnifiedMessage } from "../providers/types.js";

const MAX_MATCH_NOTIFICATIONS_PER_RUN = 3;

async function notifyMatch(ownerId: number, text: string): Promise<void> {
  if (!isWhatsAppConfigured()) return;
  const numbers = listPhoneNumbersForUser(ownerId).map((r) => r.phone);
  for (const number of numbers) {
    try {
      await sendWhatsAppMessage(number, text);
    } catch (err) {
      console.error("reconciliation: failed to send match notification", err);
    }
  }
}

// Runs synchronously right after a document saves (see documents.ts) — checks the new
// document's own identifiers against a bounded window of recent mail. No LLM call: a reference
// code or flight number is specific enough that finding it verbatim in a subject/snippet is
// already a strong match.
export async function checkDocumentAgainstRecentEmails(
  ownerId: number,
  documentId: number,
  docTitle: string,
  keys: MatchKeys
): Promise<void> {
  if (!keys.referenceCode && !keys.flightNumber) return; // nothing strong-tier-checkable in v1

  let messages: UnifiedMessage[];
  try {
    messages = await hubListMessages(ownerId, { limit: 50 });
  } catch (err) {
    console.error(`reconciliation: failed to list messages for owner ${ownerId}`, err);
    return;
  }

  let sent = 0;
  for (const m of messages) {
    if (sent >= MAX_MATCH_NOTIFICATIONS_PER_RUN) break;

    const text = `${m.subject} ${m.snippet}`;
    if (matchTier(keys, text) !== "strong") continue;

    const matchKey = `recon-match:${documentId}:${m.accountId}:${m.id}`;
    if (hasAlerted(ownerId, matchKey)) continue;

    await notifyMatch(ownerId, buildMatchNotification(docTitle, keys));
    markAlerted(ownerId, matchKey);
    sent += 1;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/services/reconciliation.test.ts`
Expected: PASS (13 tests: the 9 from Task 2 plus these 4)

- [ ] **Step 5: Wire into `documents.ts`**

In `server/src/services/documents.ts`, update the import from `./reconciliation.js`:

```ts
import { checkDocumentAgainstRecentEmails, type MatchKeys } from "./reconciliation.js";
```

and add `saveMatchKeys` to the existing `../db/store.js` import block:

```ts
import {
  saveDocument,
  saveCheckin,
  saveMatchKeys,
  uploadsDir,
  DOCUMENT_CATEGORIES,
  type DocumentRow,
  type DocumentCategory,
} from "../db/store.js";
```

In `ingestWhatsAppMedia`, destructure `matchKeys` too and add the new step right before
`return doc;`:

```ts
  const {
    text: extractedText,
    title,
    category,
    movement,
    matchKeys,
  } = canAnalyze
    ? await extractDocument(buffer, mimeType)
    : {
        text: `(file type ${mimeType} isn't supported for automatic analysis — stored for download only)`,
        title: null,
        category: null,
        movement: null,
        matchKeys: null,
      };
```

```ts
  if (matchKeys) {
    saveMatchKeys(params.ownerId, doc.id, matchKeys);
    // Fire-and-forget: this must never delay the "document saved" confirmation the user is
    // waiting on. Any match notification arrives as a separate follow-up message.
    void checkDocumentAgainstRecentEmails(params.ownerId, doc.id, doc.title ?? "a saved document", matchKeys).catch(
      (err) => console.error("documents: reconciliation check failed", err)
    );
  }

  return doc;
}
```

Make the identical two changes in `ingestWhatsAppLink` (destructure `matchKeys` from
`extractFactsFromLinkText`'s result, and add the same `if (matchKeys) { ... }` block right before
its `return { ok: true, doc };`).

- [ ] **Step 6: Typecheck and run the full suite**

Run: `cd server && npx tsc --noEmit && npx vitest run`
Expected: clean typecheck, all tests pass (including the existing `documents.test.ts` and
`reconciliation.test.ts` suites).

- [ ] **Step 7: Commit**

```bash
cd server
git add src/services/reconciliation.ts src/services/reconciliation.test.ts src/services/documents.ts
git commit -m "Add document-to-email reconciliation direction, wire into document ingestion"
```

---

## Task 5: Email → document direction, wired into the scheduler

**Files:**
- Modify: `server/src/services/reconciliation.ts`
- Modify: `server/src/services/scheduler.ts`
- Test: `server/src/services/reconciliation.test.ts` (extend)

**Interfaces:**
- Consumes: `listRecentMatchKeys` from `../db/store.js` (Task 1); `notifyMatch` (private helper
  already defined in `reconciliation.ts` by Task 4 — no new import needed, same module)
- Produces: `checkNewEmailsAgainstRecentDocuments(ownerId: number): Promise<void>`

Note: this reuses Task 4's `notifyMatch(ownerId, text)` helper as-is (it already checks
`isWhatsAppConfigured` and loops over the user's numbers with per-number error swallowing) rather
than introducing a second, near-identical send path — no changes to `alerts.ts` needed.

- [ ] **Step 1: Write the failing test**

First, extend Task 4's top-level dynamic-import block (near the top of
`reconciliation.test.ts`) to also pull in `hasAlerted` and `saveMatchKeys`, rather than
re-importing the same already-imported module a second time further down:

```ts
const { findOrCreateUserByEmail, saveDocument, addPhoneNumberForUser, hasAlerted, saveMatchKeys } =
  await import("../db/store.js");
```

Then add the new tests (the `hub.js` and `whatsapp.js` mocks from Task 4 already cover what this
needs):

```ts
const { checkNewEmailsAgainstRecentDocuments } = await import("./reconciliation.js");

describe("checkNewEmailsAgainstRecentDocuments", () => {
  it("notifies when a new email's subject contains a recent document's reference code", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("email-to-doc"));
    const phoneNumber = freshPhone();
    addPhoneNumberForUser(user.id, phoneNumber);
    const doc = saveDocument(user.id, {
      phone: phoneNumber,
      filename: null,
      mimeType: "image/jpeg",
      storedPath: "/tmp/fake",
      caption: null,
      title: "Hilton Booking",
      extractedText: "text",
      category: "receipts_bookings",
    });
    saveMatchKeys(user.id, doc.id, { referenceCode: "H9ZZ21" });

    mockHubListMessages.mockResolvedValue([fakeMessage({ id: "m10", subject: "Change to booking H9ZZ21" })]);

    await checkNewEmailsAgainstRecentDocuments(user.id);

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    const [, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(text).toContain("Hilton Booking");
  });

  it("only scans each email once across repeated ticks, regardless of match outcome", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("email-to-doc-scan-once"));
    mockHubListMessages.mockResolvedValue([fakeMessage({ id: "m11", subject: "Nothing relevant here" })]);

    await checkNewEmailsAgainstRecentDocuments(user.id);
    await checkNewEmailsAgainstRecentDocuments(user.id);

    expect(hasAlerted(user.id, "recon-scan:1:m11")).toBe(true);
    // No crash, no duplicate work observable from the outside — the real assertion is that a
    // second identical tick doesn't re-notify, covered by the dedup test below with an actual match.
  });

  it("does not notify twice for the same email/document pair across ticks", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("email-to-doc-dedup"));
    const phoneNumber = freshPhone();
    addPhoneNumberForUser(user.id, phoneNumber);
    const doc = saveDocument(user.id, {
      phone: phoneNumber,
      filename: null,
      mimeType: "image/jpeg",
      storedPath: "/tmp/fake",
      caption: null,
      title: "Hilton Booking",
      extractedText: "text",
      category: "receipts_bookings",
    });
    saveMatchKeys(user.id, doc.id, { referenceCode: "H9ZZ22" });
    mockHubListMessages.mockResolvedValue([fakeMessage({ id: "m12", subject: "Change to booking H9ZZ22" })]);

    await checkNewEmailsAgainstRecentDocuments(user.id);
    mockHubListMessages.mockResolvedValue([fakeMessage({ id: "m12", subject: "Change to booking H9ZZ22" })]);
    await checkNewEmailsAgainstRecentDocuments(user.id);

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/services/reconciliation.test.ts`
Expected: FAIL — `checkNewEmailsAgainstRecentDocuments` is not exported yet.

- [ ] **Step 3: Implement `checkNewEmailsAgainstRecentDocuments`**

Add to `server/src/services/reconciliation.ts`:

```ts
import { hasAlerted, markAlerted, listPhoneNumbersForUser, listRecentMatchKeys } from "../db/store.js";
```

(Merge this into the existing `../db/store.js` import from Task 4 rather than a second import
line for the same module — `listRecentMatchKeys` is the only genuinely new name; `hasAlerted`,
`markAlerted`, and `listPhoneNumbersForUser` are already imported there. No import from
`alerts.ts` is needed — `notifyMatch` is a private helper already defined in this same file by
Task 4.)

```ts
const RECENT_DOCUMENT_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_MATCH_NOTIFICATIONS_PER_TICK = 5;

function scanKey(m: UnifiedMessage): string {
  return `recon-scan:${m.accountId}:${m.id}`;
}

// Runs on the existing 5-minute scheduler tick (scheduler.ts), sibling to
// checkForNewImportantMessages — but deliberately unfiltered by AUTOMATED_SENDER_PATTERN, since
// an automated airline/vendor notice is exactly what this is meant to catch.
export async function checkNewEmailsAgainstRecentDocuments(ownerId: number): Promise<void> {
  let messages: UnifiedMessage[];
  try {
    messages = await hubListMessages(ownerId, { limit: 50 });
  } catch (err) {
    console.error(`reconciliation: failed to list messages for owner ${ownerId}`, err);
    return;
  }

  const unscanned = messages.filter((m) => !hasAlerted(ownerId, scanKey(m)));
  if (unscanned.length === 0) return;

  const recentKeys = listRecentMatchKeys(ownerId, Date.now() - RECENT_DOCUMENT_WINDOW_MS);

  let sent = 0;
  for (const m of unscanned) {
    // Mark scanned regardless of match outcome — an email that didn't match this tick never
    // needs re-checking on a later tick, whether or not it matched anything.
    markAlerted(ownerId, scanKey(m));

    if (sent >= MAX_MATCH_NOTIFICATIONS_PER_TICK || recentKeys.length === 0) continue;

    const text = `${m.subject} ${m.snippet}`;
    for (const row of recentKeys) {
      const keys: MatchKeys = {
        referenceCode: row.referenceCode ?? undefined,
        flightNumber: row.flightNumber ?? undefined,
        vendor: row.vendor ?? undefined,
        eventDate: row.eventDate ?? undefined,
      };
      if (matchTier(keys, text) !== "strong") continue;

      const matchKey = `recon-match:${row.documentId}:${m.accountId}:${m.id}`;
      if (hasAlerted(ownerId, matchKey)) continue;

      await notifyMatch(ownerId, buildMatchNotification(row.docTitle ?? "a saved document", keys));
      markAlerted(ownerId, matchKey);
      sent += 1;
      break; // one matching document is enough for this email
    }
  }
}
```

`notifyMatch` is the private helper Task 4 already defined earlier in this same file — it already
checks `isWhatsAppConfigured()` and loops over `listPhoneNumbersForUser(ownerId)` with per-number
error swallowing, so nothing further is needed here.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/services/reconciliation.test.ts`
Expected: PASS (16 tests total)

- [ ] **Step 5: Wire into `scheduler.ts`**

In `server/src/services/scheduler.ts`, add the import:

```ts
import { checkNewEmailsAgainstRecentDocuments } from "./reconciliation.js";
```

Add a new wrapper function, right after the existing `runAlertsCheckForUser`:

```ts
async function runReconciliationCheckForUser(ownerId: number): Promise<void> {
  try {
    await checkNewEmailsAgainstRecentDocuments(ownerId);
  } catch (err) {
    console.error(`scheduler: reconciliation check failed for user ${ownerId}`, err);
  }
}
```

Add the call inside `tick()`, alongside the other two:

```ts
async function tick(): Promise<void> {
  for (const ownerId of listAllUserIds()) {
    await runDailyCheckForUser(ownerId).catch((err) =>
      console.error(`scheduler: daily check failed for user ${ownerId}`, err)
    );
    await runAlertsCheckForUser(ownerId).catch((err) =>
      console.error(`scheduler: alerts check failed for user ${ownerId}`, err)
    );
    await runReconciliationCheckForUser(ownerId).catch((err) =>
      console.error(`scheduler: reconciliation check failed for user ${ownerId}`, err)
    );
  }
}
```

(The wrapper's own internal try/catch already prevents a thrown error from escaping — the outer
`.catch` here matches the existing belt-and-braces style already used for the other two calls.)

- [ ] **Step 6: Typecheck and run the full suite**

Run: `cd server && npx tsc --noEmit && npx vitest run`
Expected: clean typecheck, all tests pass.

- [ ] **Step 7: Commit**

```bash
cd server
git add src/services/reconciliation.ts src/services/reconciliation.test.ts src/services/scheduler.ts
git commit -m "Add email-to-document reconciliation direction, wire into scheduler tick"
```

---

## Task 6: Manual end-to-end verification

**Files:** none (verification only, no code changes)

This exercises the one thing the mocked tests in Tasks 4–5 can't: the real `hubListMessages` call
against a real connected account, and the real WhatsApp send. Matches the verification style
already used for `safeLinkFetcher.ts` and `ingestWhatsAppLink` — a real run, checked by hand, then
cleaned up. Requires a dev environment with `ANTHROPIC_API_KEY`, a connected Google/Microsoft
account, and (for the WhatsApp send half) `WHATSAPP_TOKEN`/`WHATSAPP_PHONE_NUMBER_ID`/
`WHATSAPP_VERIFY_TOKEN` configured — if WhatsApp isn't configured in this environment, verify
through steps 1–3 below and confirm the log line in step 4 instead of an actual message arriving.

- [ ] **Step 1: Send yourself (or the connected test account) a real email containing a distinctive fake reference code**

Subject line: `Test booking update REF-TESTCODE99`. This must land in the inbox of whichever
account is connected to the dev server's test user before step 3 runs.

- [ ] **Step 2: Save a test document whose extraction will plausibly surface a matching code**

Send a WhatsApp message with a photo/PDF to the dev server's WhatsApp number containing the text
"REF-TESTCODE99" somewhere visible (a plain text screenshot works fine) — or, faster, temporarily
hardcode `REF-TESTCODE99` into a test image's extracted text via a quick manual call to
`ingestWhatsAppMedia`/`ingestWhatsAppLink` in a throwaway script (same pattern as the
`_e2e_link_test.mjs` used to verify `ingestWhatsAppLink` originally — write it, run it with
`npx tsx`, delete it after).

- [ ] **Step 3: Confirm the document→email direction fires immediately**

Within a few seconds of the document saving, a WhatsApp message should arrive: "📎 Heads up — an
email about ... (REF-TESTCODE99...) just came in. Worth a look?" If `WHATSAPP_TOKEN` isn't
configured in this dev environment, confirm instead that `checkDocumentAgainstRecentEmails` ran
without throwing (no `"documents: reconciliation check failed"` line in the server log).

- [ ] **Step 4: Confirm the email→document direction fires on the next scheduler tick**

Delete the `document_match_keys` row and the `recon-match:`/`recon-scan:` ledger entries created
in step 3 (so the pair looks unmatched again), wait for the next 5-minute tick (or temporarily
lower `CHECK_INTERVAL_MS` in `scheduler.ts` for this test run only, reverting after), and confirm
the same notification fires via the email→document path this time.

- [ ] **Step 5: Confirm no duplicate notification on a second tick**

Wait for one more tick (or trigger `tick()` manually) and confirm no second WhatsApp message
arrives for the same pair — the dedup ledger should have already caught it.

- [ ] **Step 6: Clean up test data**

Delete the test document (via the Files page or `deleteDocument`), the test email (if desired),
and confirm no leftover `document_match_keys`/`alerted_messages` rows reference data that no
longer exists (harmless if left — they're just inert ledger rows — but tidy is better for a shared
dev database).

---

## Self-Review Notes

- **Spec coverage:** extraction tool (Task 3) ✓, storage (Task 1) ✓, dedup via existing
  `alerted_messages` ledger (Tasks 4–5, no new table) ✓, document→email direction (Task 4) ✓,
  email→document direction (Task 5) ✓, deterministic template-only notification (Task 2) ✓, error
  handling for missing `matchKeys`/failed `hubListMessages` (Tasks 3–5) ✓, weak tier explicitly
  NOT built (Task 2's `matchTier` returns only `"strong" | null`) ✓, no backfill (not implemented
  anywhere in this plan) ✓.
- **Type consistency check:** `MatchKeys` is defined once in `reconciliation.ts` (Task 2) and
  imported everywhere else that needs it (`documents.ts` in Task 3, `store.ts`'s
  `DocumentMatchKeysRow` stays a separate, structurally-compatible type since DB nulls need
  explicit `?? undefined` conversion before use as `MatchKeys` — done explicitly in Task 5's
  `checkNewEmailsAgainstRecentDocuments`, not left implicit). `ExtractionResult` (Task 3) is used
  consistently as the return type for both `extractDocument` and `extractFactsFromLinkText`,
  replacing three previously-duplicated inline shapes.
- **No placeholders:** every step above has real, complete code — no "add error handling here" or
  "similar to Task N" shortcuts.
