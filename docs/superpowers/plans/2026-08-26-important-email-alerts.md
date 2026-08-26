# Proactive Important-Email Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Proactively classify automated/transactional mail (flight changes, invoices, government
mail, deliveries, security alerts, subscription renewals, refund/dispute updates, and new
reservation confirmations) into a fixed 8-category allow-list and push a WhatsApp alert — closing
the gap where `alerts.ts` only watches real people and `reconciliation.ts` only matches mail
against a document the user already saved.

**Architecture:** A new scheduler tick (`server/src/services/importantEmailAlerts.ts`) filters each
user's unread mail down to automated senders, sends the unscanned ones to a new batched Haiku
classifier (`server/src/services/importantEmailClassifier.ts`) in one call per tick, and pushes a
WhatsApp alert for each confident match via the existing send/dedupe-ledger plumbing. A new
settings pair (default **on**, unlike the existing real-time alert) gates it per user.

**Tech Stack:** TypeScript, Express, `better-sqlite3` (via `server/src/db/store.ts`), Anthropic SDK
(`@anthropic-ai/sdk`), Vitest + Supertest, React (client toggle only, no new client test infra —
none exists in this repo).

**Spec:** `docs/superpowers/specs/2026-08-26-important-email-alerts-design.md`

## Global Constraints

- Exactly these 8 category keys, in this order, nowhere else:
  `flight_change`, `reservation_confirmed`, `invoice_due`, `government_mail`,
  `delivery_notification`, `security_alert`, `subscription_renewal`, `refund_dispute`.
- Dedupe ledger key prefix is `important-email:` (e.g. `` `important-email:${accountId}:${id}` ``)
  — never the bare `${accountId}:${id}` shape `alerts.ts` uses on the same table.
- Baseline setting key is `important_email_baseline_set`, boolean-as-string `"true"`, exact same
  shape as `alerts.ts`'s `BASELINE_KEY`.
- Enable/disable setting key is `important_email_alerts_enabled`. Checked as
  **`getSetting(...) !== "false"`** (default **on**) — the deliberate inverse of
  `realtime_alerts_enabled`'s `=== "true"` (default off). Never "fix" this to match the other
  toggle.
- `MAX_ALERTS_PER_CHECK = 5`, same value and same "...and N more — check your inbox." overflow
  copy style as `alerts.ts`.
- Classifier model: `process.env.ASSISTANT_MODEL_SIMPLE ?? "claude-haiku-4-5"`, one call per user
  per tick, subject + snippet only (never full body).
- No unit test anywhere mocks the Anthropic SDK (no precedent in this codebase) — the
  classification network call itself is verified manually (Task 7), not by an automated test.

---

### Task 1: Important-email categories and classifier

**Files:**
- Create: `server/src/services/importantEmailClassifier.ts`
- Test: `server/src/services/importantEmailClassifier.test.ts`

**Interfaces:**
- Produces (used by Task 2):
  - `export const IMPORTANT_EMAIL_CATEGORIES: readonly string[]` — the 8 keys, in the fixed order
    above.
  - `export type ImportantEmailCategory = (typeof IMPORTANT_EMAIL_CATEGORIES)[number]`
  - `export const CATEGORY_INFO: Record<ImportantEmailCategory, { emoji: string; label: string; description: string }>`
  - `export interface ClassifyCandidate { index: number; subject: string; snippet: string }`
  - `export function classifyImportantEmails(candidates: ClassifyCandidate[]): Promise<Map<number, ImportantEmailCategory>>`

- [ ] **Step 1: Write the failing test file**

```ts
// server/src/services/importantEmailClassifier.test.ts
import { describe, it, expect } from "vitest";
import {
  IMPORTANT_EMAIL_CATEGORIES,
  CATEGORY_INFO,
  buildClassifyPrompt,
  parseClassifyMatches,
} from "./importantEmailClassifier.js";

describe("IMPORTANT_EMAIL_CATEGORIES / CATEGORY_INFO", () => {
  it("has exactly the 8 categories from the spec, in order", () => {
    expect(IMPORTANT_EMAIL_CATEGORIES).toEqual([
      "flight_change",
      "reservation_confirmed",
      "invoice_due",
      "government_mail",
      "delivery_notification",
      "security_alert",
      "subscription_renewal",
      "refund_dispute",
    ]);
  });

  it("has a complete, non-empty emoji/label/description for every category", () => {
    for (const category of IMPORTANT_EMAIL_CATEGORIES) {
      const info = CATEGORY_INFO[category as keyof typeof CATEGORY_INFO];
      expect(info).toBeDefined();
      expect(info.emoji.length).toBeGreaterThan(0);
      expect(info.label.length).toBeGreaterThan(0);
      expect(info.description.length).toBeGreaterThan(0);
    }
  });
});

describe("buildClassifyPrompt", () => {
  it("includes every category key and description", () => {
    const prompt = buildClassifyPrompt([]);
    for (const category of IMPORTANT_EMAIL_CATEGORIES) {
      expect(prompt).toContain(category);
      expect(prompt).toContain(CATEGORY_INFO[category as keyof typeof CATEGORY_INFO].description);
    }
  });

  it("includes each candidate's index, subject, and snippet", () => {
    const prompt = buildClassifyPrompt([
      { index: 0, subject: "Your flight changed", snippet: "Gate moved to B12" },
      { index: 1, subject: "Invoice #4471", snippet: "£120 due 1 Sep" },
    ]);
    expect(prompt).toContain("[0]");
    expect(prompt).toContain("Your flight changed");
    expect(prompt).toContain("Gate moved to B12");
    expect(prompt).toContain("[1]");
    expect(prompt).toContain("Invoice #4471");
    expect(prompt).toContain("£120 due 1 Sep");
  });
});

describe("parseClassifyMatches", () => {
  it("returns a Map of index to category for well-formed matches", () => {
    const result = parseClassifyMatches([
      { index: 0, category: "flight_change" },
      { index: 2, category: "invoice_due" },
    ]);
    expect(result).toEqual(
      new Map([
        [0, "flight_change"],
        [2, "invoice_due"],
      ])
    );
  });

  it("skips entries with an unknown category", () => {
    const result = parseClassifyMatches([{ index: 0, category: "not_a_real_category" }]);
    expect(result.size).toBe(0);
  });

  it("skips entries with a non-numeric index", () => {
    const result = parseClassifyMatches([{ index: "zero", category: "flight_change" }]);
    expect(result.size).toBe(0);
  });

  it("returns an empty Map for non-array input", () => {
    expect(parseClassifyMatches(undefined).size).toBe(0);
    expect(parseClassifyMatches(null).size).toBe(0);
    expect(parseClassifyMatches("nope").size).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run src/services/importantEmailClassifier.test.ts`
Expected: FAIL — `importantEmailClassifier.ts` doesn't exist yet (`Cannot find module`).

- [ ] **Step 3: Write the implementation**

```ts
// server/src/services/importantEmailClassifier.ts
// Classifies automated/transactional mail into a fixed category set that neither
// checkForNewImportantMessages (alerts.ts, real people only) nor
// checkNewEmailsAgainstRecentDocuments (reconciliation.ts, requires an already-saved document)
// can catch. See docs/superpowers/specs/2026-08-26-important-email-alerts-design.md.

import Anthropic from "@anthropic-ai/sdk";

export const IMPORTANT_EMAIL_CATEGORIES = [
  "flight_change",
  "reservation_confirmed",
  "invoice_due",
  "government_mail",
  "delivery_notification",
  "security_alert",
  "subscription_renewal",
  "refund_dispute",
] as const;

export type ImportantEmailCategory = (typeof IMPORTANT_EMAIL_CATEGORIES)[number];

export const CATEGORY_INFO: Record<
  ImportantEmailCategory,
  { emoji: string; label: string; description: string }
> = {
  flight_change: {
    emoji: "✈️",
    label: "Flight change",
    description: "A flight or reservation change, delay, or cancellation notice.",
  },
  reservation_confirmed: {
    emoji: "✅",
    label: "Reservation confirmed",
    description: "A new reservation confirmation (flight, hotel, car rental, restaurant, etc.).",
  },
  invoice_due: {
    emoji: "💳",
    label: "Invoice/payment due",
    description: "An invoice or payment that is due or overdue.",
  },
  government_mail: {
    emoji: "🏛️",
    label: "Government correspondence",
    description: "Correspondence from a government agency (tax, benefits, visa, license, etc.).",
  },
  delivery_notification: {
    emoji: "📦",
    label: "Delivery notice",
    description: "A package delivery notice: out for delivery, delayed, or a delivery exception.",
  },
  security_alert: {
    emoji: "🔐",
    label: "Security alert",
    description: "A security or account alert: new sign-in, password changed, suspicious activity.",
  },
  subscription_renewal: {
    emoji: "🔁",
    label: "Subscription renewal",
    description: "An upcoming subscription auto-renewal charge, or notice of a price increase.",
  },
  refund_dispute: {
    emoji: "💰",
    label: "Refund/dispute update",
    description: "A status update on a refund, chargeback, or dispute already in progress.",
  },
};

export interface ClassifyCandidate {
  index: number;
  subject: string;
  snippet: string;
}

// Pure — builds the prompt text from candidates and the fixed category list. Split out from
// classifyImportantEmails so it's unit-testable without an API call.
export function buildClassifyPrompt(candidates: ClassifyCandidate[]): string {
  const categoryList = IMPORTANT_EMAIL_CATEGORIES.map(
    (c) => `- ${c}: ${CATEGORY_INFO[c].description}`
  ).join("\n");
  const emailList = candidates
    .map((c) => `[${c.index}] Subject: ${c.subject}\nSnippet: ${c.snippet}`)
    .join("\n\n");
  return (
    `Categories:\n${categoryList}\n\n` +
    "For each numbered email below, decide whether it clearly falls into exactly one of these " +
    "categories. Only include emails that are a clear, confident match — skip anything " +
    "ambiguous, promotional, or a generic automated notice that isn't one of these categories " +
    "(newsletters, marketing, app notifications with no action needed). Omit indices that don't " +
    `match.\n\n${emailList}`
  );
}

// Pure — turns the tool call's raw `matches` input into a validated Map, dropping anything
// malformed rather than throwing (an LLM tool call is not a type-checked boundary).
export function parseClassifyMatches(matches: unknown): Map<number, ImportantEmailCategory> {
  const result = new Map<number, ImportantEmailCategory>();
  if (!Array.isArray(matches)) return result;
  for (const entry of matches) {
    if (
      entry &&
      typeof entry === "object" &&
      typeof (entry as { index?: unknown }).index === "number" &&
      (IMPORTANT_EMAIL_CATEGORIES as readonly string[]).includes(
        (entry as { category?: unknown }).category as string
      )
    ) {
      result.set(
        (entry as { index: number }).index,
        (entry as { category: ImportantEmailCategory }).category
      );
    }
  }
  return result;
}

const CLASSIFY_MODEL = process.env.ASSISTANT_MODEL_SIMPLE ?? "claude-haiku-4-5";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

const CLASSIFY_TOOL: Anthropic.Tool = {
  name: "classify_messages",
  description:
    "Report which of the numbered emails above (if any) match one of the given categories. " +
    "Omit any index that isn't a clear, confident match.",
  input_schema: {
    type: "object",
    properties: {
      matches: {
        type: "array",
        items: {
          type: "object",
          properties: {
            index: { type: "number", description: "The email's number from the list above" },
            category: { type: "string", enum: [...IMPORTANT_EMAIL_CATEGORIES] },
          },
          required: ["index", "category"],
        },
      },
    },
    required: ["matches"],
  },
};

// Not unit-tested directly — this repo has no precedent for mocking the Anthropic SDK, same as
// documents.ts's extraction call. Verified manually (see plan Task 7).
export async function classifyImportantEmails(
  candidates: ClassifyCandidate[]
): Promise<Map<number, ImportantEmailCategory>> {
  if (candidates.length === 0) return new Map();

  const response = await getClient().messages.create({
    model: CLASSIFY_MODEL,
    max_tokens: 1024,
    tools: [CLASSIFY_TOOL],
    tool_choice: { type: "tool", name: "classify_messages" },
    messages: [{ role: "user", content: buildClassifyPrompt(candidates) }],
  });

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "classify_messages"
  );
  return parseClassifyMatches((toolUse?.input as { matches?: unknown } | undefined)?.matches);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx vitest run src/services/importantEmailClassifier.test.ts`
Expected: PASS, all cases green.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/importantEmailClassifier.ts server/src/services/importantEmailClassifier.test.ts
git commit -m "Add important-email category classifier"
```

---

### Task 2: `importantEmailAlerts.ts` core service

**Files:**
- Create: `server/src/services/importantEmailAlerts.ts`
- Test: `server/src/services/importantEmailAlerts.test.ts`

**Interfaces:**
- Consumes (from Task 1): `classifyImportantEmails(candidates: ClassifyCandidate[]): Promise<Map<number, ImportantEmailCategory>>`, `CATEGORY_INFO`, `type ImportantEmailCategory`.
- Consumes (existing): `hubListMessages(ownerId, {limit}): Promise<UnifiedMessage[]>` and `AUTOMATED_SENDER_PATTERN: RegExp` from `./hub.js`; `hasAlerted(ownerId, key): boolean`, `markAlerted(ownerId, key): void`, `getSetting(ownerId, key): string | null`, `setSetting(ownerId, key, value): void`, `listPhoneNumbersForUser(ownerId): {phone: string}[]` from `../db/store.js`; `sendWhatsAppMessage(phone, text): Promise<void>`, `isWhatsAppConfigured(): boolean` from `../providers/whatsapp.js`.
- Produces (used by Task 4): `export function checkForImportantEmails(ownerId: number): Promise<void>`.
- Produces (test-only, also usable by UI copy later): `export function formatImportantEmailAlert(m: UnifiedMessage, category: ImportantEmailCategory): string`.

- [ ] **Step 1: Write the failing test file**

```ts
// server/src/services/importantEmailAlerts.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../providers/whatsapp.js", () => ({
  sendWhatsAppMessage: vi.fn(),
  isWhatsAppConfigured: vi.fn().mockReturnValue(true),
}));

const mockHubListMessages = vi.fn();
vi.mock("./hub.js", () => ({
  hubListMessages: (...args: unknown[]) => mockHubListMessages(...args),
  // Real pattern, copied from hub.ts — the filter under test relies on it matching for real.
  AUTOMATED_SENDER_PATTERN:
    /no-?reply|notifications?@|newsletter|updates?@|do-?not-?reply|automated|mailer-daemon/i,
}));

const mockClassify = vi.fn();
vi.mock("./importantEmailClassifier.js", () => ({
  classifyImportantEmails: (...args: unknown[]) => mockClassify(...args),
  CATEGORY_INFO: {
    flight_change: { emoji: "✈️", label: "Flight change" },
    reservation_confirmed: { emoji: "✅", label: "Reservation confirmed" },
    invoice_due: { emoji: "💳", label: "Invoice/payment due" },
    government_mail: { emoji: "🏛️", label: "Government correspondence" },
    delivery_notification: { emoji: "📦", label: "Delivery notice" },
    security_alert: { emoji: "🔐", label: "Security alert" },
    subscription_renewal: { emoji: "🔁", label: "Subscription renewal" },
    refund_dispute: { emoji: "💰", label: "Refund/dispute update" },
  },
}));

const { sendWhatsAppMessage, isWhatsAppConfigured } = await import("../providers/whatsapp.js");
const { findOrCreateUserByEmail, addPhoneNumberForUser, hasAlerted } = await import("../db/store.js");
const { checkForImportantEmails, formatImportantEmailAlert } = await import("./importantEmailAlerts.js");

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

// All test files share one SQLite database for the whole `vitest run` (see test/setup.ts), and
// user_phone_numbers.phone is UNIQUE. Existing files already claim 44700000-44700004 (see
// pendingRegistration.test.ts, whatsappRegistration.test.ts, reconciliation.test.ts,
// xeroForwarding.test.ts, memoryReminders.test.ts) — this file uses 44700005.
function freshPhone(): string {
  counter += 1;
  return `44700005${String(counter).padStart(4, "0")}`;
}

function fakeMessage(
  overrides: Partial<{
    id: string;
    accountId: number;
    subject: string;
    snippet: string;
    from: string;
    unread: boolean;
  }>
) {
  return {
    id: "msg-1",
    accountId: 1,
    accountEmail: "test@example.com",
    provider: "google" as const,
    subject: "",
    from: "no-reply@delta.com",
    snippet: "",
    receivedAt: new Date().toISOString(),
    unread: true,
    ...overrides,
  };
}

async function baseline(ownerId: number) {
  mockHubListMessages.mockResolvedValueOnce([]);
  await checkForImportantEmails(ownerId);
}

beforeEach(() => {
  vi.mocked(sendWhatsAppMessage).mockReset();
  vi.mocked(isWhatsAppConfigured).mockReset().mockReturnValue(true);
  mockHubListMessages.mockReset();
  mockClassify.mockReset().mockResolvedValue(new Map());
});

describe("checkForImportantEmails", () => {
  it("baselines the existing inbox on first run without classifying or notifying", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("baseline"));
    mockHubListMessages.mockResolvedValueOnce([fakeMessage({ id: "old-1" })]);

    await checkForImportantEmails(user.id);

    expect(mockClassify).not.toHaveBeenCalled();
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(hasAlerted(user.id, "important-email:1:old-1")).toBe(true);
  });

  it("filters to unread automated-sender mail only, ignoring read mail and mail from real people", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("filter"));
    await baseline(user.id);

    mockHubListMessages.mockResolvedValueOnce([
      fakeMessage({ id: "read", unread: false, from: "no-reply@delta.com" }),
      fakeMessage({ id: "real-person", unread: true, from: "jane@example.com" }),
      fakeMessage({ id: "candidate", unread: true, from: "no-reply@delta.com", subject: "Flight change" }),
    ]);

    await checkForImportantEmails(user.id);

    expect(mockClassify).toHaveBeenCalledTimes(1);
    const [candidates] = mockClassify.mock.calls[0];
    expect(candidates).toEqual([{ index: 0, subject: "Flight change", snippet: "" }]);
  });

  it("sends a WhatsApp alert for a classified match, formatted with the category", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("match"));
    const phone = freshPhone();
    addPhoneNumberForUser(user.id, phone);
    await baseline(user.id);

    mockHubListMessages.mockResolvedValueOnce([
      fakeMessage({ id: "flight-1", subject: "Your flight changed" }),
    ]);
    mockClassify.mockResolvedValueOnce(new Map([[0, "flight_change"]]));

    await checkForImportantEmails(user.id);

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    const [sentTo, text] = vi.mocked(sendWhatsAppMessage).mock.calls[0];
    expect(sentTo).toBe(phone);
    expect(text).toContain("✈️");
    expect(text).toContain("Your flight changed");
    expect(hasAlerted(user.id, "important-email:1:flight-1")).toBe(true);
  });

  it("does not re-classify or re-alert the same message on a later tick", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("dedup"));
    const phone = freshPhone();
    addPhoneNumberForUser(user.id, phone);
    await baseline(user.id);

    mockHubListMessages.mockResolvedValue([fakeMessage({ id: "flight-2" })]);
    mockClassify.mockResolvedValue(new Map([[0, "flight_change"]]));

    await checkForImportantEmails(user.id);
    await checkForImportantEmails(user.id);

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    expect(mockClassify).toHaveBeenCalledTimes(1);
  });

  it("marks a non-matching candidate scanned so it isn't reclassified next tick", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("nonmatch"));
    await baseline(user.id);

    mockHubListMessages.mockResolvedValue([fakeMessage({ id: "boring-1" })]);
    mockClassify.mockResolvedValue(new Map());

    await checkForImportantEmails(user.id);
    await checkForImportantEmails(user.id);

    expect(hasAlerted(user.id, "important-email:1:boring-1")).toBe(true);
    expect(mockClassify).toHaveBeenCalledTimes(1);
  });

  it("leaves everything unscanned when classification itself fails", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("classify-fail"));
    await baseline(user.id);

    mockHubListMessages.mockResolvedValueOnce([fakeMessage({ id: "err-1" })]);
    mockClassify.mockRejectedValueOnce(new Error("API down"));

    await checkForImportantEmails(user.id);

    expect(hasAlerted(user.id, "important-email:1:err-1")).toBe(false);
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it("leaves a matched message unmarked (retriable) when delivery fails", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("deliver-fail"));
    const phone = freshPhone();
    addPhoneNumberForUser(user.id, phone);
    await baseline(user.id);

    mockHubListMessages.mockResolvedValueOnce([fakeMessage({ id: "fail-1" })]);
    mockClassify.mockResolvedValueOnce(new Map([[0, "invoice_due"]]));
    vi.mocked(sendWhatsAppMessage).mockRejectedValueOnce(new Error("network down"));

    await checkForImportantEmails(user.id);

    expect(hasAlerted(user.id, "important-email:1:fail-1")).toBe(false);
  });

  it("leaves a matched message unmarked when WhatsApp isn't configured", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("not-configured"));
    await baseline(user.id);

    mockHubListMessages.mockResolvedValueOnce([fakeMessage({ id: "noconfig-1" })]);
    mockClassify.mockResolvedValueOnce(new Map([[0, "invoice_due"]]));
    vi.mocked(isWhatsAppConfigured).mockReturnValue(false);

    await checkForImportantEmails(user.id);

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(hasAlerted(user.id, "important-email:1:noconfig-1")).toBe(false);
  });

  it("leaves a matched message unmarked when the user has no registered phone numbers", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("no-numbers"));
    await baseline(user.id);

    mockHubListMessages.mockResolvedValueOnce([fakeMessage({ id: "nonum-1" })]);
    mockClassify.mockResolvedValueOnce(new Map([[0, "invoice_due"]]));

    await checkForImportantEmails(user.id);

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(hasAlerted(user.id, "important-email:1:nonum-1")).toBe(false);
  });

  it("caps alerts per tick and sends a summary for the overflow", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("cap"));
    const phone = freshPhone();
    addPhoneNumberForUser(user.id, phone);
    await baseline(user.id);

    // MAX_ALERTS_PER_CHECK is 5 — six matches means the sixth goes into the overflow summary.
    const messages = Array.from({ length: 6 }, (_, i) =>
      fakeMessage({ id: `cap-${i}`, subject: `Notice ${i}` })
    );
    mockHubListMessages.mockResolvedValueOnce(messages);
    const classified = new Map<number, "invoice_due">();
    for (let i = 0; i < 6; i++) classified.set(i, "invoice_due");
    mockClassify.mockResolvedValueOnce(classified);

    await checkForImportantEmails(user.id);

    // 5 individual alerts + 1 overflow summary = 6 sends.
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(6);
    const lastCall = vi.mocked(sendWhatsAppMessage).mock.calls[5];
    expect(lastCall[1]).toContain("1 more");
    for (let i = 0; i < 6; i++) {
      expect(hasAlerted(user.id, `important-email:1:cap-${i}`)).toBe(true);
    }
  });
});

describe("formatImportantEmailAlert", () => {
  it("includes the category emoji, label, subject, sender, and snippet", () => {
    const text = formatImportantEmailAlert(
      fakeMessage({
        subject: "Your invoice is due",
        from: "billing@vendor.com",
        snippet: "£120 due 1 Sep",
      }),
      "invoice_due"
    );
    expect(text).toContain("💳");
    expect(text).toContain("Invoice/payment due");
    expect(text).toContain("Your invoice is due");
    expect(text).toContain("billing@vendor.com");
    expect(text).toContain("£120 due 1 Sep");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run src/services/importantEmailAlerts.test.ts`
Expected: FAIL — `importantEmailAlerts.ts` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```ts
// server/src/services/importantEmailAlerts.ts
// Proactive classification of automated/transactional mail into a fixed category set that
// neither checkForNewImportantMessages (alerts.ts, real people only) nor
// checkNewEmailsAgainstRecentDocuments (reconciliation.ts, requires an already-saved document to
// match against) can catch. See
// docs/superpowers/specs/2026-08-26-important-email-alerts-design.md.

import { hubListMessages, AUTOMATED_SENDER_PATTERN } from "./hub.js";
import { hasAlerted, markAlerted, getSetting, setSetting, listPhoneNumbersForUser } from "../db/store.js";
import { sendWhatsAppMessage, isWhatsAppConfigured } from "../providers/whatsapp.js";
import { classifyImportantEmails, CATEGORY_INFO, type ImportantEmailCategory } from "./importantEmailClassifier.js";
import type { UnifiedMessage } from "../providers/types.js";

const MAX_ALERTS_PER_CHECK = 5;
const BASELINE_KEY = "important_email_baseline_set";

// Namespaced so this ledger entry can never collide with alerts.ts's bare `${accountId}:${id}`
// key on the same alerted_messages table — the two features filter for opposite sender types
// today (real people vs. automated), but the prefix keeps that true by construction, not by
// coincidence, and also keeps clear of reconciliation.ts's `recon-match:`/`recon-scan:` prefixes.
function messageKey(m: UnifiedMessage): string {
  return `important-email:${m.accountId}:${m.id}`;
}

export function formatImportantEmailAlert(m: UnifiedMessage, category: ImportantEmailCategory): string {
  const { emoji, label } = CATEGORY_INFO[category];
  return `${emoji} ${label}: "${m.subject}" from ${m.from}\n${m.snippet}`;
}

// Returns whether every registered number actually got the message — callers must only mark a
// message alerted when this is true. Same precedent as memoryReminders.ts: a notification that
// fails to deliver must stay retriable, unlike alerts.ts's fire-and-forget notify() (acceptable
// there only because "another email will come"; not acceptable for a flight-cancellation alert).
async function notifyAll(numbers: string[], text: string): Promise<boolean> {
  let allSucceeded = true;
  for (const number of numbers) {
    try {
      await sendWhatsAppMessage(number, text);
    } catch (err) {
      console.error("importantEmailAlerts: failed to send", err);
      allSucceeded = false;
    }
  }
  return allSucceeded;
}

// Runs on the existing 5-minute scheduler tick, sibling to checkForNewImportantMessages and
// checkNewEmailsAgainstRecentDocuments — but targets automated senders specifically (the inverse
// of checkForNewImportantMessages's filter), since that's exactly the mail those two miss.
export async function checkForImportantEmails(ownerId: number): Promise<void> {
  const messages = await hubListMessages(ownerId, { limit: 50 });
  const candidates = messages.filter((m) => m.unread && m.from && AUTOMATED_SENDER_PATTERN.test(m.from));

  // First-ever run: baseline the current inbox instead of alerting on everything already sitting
  // there — same precedent as alerts.ts's BASELINE_KEY, doubly important here since this feature
  // ships on by default.
  if (getSetting(ownerId, BASELINE_KEY) !== "true") {
    for (const m of candidates) markAlerted(ownerId, messageKey(m));
    setSetting(ownerId, BASELINE_KEY, "true");
    return;
  }

  const unscanned = candidates.filter((m) => !hasAlerted(ownerId, messageKey(m)));
  if (unscanned.length === 0) return;

  let classified: Map<number, ImportantEmailCategory>;
  try {
    classified = await classifyImportantEmails(
      unscanned.map((m, index) => ({ index, subject: m.subject, snippet: m.snippet }))
    );
  } catch (err) {
    console.error(`importantEmailAlerts: classification failed for owner ${ownerId}`, err);
    return; // leave every candidate unscanned so the next tick retries classification
  }

  // A non-match has been fully examined and settled — mark it scanned now so it isn't
  // reclassified every tick. A match stays unmarked until it's actually delivered, below.
  for (let i = 0; i < unscanned.length; i++) {
    if (!classified.has(i)) markAlerted(ownerId, messageKey(unscanned[i]));
  }

  const matches = unscanned
    .map((m, index) => ({ m, category: classified.get(index) }))
    .filter((x): x is { m: UnifiedMessage; category: ImportantEmailCategory } => !!x.category);
  if (matches.length === 0) return;

  if (!isWhatsAppConfigured()) return; // matches stay unscanned, retried next tick
  const numbers = listPhoneNumbersForUser(ownerId).map((r) => r.phone);
  if (numbers.length === 0) return; // matches stay unscanned, retried next tick

  const toSend = matches.slice(0, MAX_ALERTS_PER_CHECK);
  for (const { m, category } of toSend) {
    const delivered = await notifyAll(numbers, formatImportantEmailAlert(m, category));
    if (delivered) markAlerted(ownerId, messageKey(m));
  }

  const rest = matches.slice(MAX_ALERTS_PER_CHECK);
  if (rest.length > 0) {
    const summary = `...and ${rest.length} more important email${rest.length === 1 ? "" : "s"} — check your inbox.`;
    const delivered = await notifyAll(numbers, summary);
    if (delivered) {
      for (const { m } of rest) markAlerted(ownerId, messageKey(m));
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx vitest run src/services/importantEmailAlerts.test.ts`
Expected: PASS, all cases green.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/importantEmailAlerts.ts server/src/services/importantEmailAlerts.test.ts
git commit -m "Add important-email alerts service"
```

---

### Task 3: Settings routes

**Files:**
- Modify: `server/src/routes/alertRoutes.ts`
- Test: `server/src/routes/alertRoutes.test.ts` (new — no existing test file for this router)

**Interfaces:**
- Consumes (existing): `getSetting`, `setSetting` from `../db/store.js` (already imported in this file).
- Produces (used by Task 5): `GET /api/important-email-alerts/settings` → `{ enabled: boolean }`; `PUT /api/important-email-alerts/settings` with body `{ enabled: boolean }` → `{ ok: true }`.

- [ ] **Step 1: Write the failing test file**

```ts
// server/src/routes/alertRoutes.test.ts
import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { alertRoutes } from "./alertRoutes.js";
import { findOrCreateUserByEmail, getSetting } from "../db/store.js";
import type { AuthedRequest } from "../middleware/auth.js";

function buildTestApp(userId: number) {
  const app = express();
  app.use(express.json());
  // Stub in place of requireAuth — real auth is exercised elsewhere (see toolsRoutes.test.ts's
  // "auth gating" block); this test is about the routes' own logic.
  app.use((req, _res, next) => {
    (req as unknown as AuthedRequest).userId = userId;
    next();
  });
  app.use(alertRoutes);
  return app;
}

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

describe("GET /api/important-email-alerts/settings", () => {
  it("defaults to enabled:true for a user who has never touched the setting", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("default-on"));
    const app = buildTestApp(user.id);

    const res = await request(app).get("/api/important-email-alerts/settings");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true });
  });
});

describe("PUT /api/important-email-alerts/settings", () => {
  it("persists an explicit opt-out", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("opt-out"));
    const app = buildTestApp(user.id);

    const putRes = await request(app).put("/api/important-email-alerts/settings").send({ enabled: false });
    expect(putRes.status).toBe(200);
    expect(getSetting(user.id, "important_email_alerts_enabled")).toBe("false");

    const getRes = await request(app).get("/api/important-email-alerts/settings");
    expect(getRes.body).toEqual({ enabled: false });
  });

  it("reflects re-enabling after an opt-out immediately", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("re-enable"));
    const app = buildTestApp(user.id);

    await request(app).put("/api/important-email-alerts/settings").send({ enabled: false });
    await request(app).put("/api/important-email-alerts/settings").send({ enabled: true });

    const getRes = await request(app).get("/api/important-email-alerts/settings");
    expect(getRes.body).toEqual({ enabled: true });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run src/routes/alertRoutes.test.ts`
Expected: FAIL — 404s, since the routes don't exist yet.

- [ ] **Step 3: Add the routes**

Modify `server/src/routes/alertRoutes.ts` — append after the existing `PUT /api/alerts/settings` handler:

```ts
alertRoutes.get("/api/important-email-alerts/settings", (req, res) => {
  res.json({
    enabled: getSetting((req as unknown as AuthedRequest).userId, "important_email_alerts_enabled") !== "false",
  });
});

alertRoutes.put("/api/important-email-alerts/settings", (req, res) => {
  const { enabled } = req.body ?? {};
  setSetting(
    (req as unknown as AuthedRequest).userId,
    "important_email_alerts_enabled",
    enabled ? "true" : "false"
  );
  res.json({ ok: true });
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx vitest run src/routes/alertRoutes.test.ts`
Expected: PASS, all cases green.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/alertRoutes.ts server/src/routes/alertRoutes.test.ts
git commit -m "Add important-email-alerts settings routes"
```

---

### Task 4: Scheduler wiring

**Files:**
- Modify: `server/src/services/scheduler.ts`

**Interfaces:**
- Consumes (from Task 2): `checkForImportantEmails(ownerId: number): Promise<void>`.
- Consumes (existing): `getSetting` (already imported in this file).

No test file — `scheduler.ts` has no test coverage anywhere in this codebase (its other three
per-user checks are wired the same, untested way); this task's wiring is verified indirectly by
Task 2's tests (the function it calls) and directly by Task 7's manual end-to-end check.

- [ ] **Step 1: Add the import**

Modify `server/src/services/scheduler.ts` — add after the existing `reconciliation.js` import:

```ts
import { checkForImportantEmails } from "./importantEmailAlerts.js";
```

- [ ] **Step 2: Add the per-user gated wrapper**

Add after `runReconciliationCheckForUser`:

```ts
async function runImportantEmailAlertsCheckForUser(ownerId: number): Promise<void> {
  if (getSetting(ownerId, "important_email_alerts_enabled") === "false") return;
  try {
    await checkForImportantEmails(ownerId);
  } catch (err) {
    console.error(`scheduler: important-email check failed for user ${ownerId}`, err);
  }
}
```

- [ ] **Step 3: Wire it into `tick()`**

In `tick()`, add after the `runReconciliationCheckForUser` call:

```ts
    await runImportantEmailAlertsCheckForUser(ownerId).catch((err) =>
      console.error(`scheduler: important-email check failed for user ${ownerId}`, err)
    );
```

- [ ] **Step 4: Typecheck**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Run the full server test suite**

Run: `cd server && npm test`
Expected: all tests pass (no new failures introduced by this wiring).

- [ ] **Step 6: Commit**

```bash
git add server/src/services/scheduler.ts
git commit -m "Wire important-email alerts into the scheduler tick"
```

---

### Task 5: Client API additions

**Files:**
- Modify: `client/src/api/client.ts`

**Interfaces:**
- Produces (used by Task 6): `export interface ImportantEmailAlertSettings { enabled: boolean }`, `export const fetchImportantEmailAlertSettings: () => Promise<ImportantEmailAlertSettings>`, `export function saveImportantEmailAlertSettings(settings: ImportantEmailAlertSettings): Promise<void>`.

No client-side test infra exists in this repo (`client/src/**/*.test.tsx` — zero files); this
task's correctness is verified by the client build (Step 2) and Task 7's manual check.

- [ ] **Step 1: Add the type and functions**

Modify `client/src/api/client.ts` — add immediately after the existing `saveAlertSettings` function
(right before `export interface Tool`):

```ts
export interface ImportantEmailAlertSettings {
  enabled: boolean;
}

export const fetchImportantEmailAlertSettings = () =>
  getJson<ImportantEmailAlertSettings>("/api/important-email-alerts/settings");

export async function saveImportantEmailAlertSettings(settings: ImportantEmailAlertSettings): Promise<void> {
  const res = await fetch(
    `${API_BASE}/api/important-email-alerts/settings`,
    withCredentials({
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    })
  );
  if (!res.ok) throw new Error("failed to save important-email alert settings");
}
```

- [ ] **Step 2: Build the client to verify types check out**

Run: `cd client && npm run build`
Expected: builds cleanly (`tsc -b && vite build`), no type errors.

- [ ] **Step 3: Commit**

```bash
git add client/src/api/client.ts
git commit -m "Add important-email-alerts client API"
```

---

### Task 6: Setup page toggle

**Files:**
- Modify: `client/src/pages/SettingsPage.tsx`

**Interfaces:**
- Consumes (from Task 5): `ImportantEmailAlertSettings`, `fetchImportantEmailAlertSettings`, `saveImportantEmailAlertSettings`.

- [ ] **Step 1: Import the new type and functions**

In `client/src/pages/SettingsPage.tsx`'s import block from `../api/client`, add
`fetchImportantEmailAlertSettings` and `saveImportantEmailAlertSettings` next to the existing
`fetchAlertSettings`/`saveAlertSettings`, and add `type ImportantEmailAlertSettings` next to the
existing `type AlertSettings`.

- [ ] **Step 2: Add state**

Add after the existing `const [alertSaved, setAlertSaved] = useState(false);`:

```ts
  const [importantEmailSettings, setImportantEmailSettings] = useState<ImportantEmailAlertSettings>({
    enabled: true,
  });
  const [importantEmailSaved, setImportantEmailSaved] = useState(false);
```

(Defaults `enabled` to `true` client-side before the first fetch resolves — matches the server's
default-on behavior, so there's no flash of an unchecked box for a user who's never touched this
setting.)

- [ ] **Step 3: Fetch it in `load()`**

Change the `load()` function to:

```ts
  async function load() {
    const [p, a, f, b, m, ws, nums, al, iel] = await Promise.all([
      fetchProviders(),
      fetchAccounts(),
      fetchLocalFolders(),
      fetchBriefingSettings(),
      fetchMemoryNotes(),
      fetchWhatsAppStatus(),
      fetchWhatsAppAllowedNumbers(),
      fetchAlertSettings(),
      fetchImportantEmailAlertSettings(),
    ]);
    setProviders(p);
    setAccounts(a);
    setFolders(f);
    setBriefing(b);
    setMemoryNotes(m);
    setWhatsAppStatus(ws);
    setAllowedNumbers(nums);
    setAlertSettings(al);
    setImportantEmailSettings(iel);
  }
```

- [ ] **Step 4: Add the toggle handler**

Add after the existing `handleToggleAlerts` function:

```ts
  async function handleToggleImportantEmailAlerts(enabled: boolean) {
    const next = { enabled };
    setImportantEmailSettings(next);
    await saveImportantEmailAlertSettings(next);
    setImportantEmailSaved(true);
    setTimeout(() => setImportantEmailSaved(false), 2500);
  }
```

- [ ] **Step 5: Add the checkbox card**

Add a second `card card-padded` block right after the existing "Instant alerts" card's closing
`</div>` (the one containing "Ping me when a real person emails"), still inside the same
`section === "alerts"` block:

```tsx
                <div className="card card-padded" style={{ marginBottom: 20 }}>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={importantEmailSettings.enabled}
                      onChange={(e) => handleToggleImportantEmailAlerts(e.target.checked)}
                    />
                    <span>
                      <span className="check-row-title">Flag important automated mail</span>
                      <span className="check-row-desc">
                        Flight changes, invoices, government mail, deliveries, security alerts,
                        subscription renewals, and refund updates — even from automated senders.
                        On by default; starts from the moment this ships, so your existing unread
                        mail won't set it off.
                      </span>
                    </span>
                  </label>
                  {importantEmailSaved && <span className="saved-note">Saved</span>}
                </div>
```

- [ ] **Step 6: Build the client to verify it compiles**

Run: `cd client && npm run build`
Expected: builds cleanly, no type errors.

- [ ] **Step 7: Commit**

```bash
git add client/src/pages/SettingsPage.tsx
git commit -m "Add important-email-alerts toggle to the Setup page"
```

---

### Task 7: Manual end-to-end verification

**Files:** none (verification only, no code changes)

Covers what automated tests can't: whether the real Haiku call actually classifies real emails
correctly, and whether the whole tick fires end-to-end in a real deployment. Requires a dev/staging
environment with `ANTHROPIC_API_KEY` and `WHATSAPP_TOKEN`/`WHATSAPP_PHONE_NUMBER_ID`/
`WHATSAPP_VERIFY_TOKEN` configured, and a connected test email account.

- [ ] **Step 1: Confirm the baseline doesn't backfill-alert**

Before this ships, note any unread automated mail already sitting in the test account's inbox.
Deploy, wait one scheduler tick (5 minutes, or temporarily lower `CHECK_INTERVAL_MS` in
`scheduler.ts` for this test run only, reverting after). Confirm **no** WhatsApp message arrives
for that pre-existing mail — it should be silently baselined.

- [ ] **Step 2: Confirm true positives across categories**

Send (or forward) a handful of realistic automated emails into the test account, covering several
categories — e.g. a flight-change notice, an invoice, a security alert ("new sign-in"), and a
delivery notification. Wait one tick. Confirm each produces a WhatsApp message with the right
emoji/category label and the right subject/snippet.

- [ ] **Step 3: Confirm a true negative**

Send a plain newsletter or marketing email from an automated-looking address (e.g.
`no-reply@some-newsletter.com`). Wait one tick. Confirm it does **not** produce a WhatsApp message
— it should be classified as no match and marked scanned without alerting.

- [ ] **Step 4: Confirm the off switch actually stops alerts**

On the Setup page, toggle "Flag important automated mail" off. Send another flight-change-style
test email. Wait one tick. Confirm no WhatsApp message arrives. Toggle it back on.

- [ ] **Step 5: Confirm no duplicate alert on the next tick**

Wait one more tick after Step 2's messages fired. Confirm none of them fire again.

- [ ] **Step 6: Clean up test data**

Delete/archive the test emails sent during this verification, and clear their
`important-email:*` rows from `alerted_messages` if you want the account left exactly as it was
(not required — the dedupe ledger self-trims at 5000 rows per owner and stale entries are
harmless).

---

## Self-Review

**Spec coverage:** 8-category classifier + labels (Task 1) ✓, batched per-tick classification with
subject+snippet only (Task 1+2) ✓, automated-sender/unread filtering, inverse of `alerts.ts`
(Task 2) ✓, baseline-on-first-run (Task 2) ✓, namespaced dedupe key (Task 2) ✓, per-tick cap +
overflow summary (Task 2) ✓, classification-failure and delivery-failure retriability (Task 2) ✓,
default-on/opt-out settings semantics (Task 3) ✓, scheduler gating (Task 4) ✓, Setup-page toggle
(Task 6) ✓, manual verification of the real classifier (Task 7) ✓. Out-of-scope items from the
spec (per-category toggles, full-body fetch, eval-framework extension, weak-match tier) are
correctly not built anywhere in this plan.

**Type consistency check:** `ImportantEmailCategory` is defined once in Task 1 and used
identically everywhere downstream — Task 2's `classified: Map<number, ImportantEmailCategory>`,
`formatImportantEmailAlert`'s second parameter, and the test file's mocked `CATEGORY_INFO` keys
all match the same 8 string literals. `ClassifyCandidate`'s shape (`{index, subject, snippet}`) is
identical between Task 1's `buildClassifyPrompt`/`classifyImportantEmails` and Task 2's call site.
`checkForImportantEmails`/`formatImportantEmailAlert` names match between Task 2's implementation
and every later reference (Task 4 imports `checkForImportantEmails`; no other task references
Task 2's internals). `fetchImportantEmailAlertSettings`/`saveImportantEmailAlertSettings`/
`ImportantEmailAlertSettings` match exactly between Task 5's definitions and Task 6's usage.

**No placeholders:** every step has complete, runnable code — no TBDs, no "add appropriate
handling," no elided test bodies.
