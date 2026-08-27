# WhatsApp Pending-Actions Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the WhatsApp assistant ask closed-set questions (confirm a destructive action, disambiguate between candidates) as real tappable buttons/lists instead of free-text prose, with confirmed destructive actions executing deterministically (zero further LLM calls).

**Architecture:** A new `pending_actions` DB table backs a `ask_user_choice` tool the assistant can call. Calling it ends the assistant's turn immediately and persists either a `confirm` (tool name + args to run on Yes) or `resume` (options list to inject back into conversation on tap) row. WhatsApp button/list tap IDs embed the row's id (`pa:<uuid>:<key>`); a new `actionHandlers.ts` consumes them atomically and either runs the stored tool directly or re-enters the normal assistant loop with a synthetic "user selected X" message.

**Tech Stack:** TypeScript, Express, better-sqlite3, `@anthropic-ai/sdk`, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-27-whatsapp-pending-actions-design.md`

## Global Constraints

- Tap ID format: `pa:<uuid>:<key>` — `key` is `"yes"`/`"no"` for confirm mode, or the option's array index (as a string) for resume mode.
- `pending_actions` rows expire 24h after creation; expiry is enforced at consume time (`expires_at > now` in the same atomic UPDATE), not only by the periodic sweep.
- Consuming a row is one atomic `UPDATE ... WHERE id=? AND owner_id=? AND consumed_at IS NULL AND expires_at > ?`, checked via `changes` — this is what makes double-taps and Meta's webhook retries safe.
- WhatsApp buttons cap at 3 per message (Meta limit); `sendChoiceMessage` must fall back to a list message (up to 10 rows) above that.
- A confirmed `confirm`-mode action runs via `runTool` directly from `actionHandlers.ts` — never through another `runAssistantChat` call. Zero LLM tokens spent on executing a tap.
- `runAssistantChat`'s return type changes from `Promise<string>` to `Promise<AssistantReply>` (`{ text: string; choice?: {...} }`). Every existing caller must be updated in the same task that makes this change, so the codebase always compiles and existing tests always pass at the end of a task.

---

### Task 1: `pending_actions` data layer

**Files:**
- Modify: `server/src/db/store.ts` (add table migration near `pending_setup`, ~line 606; add functions near the `pending_setup` section, ~line 1803)
- Test: `server/src/db/pendingActions.test.ts` (new)

**Interfaces:**
- Produces: `export type PendingActionMode = "confirm" | "resume";`
- Produces: `export interface PendingActionRow { id: string; ownerId: number; mode: PendingActionMode; question: string; contextJson: string; }`
- Produces: `export function createPendingAction(ownerId: number, mode: PendingActionMode, question: string, contextJson: string): string` — returns the new row's id.
- Produces: `export function consumePendingAction(id: string, ownerId: number): PendingActionRow | null` — atomically marks consumed and returns the row, or `null` if unknown/wrong-owner/already-consumed/expired.
- Produces: `export function deleteExpiredPendingActions(): void`

- [ ] **Step 1: Write the failing tests**

Create `server/src/db/pendingActions.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  findOrCreateUserByEmail,
  createPendingAction,
  consumePendingAction,
  deleteExpiredPendingActions,
} from "./store.js";

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

describe("pending_actions", () => {
  it("creates a row and consumes it exactly once", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("consume-once"));
    const id = createPendingAction(user.id, "confirm", "Archive 3 emails?", JSON.stringify({ tool: "archive_messages", input: {} }));

    const row = consumePendingAction(id, user.id);
    expect(row).toEqual({
      id,
      ownerId: user.id,
      mode: "confirm",
      question: "Archive 3 emails?",
      contextJson: JSON.stringify({ tool: "archive_messages", input: {} }),
    });

    expect(consumePendingAction(id, user.id)).toBeNull();
  });

  it("rejects consumption by a different owner", () => {
    const owner = findOrCreateUserByEmail(uniqueEmail("real-owner"));
    const stranger = findOrCreateUserByEmail(uniqueEmail("stranger"));
    const id = createPendingAction(owner.id, "resume", "Which one?", JSON.stringify({ options: ["A", "B"] }));

    expect(consumePendingAction(id, stranger.id)).toBeNull();
    // Still consumable by the real owner afterward — the failed attempt didn't burn it.
    expect(consumePendingAction(id, owner.id)).not.toBeNull();
  });

  it("returns null for an unknown id", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("unknown-id"));
    expect(consumePendingAction("not-a-real-id", user.id)).toBeNull();
  });

  it("deleteExpiredPendingActions removes only rows past their TTL", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("sweep"));
    const freshId = createPendingAction(user.id, "confirm", "Archive?", "{}");
    deleteExpiredPendingActions();
    // A freshly created row (expires 24h from now) must survive a sweep run immediately after.
    expect(consumePendingAction(freshId, user.id)).not.toBeNull();
  });
});
```

Expiry-at-consume-time (the `expires_at > ?` clause) isn't separately tested here since it would require monkeypatching `Date.now` or exposing a test-only setter for one edge case — every other test above already exercises the same code path well within the 24h TTL, and the clause itself is a one-line, low-risk addition to an otherwise well-covered query.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/db/pendingActions.test.ts`
Expected: FAIL — `createPendingAction`/`consumePendingAction`/`deleteExpiredPendingActions` are not exported from `./store.js`.

- [ ] **Step 3: Implement the table and functions**

In `server/src/db/store.ts`, add the table just after the `pending_setup` table (after the block ending at the current line ~606):

```ts
// Backs ask_user_choice (assistant.ts): a closed-set question rendered as WhatsApp buttons/a
// list, tapped later. 'confirm' rows store the exact tool+args to run on a Yes tap (executed
// directly, no further LLM call); 'resume' rows store the option labels to inject back into the
// conversation as a synthetic user message. See actionHandlers.ts for the consuming side.
db.exec(`
  CREATE TABLE IF NOT EXISTS pending_actions (
    id TEXT PRIMARY KEY,
    owner_id INTEGER NOT NULL REFERENCES users(id),
    mode TEXT NOT NULL,
    question TEXT NOT NULL,
    context_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER
  );
`);
```

Then, in the same file, near the `pending_setup` functions (after `clearPendingSetup`, current line ~1803), add:

```ts
// ---------------------------------------------------------------------------
// Pending actions — ask_user_choice's backing store (see assistant.ts / actionHandlers.ts)
// ---------------------------------------------------------------------------

export type PendingActionMode = "confirm" | "resume";

export interface PendingActionRow {
  id: string;
  ownerId: number;
  mode: PendingActionMode;
  question: string;
  contextJson: string;
}

const PENDING_ACTION_TTL_MS = 24 * 60 * 60 * 1000;

export function createPendingAction(
  ownerId: number,
  mode: PendingActionMode,
  question: string,
  contextJson: string
): string {
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO pending_actions (id, owner_id, mode, question, context_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, ownerId, mode, question, contextJson, now, now + PENDING_ACTION_TTL_MS);
  return id;
}

// Atomically marks the row consumed and returns it. Returns null if the id doesn't exist,
// belongs to a different owner, is already consumed, or is past its expiry — expiry is checked
// here rather than relying solely on the periodic sweep, since the sweep is hygiene only, not
// the correctness boundary.
export function consumePendingAction(id: string, ownerId: number): PendingActionRow | null {
  const now = Date.now();
  const result = db
    .prepare(
      `UPDATE pending_actions SET consumed_at = ?
       WHERE id = ? AND owner_id = ? AND consumed_at IS NULL AND expires_at > ?`
    )
    .run(now, id, ownerId, now);
  if (result.changes === 0) return null;
  const row = db
    .prepare(
      `SELECT id, owner_id AS ownerId, mode, question, context_json AS contextJson
       FROM pending_actions WHERE id = ?`
    )
    .get(id) as PendingActionRow | undefined;
  return row ?? null;
}

// Hygiene only — expiry is already enforced at consume time above. Called once per scheduler
// tick (not per user — this isn't scoped to a tenant).
export function deleteExpiredPendingActions(): void {
  db.prepare(`DELETE FROM pending_actions WHERE expires_at < ?`).run(Date.now());
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/db/pendingActions.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
cd server && git add src/db/store.ts src/db/pendingActions.test.ts
git commit -m "feat: add pending_actions table for WhatsApp ask_user_choice

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UVDsGYAg9S8QaXoudzaxpE"
```

---

### Task 2: WhatsApp list messages and choice dispatch

**Files:**
- Modify: `server/src/providers/whatsapp.ts` (add `sendWhatsAppListMessage`/`sendChoiceMessage` after `sendWhatsAppCtaUrl`, ~line 158; extend `WebhookPayload`/`extractIncomingMessages` for `list_reply`, ~lines 286-348)
- Test: `server/src/providers/whatsapp.test.ts` (extend)

**Interfaces:**
- Produces: `export async function sendWhatsAppListMessage(to: string, bodyText: string, buttonLabel: string, rows: { id: string; title: string }[]): Promise<void>`
- Produces: `export async function sendChoiceMessage(to: string, bodyText: string, choices: { id: string; title: string }[]): Promise<void>` — buttons for ≤3 choices, else a list.
- Consumes: existing `sendWhatsAppReplyButtons`, `buildSendError` (both already in this file).

- [ ] **Step 1: Write the failing tests**

Append to `server/src/providers/whatsapp.test.ts`:

```ts
import { sendWhatsAppListMessage, sendChoiceMessage } from "./whatsapp.js";

describe("sendWhatsAppListMessage", () => {
  it("posts an interactive list message with the given rows", async () => {
    const fetchMock = mockFetchOk();

    await sendWhatsAppListMessage("447000000001", "Pick one", "Choose", [
      { id: "pa:abc:0", title: "Sarah Chen" },
      { id: "pa:abc:1", title: "Sarah Lee" },
    ]);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.interactive.type).toBe("list");
    expect(body.interactive.body.text).toBe("Pick one");
    expect(body.interactive.action.button).toBe("Choose");
    expect(body.interactive.action.sections).toEqual([
      {
        rows: [
          { id: "pa:abc:0", title: "Sarah Chen" },
          { id: "pa:abc:1", title: "Sarah Lee" },
        ],
      },
    ]);
  });
});

describe("sendChoiceMessage", () => {
  it("uses reply buttons for 3 or fewer choices", async () => {
    const fetchMock = mockFetchOk();

    await sendChoiceMessage("447000000001", "Archive 3 emails?", [
      { id: "pa:abc:yes", title: "Yes" },
      { id: "pa:abc:no", title: "No" },
    ]);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.interactive.type).toBe("button");
  });

  it("uses a list message for more than 3 choices", async () => {
    const fetchMock = mockFetchOk();

    await sendChoiceMessage("447000000001", "Which one?", [
      { id: "pa:abc:0", title: "A" },
      { id: "pa:abc:1", title: "B" },
      { id: "pa:abc:2", title: "C" },
      { id: "pa:abc:3", title: "D" },
    ]);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.interactive.type).toBe("list");
  });
});

describe("extractIncomingMessages — interactive list replies", () => {
  it("parses a list_reply into an IncomingInteractiveMessage", () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: "447000000001",
                    id: "wamid.def",
                    type: "interactive",
                    interactive: { type: "list_reply", list_reply: { id: "pa:abc:0", title: "Sarah Chen" } },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const messages = extractIncomingMessages(payload);
    expect(messages).toEqual([{ kind: "interactive", from: "447000000001", messageId: "wamid.def", buttonId: "pa:abc:0" }]);
  });
});
```

Add `extractIncomingMessages` to the existing top-of-file import list in that test file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/providers/whatsapp.test.ts`
Expected: FAIL — `sendWhatsAppListMessage`/`sendChoiceMessage` not exported; list_reply test gets an empty array.

- [ ] **Step 3: Implement**

In `server/src/providers/whatsapp.ts`, add after `sendWhatsAppCtaUrl` (after its closing `}` around line 158):

```ts
// A tappable menu of up to 10 rows in one section — used for closed-set questions with more
// options than fit as buttons (WhatsApp caps buttons at 3). A tap comes back as an
// IncomingInteractiveMessage (extractIncomingMessages below) carrying the row's id, exactly like
// a button tap does.
export async function sendWhatsAppListMessage(
  to: string,
  bodyText: string,
  buttonLabel: string,
  rows: { id: string; title: string }[]
): Promise<void> {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;
  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "list",
          body: { text: bodyText },
          action: {
            button: buttonLabel,
            sections: [{ rows: rows.map((r) => ({ id: r.id, title: r.title })) }],
          },
        },
      }),
    }
  );
  if (!res.ok) {
    throw await buildSendError("WhatsApp list-message send failed", res);
  }
}

// Picks buttons (WhatsApp caps these at 3) or a list (up to 10) based on how many choices there
// are — callers building a closed-set question use this instead of choosing between
// sendWhatsAppReplyButtons and sendWhatsAppListMessage themselves.
export async function sendChoiceMessage(
  to: string,
  bodyText: string,
  choices: { id: string; title: string }[]
): Promise<void> {
  if (choices.length <= 3) {
    await sendWhatsAppReplyButtons(to, bodyText, choices);
  } else {
    await sendWhatsAppListMessage(to, bodyText, "Choose", choices);
  }
}
```

Then update the `WebhookPayload` interface (around line 297) to also declare `list_reply`:

```ts
          interactive?: { type?: string; button_reply?: { id?: string; title?: string }; list_reply?: { id?: string; title?: string } };
```

And add a new branch in `extractIncomingMessages` (in the `if/else if` chain, right after the existing `button_reply` branch, before the closing `}` of that chain around line 343):

```ts
        } else if (
          m.type === "interactive" &&
          m.from &&
          m.id &&
          m.interactive?.type === "list_reply" &&
          m.interactive.list_reply?.id
        ) {
          messages.push({
            kind: "interactive",
            from: m.from,
            messageId: m.id,
            buttonId: m.interactive.list_reply.id,
          });
        }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/providers/whatsapp.test.ts`
Expected: PASS (all tests, old and new)

- [ ] **Step 5: Commit**

```bash
cd server && git add src/providers/whatsapp.ts src/providers/whatsapp.test.ts
git commit -m "feat: add WhatsApp list messages and list_reply parsing

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UVDsGYAg9S8QaXoudzaxpE"
```

---

### Task 3: `ask_user_choice` tool and the assistant loop change

**Files:**
- Modify: `server/src/ai/assistant.ts` (add tool schema before line 544's `];`; add `AssistantReply`/`PendingChoiceButton` types near `ChatMessage`, ~line 927; add `buildChoiceReply`; change `runAssistantChat`'s loop and return type, ~lines 1036-1104; update `buildRules`, ~lines 932-962; import `createPendingAction`)
- Modify: `server/src/routes/assistantRoutes.ts` (read `.text`)
- Modify: `server/src/eval/grounding.eval.ts` (read `.text`)
- Modify: `server/src/routes/whatsappRoutes.ts` (read `.text` at the three `runAssistantChat` call sites — full choice-rendering comes in Task 4)
- Modify: `server/src/routes/whatsappRoutes.test.ts` (update the one mock that resolves `runAssistantChat` with a plain string)
- Test: `server/src/ai/assistant.test.ts` (extend)
- Test: `server/src/ai/assistant.askUserChoice.test.ts` (new — needs its own file because it mocks `@anthropic-ai/sdk` at module level, which would otherwise affect every other test in `assistant.test.ts`)

**Interfaces:**
- Consumes: `createPendingAction` from Task 1 (`../db/store.js`).
- Produces: `export interface PendingChoiceButton { key: string; label: string; }`
- Produces: `export interface AssistantReply { text: string; choice?: { actionId: string; question: string; mode: "confirm" | "resume"; buttons: PendingChoiceButton[] }; }`
- Produces: `export async function runAssistantChat(ownerId: number, history: ChatMessage[]): Promise<AssistantReply>` (signature unchanged except return type).
- Produces (internal, not exported): `function buildChoiceReply(ownerId: number, input: Record<string, unknown>): AssistantReply`

- [ ] **Step 1: Write the failing tests**

Append to `server/src/ai/assistant.test.ts` (needs `runTool` already imported at the top of that file — it is):

```ts
describe("ask_user_choice tool", () => {
  it("is always available with mode/options/confirm_tool/confirm_input in its schema", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("ask-user-choice-schema"));
    const tool = buildToolsForOwner(user.id).find((t) => t.name === "ask_user_choice");
    expect(tool).toBeDefined();
    const props = (tool!.input_schema as { properties: Record<string, unknown> }).properties;
    expect(props).toHaveProperty("question");
    expect(props).toHaveProperty("mode");
    expect(props).toHaveProperty("options");
    expect(props).toHaveProperty("confirm_tool");
    expect(props).toHaveProperty("confirm_input");
  });

  it("is excluded from runTool's generic dispatch — it must be intercepted before reaching here", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("ask-user-choice-runtool"));
    const result = await runTool(user.id, "ask_user_choice", {});
    expect(result).toEqual({ error: "unknown tool: ask_user_choice" });
  });
});

describe("buildSystemPrompt ask_user_choice rule", () => {
  it("instructs the model to confirm archiving via ask_user_choice instead of prose", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("ask-user-choice-rule"));
    const prompt = buildSystemPrompt(user.id);
    expect(prompt).toContain("ask_user_choice");
  });
});
```

Create `server/src/ai/assistant.askUserChoice.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({ messages: { create: mockCreate } })),
}));

import { runAssistantChat } from "./assistant.js";
import { findOrCreateUserByEmail } from "../db/store.js";

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

beforeEach(() => {
  mockCreate.mockReset();
  process.env.ANTHROPIC_API_KEY = "test-key";
});

function toolUseResponse(name: string, input: Record<string, unknown>) {
  return { content: [{ type: "tool_use", id: "tool_1", name, input }] };
}

describe("runAssistantChat — ask_user_choice", () => {
  it("ends the turn immediately on a confirm choice, with Yes/No buttons", async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse("ask_user_choice", {
        question: "Archive 3 emails from Nike?",
        mode: "confirm",
        confirm_tool: "archive_messages",
        confirm_input: { account_id: 1, query: "from:nike" },
      })
    );
    const user = findOrCreateUserByEmail(uniqueEmail("confirm-choice"));

    const reply = await runAssistantChat(user.id, [{ role: "user", content: "archive nike emails" }]);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(reply.choice?.mode).toBe("confirm");
    expect(reply.choice?.buttons).toEqual([
      { key: "yes", label: "Yes" },
      { key: "no", label: "No" },
    ]);
    expect(reply.text).toContain("Archive 3 emails from Nike?");
  });

  it("ends the turn immediately on a resume choice, with one button per option", async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse("ask_user_choice", {
        question: "Which Sarah did you mean?",
        mode: "resume",
        options: [{ label: "Sarah Chen <sarah.chen@acme.com>" }, { label: "Sarah Lee <sarah.lee@acme.com>" }],
      })
    );
    const user = findOrCreateUserByEmail(uniqueEmail("resume-choice"));

    const reply = await runAssistantChat(user.id, [{ role: "user", content: "email sarah about the invoice" }]);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(reply.choice?.mode).toBe("resume");
    expect(reply.choice?.buttons).toEqual([
      { key: "0", label: "Sarah Chen <sarah.chen@acme.com>" },
      { key: "1", label: "Sarah Lee <sarah.lee@acme.com>" },
    ]);
  });

  it("returns plain text with no choice when the model doesn't call ask_user_choice", async () => {
    mockCreate.mockResolvedValueOnce({ content: [{ type: "text", text: "Sure, done." }] });
    const user = findOrCreateUserByEmail(uniqueEmail("no-choice"));

    const reply = await runAssistantChat(user.id, [{ role: "user", content: "hi" }]);

    expect(reply).toEqual({ text: "Sure, done." });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/ai/assistant.test.ts src/ai/assistant.askUserChoice.test.ts`
Expected: FAIL — `ask_user_choice` tool doesn't exist yet; `runAssistantChat` still returns a bare string, so `reply.choice` is `undefined` and `reply.text` is `undefined` (TypeScript compile error on `reply.choice`/`reply.text` access, or at minimum failing assertions once transpiled loosely).

- [ ] **Step 3: Implement**

In `server/src/ai/assistant.ts`, add the import at the top (alongside the other `db/store.js` imports):

```ts
  createPendingAction,
```

Add the tool schema to `ALWAYS_ON_TOOLS`, right before the array's closing `];` (currently line 544), i.e. right after the `respond_to_invoice_forward_prompt` entry's closing `},`:

```ts
  {
    name: "ask_user_choice",
    description:
      "Ask the user a closed-set question and get back a real tappable answer (WhatsApp buttons or a list) instead of free text. Call this ALONE — the only tool call in your turn — after you already have whatever information you need (e.g. call search_contacts first, look at the results, then call ask_user_choice in your NEXT turn once you can see them). Use mode='confirm' before a bulk or destructive action: pass confirm_tool and confirm_input set to the exact tool call you'd make if the user says yes — you do not execute it yourself, it only runs if they tap Yes. Use mode='resume' to disambiguate between 2-10 candidates (e.g. multiple contacts matching a name): pass one option per candidate; whichever one is tapped comes back to you as a normal follow-up message.",
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to show the user." },
        mode: { type: "string", enum: ["confirm", "resume"] },
        options: {
          type: "array",
          description: "Required for mode='resume': 2-10 choices to present. Not used for mode='confirm' (always rendered as Yes/No).",
          items: {
            type: "object",
            properties: { label: { type: "string" } },
            required: ["label"],
          },
        },
        confirm_tool: {
          type: "string",
          description: "Required for mode='confirm': the exact tool name to call if the user taps Yes.",
        },
        confirm_input: {
          type: "object",
          description: "Required for mode='confirm': the exact input to pass to confirm_tool if the user taps Yes.",
        },
      },
      required: ["question", "mode"],
    },
  },
```

Add the new types right before `export interface ChatMessage` (currently line 927):

```ts
export interface PendingChoiceButton {
  key: string;
  label: string;
}

export interface AssistantReply {
  text: string;
  choice?: {
    actionId: string;
    question: string;
    mode: "confirm" | "resume";
    buttons: PendingChoiceButton[];
  };
}

// Builds the AssistantReply for an ask_user_choice tool call and persists the pending_actions
// row it refers to. Never called for anything else — see runAssistantChat's loop below, which
// intercepts ask_user_choice before it would otherwise reach runTool's generic dispatch (runTool
// has no case for it and returns "unknown tool" if ever called directly — see its test).
function buildChoiceReply(ownerId: number, input: Record<string, unknown>): AssistantReply {
  const question = input.question as string;
  const mode = input.mode as "confirm" | "resume";

  if (mode === "confirm") {
    const tool = input.confirm_tool as string;
    const confirmInput = (input.confirm_input as Record<string, unknown>) ?? {};
    const actionId = createPendingAction(
      ownerId,
      "confirm",
      question,
      JSON.stringify({ tool, input: confirmInput })
    );
    return {
      text: `${question} Reply yes or no.`,
      choice: {
        actionId,
        question,
        mode: "confirm",
        buttons: [
          { key: "yes", label: "Yes" },
          { key: "no", label: "No" },
        ],
      },
    };
  }

  const options = (input.options as { label: string }[] | undefined) ?? [];
  const actionId = createPendingAction(
    ownerId,
    "resume",
    question,
    JSON.stringify({ options: options.map((o) => o.label) })
  );
  return {
    text: `${question}\n${options.map((o, i) => `${i + 1}. ${o.label}`).join("\n")}`,
    choice: {
      actionId,
      question,
      mode: "resume",
      buttons: options.map((o, i) => ({ key: String(i), label: o.label })),
    },
  };
}
```

In `buildRules` (currently lines 932-962), make three edits:

1. Replace the archive bullet:
```ts
    '- You can archive emails and apply labels/categories directly — archiving is fully reversible (the email is just removed from the inbox, never deleted) so you don\'t need to ask permission first, but do confirm if the query is broad or ambiguous (e.g. "archive everything" with no filter).',
```
with:
```ts
    '- You can archive emails and apply labels/categories directly — archiving is fully reversible (the email is just removed from the inbox, never deleted) so you don\'t need to ask permission first, but when the query is broad or ambiguous (e.g. "archive everything" with no filter), confirm first with ask_user_choice(mode="confirm", confirm_tool="archive_messages", confirm_input=<the exact call>) instead of asking in prose.',
```

2. Add a new bullet right after the `search_contacts` bullet ("Use search_contacts to resolve a name to an email address..."):
```ts
    "- If search_contacts (or any lookup) returns more than one plausible match and it's not obvious which one is meant, use ask_user_choice(mode=\"resume\") with one option per candidate instead of listing them in prose and waiting for a typed reply.",
```

3. Add a new general bullet near the top of `base` (right after the first anti-hallucination bullet):
```ts
    "- ask_user_choice renders real tappable buttons/a list on WhatsApp instead of asking in prose — use it for confirm-before-destructive-action and for disambiguating between candidates (see the archive and search_contacts rules below for the two concrete cases). Call it alone, as the only tool call in your turn.",
```

Now update `delete_calendar_event`'s tool description (currently, around line 328) — append a sentence:
```ts
    name: "delete_calendar_event",
    description:
      "Delete/cancel a calendar event. Get the event_id from list_upcoming_events first. Confirm with the user via ask_user_choice(mode=\"confirm\") before deleting unless they were explicit about which event — don't ask in prose.",
```

Finally, change the loop in `runAssistantChat` (currently lines 1053-1103):

```ts
  for (let turn = 0; turn < 8; turn++) {
    const response = await anthropic.messages.create({
      model,
      max_tokens: 4096,
      ...(useThinking ? { thinking: { type: "adaptive" as const } } : {}),
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral", ttl: "1h" } }],
      tools: buildToolsForOwner(ownerId),
      messages,
    });

    const toolUses = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );

    if (toolUses.length === 0) {
      const text = response.content.find(
        (b): b is Anthropic.TextBlock => b.type === "text"
      );
      return { text: text?.text ?? "" };
    }

    // ask_user_choice is a hard stop, not a tool result to feed back to the model — the system
    // prompt tells the model to call it alone, so any other tool_use blocks in this same
    // response are ignored rather than run.
    const choiceUse = toolUses.find((t) => t.name === "ask_user_choice");
    if (choiceUse) {
      return buildChoiceReply(ownerId, choiceUse.input as Record<string, unknown>);
    }

    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
      toolUses.map(async (toolUse) => {
        try {
          const result = await runTool(ownerId, toolUse.name, toolUse.input as Record<string, unknown>);
          return {
            type: "tool_result" as const,
            tool_use_id: toolUse.id,
            content: JSON.stringify(result),
          };
        } catch (err) {
          console.error(`assistant: tool "${toolUse.name}" threw`, err);
          return {
            type: "tool_result" as const,
            tool_use_id: toolUse.id,
            content: `Error: ${(err as Error).message}`,
            is_error: true,
          };
        }
      })
    );

    messages.push({ role: "user", content: toolResults });
  }

  return { text: "I wasn't able to finish that within my tool-call limit — try a more specific request." };
}
```

And change the function's declared return type:
```ts
export async function runAssistantChat(ownerId: number, history: ChatMessage[]): Promise<AssistantReply> {
```

Now fix the three other callers so the codebase compiles:

`server/src/routes/assistantRoutes.ts` — change:
```ts
    const reply = await runAssistantChat((req as unknown as AuthedRequest).userId, history);
    res.json({ reply });
```
to:
```ts
    const reply = await runAssistantChat((req as unknown as AuthedRequest).userId, history);
    res.json({ reply: reply.text });
```

`server/src/eval/grounding.eval.ts` — change:
```ts
    lastReply = await runAssistantChat(ownerId, history);
```
to:
```ts
    lastReply = (await runAssistantChat(ownerId, history)).text;
```

`server/src/routes/whatsappRoutes.ts` — at all three call sites (in `handleLink`, `handleText`, `handleMedia`), change:
```ts
  const reply = await runAssistantChat(ownerId, history);
  appendWhatsAppMessage(ownerId, from, "assistant", reply);
  await sendWhatsAppMessage(from, reply);
```
to:
```ts
  const reply = (await runAssistantChat(ownerId, history)).text;
  appendWhatsAppMessage(ownerId, from, "assistant", reply);
  await sendWhatsAppMessage(from, reply);
```
(This is a deliberately minimal fix to keep compiling and behaving exactly as before — Task 4 replaces this with real choice rendering.)

`server/src/routes/whatsappRoutes.test.ts` — change:
```ts
    vi.mocked(runAssistantChat).mockResolvedValue("a real reply");
```
to:
```ts
    vi.mocked(runAssistantChat).mockResolvedValue({ text: "a real reply" });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/ai/assistant.test.ts src/ai/assistant.askUserChoice.test.ts src/routes/assistantRoutes.test.ts src/routes/whatsappRoutes.test.ts`
Expected: PASS. Then run the full suite to catch any other caller: `cd server && npm test`
Expected: PASS (no remaining compile errors referencing `runAssistantChat`'s old string return).

- [ ] **Step 5: Commit**

```bash
cd server && git add -A
git commit -m "feat: add ask_user_choice tool, end assistant turn on it

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UVDsGYAg9S8QaXoudzaxpE"
```

---

### Task 4: Render `AssistantReply.choice` on WhatsApp

**Files:**
- Create: `server/src/services/whatsappReply.ts`
- Create: `server/src/services/whatsappReply.test.ts`
- Modify: `server/src/routes/whatsappRoutes.ts` (replace the three minimal `.text`-only call sites from Task 3 with `sendAssistantReply`)
- Modify: `server/src/routes/whatsappRoutes.test.ts` (extend)

**Interfaces:**
- Consumes: `AssistantReply` (Task 3, `../ai/assistant.js`), `sendChoiceMessage`/`sendWhatsAppMessage` (Task 2 / existing, `../providers/whatsapp.js`), `appendWhatsAppMessage` (existing, `../db/store.js`).
- Produces: `export async function sendAssistantReply(ownerId: number, phone: string, reply: AssistantReply): Promise<void>`

This is its own module (not a function inside `whatsappRoutes.ts`) because Task 5's `actionHandlers.ts` needs it too, and `actionHandlers.ts` will itself be imported by `whatsappRoutes.ts` — putting it in `whatsappRoutes.ts` would create a circular import.

- [ ] **Step 1: Write the failing test**

Create `server/src/services/whatsappReply.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/store.js", () => ({
  appendWhatsAppMessage: vi.fn(),
}));
vi.mock("../providers/whatsapp.js", () => ({
  sendWhatsAppMessage: vi.fn().mockResolvedValue(undefined),
  sendChoiceMessage: vi.fn().mockResolvedValue(undefined),
}));

const { appendWhatsAppMessage } = await import("../db/store.js");
const { sendWhatsAppMessage, sendChoiceMessage } = await import("../providers/whatsapp.js");
const { sendAssistantReply } = await import("./whatsappReply.js");

beforeEach(() => {
  vi.mocked(appendWhatsAppMessage).mockClear();
  vi.mocked(sendWhatsAppMessage).mockClear();
  vi.mocked(sendChoiceMessage).mockClear();
});

describe("sendAssistantReply", () => {
  it("sends plain text and persists it when there's no choice", async () => {
    await sendAssistantReply(1, "44700", { text: "Sure, done." });

    expect(appendWhatsAppMessage).toHaveBeenCalledWith(1, "44700", "assistant", "Sure, done.");
    expect(sendWhatsAppMessage).toHaveBeenCalledWith("44700", "Sure, done.");
    expect(sendChoiceMessage).not.toHaveBeenCalled();
  });

  it("renders a choice as pa:-prefixed ids instead of plain text", async () => {
    await sendAssistantReply(1, "44700", {
      text: "Archive 3 emails from Nike? Reply yes or no.",
      choice: {
        actionId: "abc-123",
        question: "Archive 3 emails from Nike?",
        mode: "confirm",
        buttons: [
          { key: "yes", label: "Yes" },
          { key: "no", label: "No" },
        ],
      },
    });

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(sendChoiceMessage).toHaveBeenCalledWith("44700", "Archive 3 emails from Nike?", [
      { id: "pa:abc-123:yes", title: "Yes" },
      { id: "pa:abc-123:no", title: "No" },
    ]);
    // The full fallback text (not just the bare question) is still what's persisted to history.
    expect(appendWhatsAppMessage).toHaveBeenCalledWith(
      1,
      "44700",
      "assistant",
      "Archive 3 emails from Nike? Reply yes or no."
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run src/services/whatsappReply.test.ts`
Expected: FAIL — `./whatsappReply.js` does not exist.

- [ ] **Step 3: Implement**

Create `server/src/services/whatsappReply.ts`:

```ts
// Sends a runAssistantChat result over WhatsApp — plain text normally, or a tappable choice
// message when the assistant called ask_user_choice. Shared by the three ordinary inbound-message
// handlers (whatsappRoutes.ts) and the pending-action resume path (actionHandlers.ts) — a resume
// reply that itself needs another ask_user_choice renders exactly the same way a first-turn one
// does. Lives in its own module rather than inside whatsappRoutes.ts because actionHandlers.ts
// needs it too, and whatsappRoutes.ts imports actionHandlers.ts — putting it in whatsappRoutes.ts
// would create a circular import.
import { appendWhatsAppMessage } from "../db/store.js";
import { sendWhatsAppMessage, sendChoiceMessage } from "../providers/whatsapp.js";
import type { AssistantReply } from "../ai/assistant.js";

export async function sendAssistantReply(
  ownerId: number,
  phone: string,
  reply: AssistantReply
): Promise<void> {
  appendWhatsAppMessage(ownerId, phone, "assistant", reply.text);

  if (!reply.choice) {
    await sendWhatsAppMessage(phone, reply.text);
    return;
  }

  const choice = reply.choice;
  const choices = choice.buttons.map((b) => ({
    id: `pa:${choice.actionId}:${b.key}`,
    title: b.label,
  }));
  await sendChoiceMessage(phone, choice.question, choices);
}
```

In `server/src/routes/whatsappRoutes.ts`:
- Add the import: `import { sendAssistantReply } from "../services/whatsappReply.js";`
- At each of the three call sites, replace:
```ts
  const reply = (await runAssistantChat(ownerId, history)).text;
  appendWhatsAppMessage(ownerId, from, "assistant", reply);
  await sendWhatsAppMessage(from, reply);
```
with:
```ts
  const reply = await runAssistantChat(ownerId, history);
  await sendAssistantReply(ownerId, from, reply);
```

Note `appendWhatsAppMessage` and `sendWhatsAppMessage` may now be unused imports in `whatsappRoutes.ts` at those specific call sites but are still used elsewhere in the file (e.g. `appendWhatsAppMessage(ownerId, from, "user", text)` earlier in `handleText`, and `sendWhatsAppMessage` in `handleLink`'s failure branch and the top-level catch) — leave both imports as-is.

- [ ] **Step 4: Update whatsappRoutes.test.ts and run tests to verify they pass**

Add one test to `server/src/routes/whatsappRoutes.test.ts` confirming the wiring (append to the existing "still routes an ordinary message to the real assistant" describe block or a new one):

```ts
vi.mock("../services/whatsappReply.js", () => ({
  sendAssistantReply: vi.fn(),
}));
```
(add this alongside the other `vi.mock` calls at the top of the file)

```ts
const { sendAssistantReply } = await import("../services/whatsappReply.js");
```
(add alongside the other `await import` lines)

```ts
describe("handleIncoming — routes runAssistantChat's result through sendAssistantReply", () => {
  it("passes the full AssistantReply through, not just .text", async () => {
    vi.mocked(runAssistantChat).mockResolvedValue({ text: "a real reply" });

    await handleIncoming({ kind: "text", from: "447900000002", text: "what's on my calendar today?", messageId: "m3" });

    expect(sendAssistantReply).toHaveBeenCalledWith(42, "447900000002", { text: "a real reply" });
  });
});
```

Run: `cd server && npx vitest run src/services/whatsappReply.test.ts src/routes/whatsappRoutes.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd server && git add -A
git commit -m "feat: render ask_user_choice as tappable WhatsApp buttons/list

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UVDsGYAg9S8QaXoudzaxpE"
```

---

### Task 5: Consuming a tap — `actionHandlers.ts`

**Files:**
- Create: `server/src/services/actionHandlers.ts`
- Create: `server/src/services/actionHandlers.test.ts`
- Modify: `server/src/routes/whatsappRoutes.ts` (wire `handlePendingActionReply` into `handleIncoming`)
- Modify: `server/src/routes/whatsappRoutes.test.ts` (extend)

**Interfaces:**
- Consumes: `consumePendingAction` (Task 1, `../db/store.js`), `runTool`/`runAssistantChat`/`MAX_HISTORY_MESSAGES` (Task 3, `../ai/assistant.js`), `sendWhatsAppMessage` (`../providers/whatsapp.js`), `sendAssistantReply` (Task 4, `./whatsappReply.js`), `appendWhatsAppMessage`/`getWhatsAppHistory` (`../db/store.js`), `IncomingWhatsAppMessage` (`../providers/whatsapp.js`).
- Produces: `export async function handlePendingActionReply(ownerId: number, message: IncomingWhatsAppMessage): Promise<boolean>` — `true` if the message was a pending-action tap and has been fully handled, `false` otherwise (falls through to normal handling, same contract as `handlePostConnectSetupReply`).

- [ ] **Step 1: Write the failing tests**

Create `server/src/services/actionHandlers.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/store.js", () => ({
  consumePendingAction: vi.fn(),
  appendWhatsAppMessage: vi.fn(),
  getWhatsAppHistory: vi.fn().mockReturnValue([]),
}));
vi.mock("../ai/assistant.js", () => ({
  runTool: vi.fn(),
  runAssistantChat: vi.fn(),
  MAX_HISTORY_MESSAGES: 12,
}));
vi.mock("../providers/whatsapp.js", () => ({
  sendWhatsAppMessage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./whatsappReply.js", () => ({
  sendAssistantReply: vi.fn().mockResolvedValue(undefined),
}));

const { consumePendingAction, appendWhatsAppMessage, getWhatsAppHistory } = await import("../db/store.js");
const { runTool, runAssistantChat } = await import("../ai/assistant.js");
const { sendWhatsAppMessage } = await import("../providers/whatsapp.js");
const { sendAssistantReply } = await import("./whatsappReply.js");
const { handlePendingActionReply } = await import("./actionHandlers.js");

beforeEach(() => {
  vi.mocked(consumePendingAction).mockReset();
  vi.mocked(appendWhatsAppMessage).mockClear();
  vi.mocked(getWhatsAppHistory).mockReset().mockReturnValue([]);
  vi.mocked(runTool).mockReset();
  vi.mocked(runAssistantChat).mockReset();
  vi.mocked(sendWhatsAppMessage).mockClear();
  vi.mocked(sendAssistantReply).mockClear();
});

describe("handlePendingActionReply", () => {
  it("returns false for a non-interactive message", async () => {
    const result = await handlePendingActionReply(1, { kind: "text", from: "44700", text: "hi", messageId: "m1" });
    expect(result).toBe(false);
    expect(consumePendingAction).not.toHaveBeenCalled();
  });

  it("returns false when the buttonId isn't a pa: id (e.g. a post-connect-setup button)", async () => {
    const result = await handlePendingActionReply(1, {
      kind: "interactive",
      from: "44700",
      messageId: "m2",
      buttonId: "briefing_yes",
    });
    expect(result).toBe(false);
    expect(consumePendingAction).not.toHaveBeenCalled();
  });

  it("sends the expired message when consumePendingAction returns null", async () => {
    vi.mocked(consumePendingAction).mockReturnValue(null);

    const result = await handlePendingActionReply(1, {
      kind: "interactive",
      from: "44700",
      messageId: "m3",
      buttonId: "pa:abc-123:yes",
    });

    expect(result).toBe(true);
    expect(sendWhatsAppMessage).toHaveBeenCalledWith("44700", "That option has expired — just ask me again.");
  });

  it("confirm + yes: runs the stored tool and sends a description of the result", async () => {
    vi.mocked(consumePendingAction).mockReturnValue({
      id: "abc-123",
      ownerId: 1,
      mode: "confirm",
      question: "Archive 3 emails from Nike?",
      contextJson: JSON.stringify({ tool: "archive_messages", input: { account_id: 1, query: "from:nike" } }),
    });
    vi.mocked(runTool).mockResolvedValue({ archived: 3 });

    const result = await handlePendingActionReply(1, {
      kind: "interactive",
      from: "44700",
      messageId: "m4",
      buttonId: "pa:abc-123:yes",
    });

    expect(result).toBe(true);
    expect(runTool).toHaveBeenCalledWith(1, "archive_messages", { account_id: 1, query: "from:nike" });
    expect(sendWhatsAppMessage).toHaveBeenCalledWith("44700", "✓ Archived 3 messages.");
  });

  it("confirm + no: cancels without calling runTool", async () => {
    vi.mocked(consumePendingAction).mockReturnValue({
      id: "abc-123",
      ownerId: 1,
      mode: "confirm",
      question: "Archive 3 emails from Nike?",
      contextJson: JSON.stringify({ tool: "archive_messages", input: {} }),
    });

    const result = await handlePendingActionReply(1, {
      kind: "interactive",
      from: "44700",
      messageId: "m5",
      buttonId: "pa:abc-123:no",
    });

    expect(result).toBe(true);
    expect(runTool).not.toHaveBeenCalled();
    expect(sendWhatsAppMessage).toHaveBeenCalledWith("44700", "Cancelled.");
  });

  it("resume: injects a synthetic user message and forwards runAssistantChat's reply", async () => {
    vi.mocked(consumePendingAction).mockReturnValue({
      id: "abc-123",
      ownerId: 1,
      mode: "resume",
      question: "Which Sarah did you mean?",
      contextJson: JSON.stringify({ options: ["Sarah Chen <sarah.chen@acme.com>", "Sarah Lee <sarah.lee@acme.com>"] }),
    });
    vi.mocked(runAssistantChat).mockResolvedValue({ text: "Drafted an email to Sarah Chen." });

    const result = await handlePendingActionReply(1, {
      kind: "interactive",
      from: "44700",
      messageId: "m6",
      buttonId: "pa:abc-123:0",
    });

    expect(result).toBe(true);
    expect(appendWhatsAppMessage).toHaveBeenCalledWith(
      1,
      "44700",
      "user",
      "(User selected: Sarah Chen <sarah.chen@acme.com>)"
    );
    expect(runAssistantChat).toHaveBeenCalled();
    expect(sendAssistantReply).toHaveBeenCalledWith(1, "44700", { text: "Drafted an email to Sarah Chen." });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/services/actionHandlers.test.ts`
Expected: FAIL — `./actionHandlers.js` does not exist.

- [ ] **Step 3: Implement**

Create `server/src/services/actionHandlers.ts`:

```ts
// Consumes a tap on a pending-actions message (see ai/assistant.ts's ask_user_choice /
// db/store.ts's pending_actions table). Called from whatsappRoutes.ts's handleIncoming right
// after the post-connect-setup check, with the same contract: returns false to fall through to
// normal handling for anything that isn't one of these taps.
import { consumePendingAction, appendWhatsAppMessage, getWhatsAppHistory } from "../db/store.js";
import { runTool, runAssistantChat, MAX_HISTORY_MESSAGES } from "../ai/assistant.js";
import { sendWhatsAppMessage } from "../providers/whatsapp.js";
import { sendAssistantReply } from "./whatsappReply.js";
import type { IncomingWhatsAppMessage } from "../providers/whatsapp.js";

const EXPIRED_REPLY = "That option has expired — just ask me again.";

// Friendly per-tool confirmation text for a zero-LLM confirm execution — falls back to a generic
// "done" for any tool without a specific entry here.
const CONFIRM_RESULT_LABEL: Record<string, (result: unknown) => string> = {
  archive_messages: (result) => {
    const archived = (result as { archived?: number } | undefined)?.archived;
    return typeof archived === "number"
      ? `✓ Archived ${archived} message${archived === 1 ? "" : "s"}.`
      : "✓ Done.";
  },
  delete_calendar_event: () => "✓ Deleted.",
};

function describeToolResult(tool: string, result: unknown): string {
  const describe = CONFIRM_RESULT_LABEL[tool];
  return describe ? describe(result) : "✓ Done.";
}

// A pending-action tap id is `pa:<uuid>:<key>` — see ai/assistant.ts's buildChoiceReply, which
// generates these. Anything else (e.g. postConnectSetup.ts's plain "briefing_yes"-style ids)
// doesn't match and falls through.
function parseTapId(buttonId: string): { actionId: string; key: string } | null {
  const match = /^pa:([0-9a-f-]{36}):(.+)$/.exec(buttonId);
  if (!match) return null;
  return { actionId: match[1], key: match[2] };
}

export async function handlePendingActionReply(
  ownerId: number,
  message: IncomingWhatsAppMessage
): Promise<boolean> {
  if (message.kind !== "interactive") return false;
  const parsed = parseTapId(message.buttonId);
  if (!parsed) return false;

  const phone = message.from;
  const action = consumePendingAction(parsed.actionId, ownerId);
  if (!action) {
    await sendWhatsAppMessage(phone, EXPIRED_REPLY);
    return true;
  }

  if (action.mode === "confirm") {
    if (parsed.key !== "yes") {
      appendWhatsAppMessage(ownerId, phone, "assistant", "Cancelled.");
      await sendWhatsAppMessage(phone, "Cancelled.");
      return true;
    }
    const { tool, input } = JSON.parse(action.contextJson) as {
      tool: string;
      input: Record<string, unknown>;
    };
    try {
      const result = await runTool(ownerId, tool, input);
      const confirmText = describeToolResult(tool, result);
      appendWhatsAppMessage(ownerId, phone, "assistant", confirmText);
      await sendWhatsAppMessage(phone, confirmText);
    } catch (err) {
      console.error("actionHandlers: confirmed tool call failed", err);
      await sendWhatsAppMessage(
        phone,
        "Sorry, that didn't go through — check the server logs."
      ).catch(() => {});
    }
    return true;
  }

  // resume
  const { options } = JSON.parse(action.contextJson) as { options: string[] };
  const label = options[Number(parsed.key)];
  if (label === undefined) {
    await sendWhatsAppMessage(phone, EXPIRED_REPLY);
    return true;
  }
  appendWhatsAppMessage(ownerId, phone, "user", `(User selected: ${label})`);
  const history = getWhatsAppHistory(phone, MAX_HISTORY_MESSAGES).map((m) => ({
    role: m.role,
    content: m.content,
  }));
  const reply = await runAssistantChat(ownerId, history);
  await sendAssistantReply(ownerId, phone, reply);
  return true;
}
```

Now wire it into `server/src/routes/whatsappRoutes.ts`:
- Add the import: `import { handlePendingActionReply } from "../services/actionHandlers.js";`
- In `handleIncoming`, right after the existing:
```ts
  if (await handlePostConnectSetupReply(ownerId, message)) return;
```
add:
```ts
  if (await handlePendingActionReply(ownerId, message)) return;
```

- [ ] **Step 4: Update whatsappRoutes.test.ts and run tests to verify they pass**

Add to the mocks at the top of `server/src/routes/whatsappRoutes.test.ts`:
```ts
vi.mock("../services/actionHandlers.js", () => ({
  handlePendingActionReply: vi.fn().mockResolvedValue(false),
}));
```
and:
```ts
const { handlePendingActionReply } = await import("../services/actionHandlers.js");
```
and in the `beforeEach`:
```ts
  vi.mocked(handlePendingActionReply).mockReset().mockResolvedValue(false);
```

Add a test confirming the wiring order (a pending-action tap is checked, and consumed before falling through to the "unexpected interactive message" log branch):

```ts
describe("handleIncoming — pending-action taps", () => {
  it("is handled by handlePendingActionReply and never reaches the assistant", async () => {
    vi.mocked(handlePendingActionReply).mockResolvedValue(true);

    await handleIncoming({ kind: "interactive", from: "447900000003", messageId: "m7", buttonId: "pa:abc:yes" });

    expect(handlePendingActionReply).toHaveBeenCalledWith(42, {
      kind: "interactive",
      from: "447900000003",
      messageId: "m7",
      buttonId: "pa:abc:yes",
    });
    expect(runAssistantChat).not.toHaveBeenCalled();
  });
});
```

Run: `cd server && npx vitest run src/services/actionHandlers.test.ts src/routes/whatsappRoutes.test.ts`
Expected: PASS. Then: `cd server && npm test`
Expected: PASS (full suite).

- [ ] **Step 5: Commit**

```bash
cd server && git add -A
git commit -m "feat: consume WhatsApp pending-action taps (confirm/resume)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UVDsGYAg9S8QaXoudzaxpE"
```

---

### Task 6: Sweep expired pending actions

**Files:**
- Modify: `server/src/services/scheduler.ts` (import `deleteExpiredPendingActions`, call it once per tick)

**Interfaces:**
- Consumes: `deleteExpiredPendingActions` (Task 1, `../db/store.js`).

There's no existing `scheduler.test.ts` in this codebase (the scheduler's per-user loop and `setInterval` aren't unit-tested anywhere today) — expiry correctness is already covered by Task 1's `pendingActions.test.ts`, so this task only wires the sweep in; it doesn't add a new test file. This is a deliberate deviation from strict TDD for this one task, since there's no established pattern here to extend and the function being called is already fully tested.

- [ ] **Step 1: Add the import and the call**

In `server/src/services/scheduler.ts`, add `deleteExpiredPendingActions` to the existing `../db/store.js` import:

```ts
import {
  getSetting,
  setSetting,
  listPhoneNumbersForUser,
  listAllCheckinsAscending,
  listAllUserIds,
  getEnabledTools,
  deleteExpiredPendingActions,
} from "../db/store.js";
```

Then, in `tick()`, call it once before the per-user loop (hygiene sweep, not scoped to a tenant):

```ts
async function tick(): Promise<void> {
  deleteExpiredPendingActions();
  for (const ownerId of listAllUserIds()) {
    ...
```

- [ ] **Step 2: Run the full test suite to confirm nothing broke**

Run: `cd server && npm test`
Expected: PASS (no scheduler test exists to add an assertion to, but this confirms the import/wiring compiles and nothing else regressed).

- [ ] **Step 3: Commit**

```bash
cd server && git add src/services/scheduler.ts
git commit -m "feat: sweep expired pending_actions rows each scheduler tick

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UVDsGYAg9S8QaXoudzaxpE"
```
