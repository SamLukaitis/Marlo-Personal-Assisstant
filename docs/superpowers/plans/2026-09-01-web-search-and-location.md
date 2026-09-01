# Web Search + WhatsApp Location Pin Reading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Marlowe a live web-search tool and the ability to read a WhatsApp location pin the user drops, so it can answer "what hotels/restaurants are nearby" style questions.

**Architecture:** Add Anthropic's built-in `web_search` server tool to the always-on tool list (no client-side execution — Anthropic runs the search and injects the result into the same model turn). Add a new `location` message kind to the WhatsApp inbound pipeline, parsed the same way `image`/`document` already are, and route it into the normal assistant loop as a synthesized user turn.

**Tech Stack:** TypeScript / Express / `@anthropic-ai/sdk` (^0.112.5, confirmed to export `Anthropic.WebSearchTool20250305` and the `Anthropic.ToolUnion` type used below) / Vitest.

**Spec:** `docs/superpowers/specs/2026-09-01-web-search-and-location-design.md`

## Global Constraints

- No Google Places or Geocoding API — no structured nearby-search results, no coordinates for anything Marlowe recommends.
- No outbound WhatsApp location message — recommendations get a Google Maps search-link URL in plain text instead.
- `web_search` is always on for every user — no new feature flag, no opt-out setting.
- No separate cost-metering/dashboard work for web search spend — token accounting continues through the existing `recordApiUsage` path unchanged.

---

## File Structure

- **Modify `server/src/ai/assistant.ts`** — add the `web_search` server tool to `ALWAYS_ON_TOOLS` (widening its type to `Anthropic.ToolUnion[]`, since `web_search` isn't a custom `Tool`), and add a system-prompt rule telling Marlowe when to use it and how to present a place recommendation (Maps link, no pin, no fabricated certainty).
- **Modify `server/src/providers/whatsapp.ts`** — add `IncomingLocationMessage`, add `"location"` to `HANDLED_TYPES`, parse Meta's `location` field in `extractIncomingMessages`.
- **Modify `server/src/services/chatDispatch.ts`** — add `handleLocation`, mirroring the existing `handleLink`/`handleMedia` shape (append a synthesized user turn, run the assistant loop, send the reply).
- **Modify `server/src/routes/whatsappRoutes.ts`** — import `handleLocation` and route `kind === "location"` to it from `handleIncoming`.
- **Modify `server/src/ai/assistant.test.ts`**, **`server/src/providers/whatsapp.test.ts`**, **`server/src/routes/whatsappRoutes.test.ts`** — new/updated tests (see each task).

**Note on the spec's testing section:** the spec suggested adding `web_search` grounding cases to `grounding.eval.ts`. That harness grades replies against a fixed, hand-authored `groundTruth` seeded into mocked/fake data (see `fixtures.ts`) — it has no mechanism for grading a live, real web search result (there's no fixed ground truth for "what hotel is near X" and no way to mock Anthropic's server-side search the way `hub.js` is mocked for email/calendar). Wiring this in would make the eval non-deterministic for reasons unrelated to the code. Task 1 instead adds a plain, deterministic unit test asserting `web_search` is present in the tool list every user gets — that's the part of "does Marlowe actually reach for it" that's meaningfully testable without a live model call. Mention this to the user as a deviation from the written spec when the plan is handed off.

**Note on the spec's file for `handleLocation`'s tests:** the spec named `chatDispatch.test.ts`. `chatDispatch.ts` has no test file of its own today — `whatsappRoutes.test.ts` already mocks every dependency `chatDispatch.ts` needs (`db/store.js`, `ai/assistant.js`, `services/whatsappReply.js`, `providers/whatsapp.js`, etc.) and already exercises `handleText`'s *real* implementation through `handleIncoming` this way (see its "still routes an ordinary message to the real assistant" test). Task 3 follows that existing pattern and adds `handleLocation` coverage to `whatsappRoutes.test.ts` rather than standing up a parallel mock setup in a new file.

---

## Task 1: `web_search` tool + system prompt guidance

**Files:**
- Modify: `server/src/ai/assistant.ts:126` (`ALWAYS_ON_TOOLS` declaration), `server/src/ai/assistant.ts:637-649` (end of the `ALWAYS_ON_TOOLS` array), `server/src/ai/assistant.ts:706` (`buildToolsForOwner` return type), `server/src/ai/assistant.ts:1150-1173` (`buildRules`'s `base` array)
- Test: `server/src/ai/assistant.test.ts`

**Interfaces:**
- Produces: `ALWAYS_ON_TOOLS: Anthropic.ToolUnion[]` (was `Anthropic.Tool[]`) includes an entry `{ name: "web_search", type: "web_search_20250305" }`. `buildToolsForOwner(ownerId: number): Anthropic.ToolUnion[]` (return type widened from `Anthropic.Tool[]`; every existing call site — `runAssistantChat`'s `tools: buildToolsForOwner(ownerId)` at `assistant.ts:1320` — already expects `Array<ToolUnion>`, so no caller changes needed).

- [ ] **Step 1: Write the failing tool-list test**

In `server/src/ai/assistant.test.ts`, inside the existing `describe("buildToolsForOwner", ...)` block (starts at line 40), add:

```ts
  it("includes web_search for every user, regardless of which conditional tools are enabled", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("web-search"));
    const names = buildToolsForOwner(user.id).map((t) => t.name);
    expect(names).toContain("web_search");
  });
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -- assistant.test.ts` (from `server/`)
Expected: FAIL — `expect(names).toContain("web_search")` fails, "web_search" not in the list.

- [ ] **Step 3: Widen `ALWAYS_ON_TOOLS`'s type and add the tool**

In `server/src/ai/assistant.ts`, change the declaration at line 126:

```ts
const ALWAYS_ON_TOOLS: Anthropic.Tool[] = [
```

to:

```ts
const ALWAYS_ON_TOOLS: Anthropic.ToolUnion[] = [
```

Then, just before the closing `];` of that array (currently line 649, right after the `react_to_message` tool definition ending at line 648), add:

```ts
  // Anthropic's built-in web search — this is a *server* tool, not a custom one: Anthropic runs
  // the search itself and folds a web_search_tool_result block into this same response, so it
  // never produces a client-side tool_use block and never reaches runTool's switch below. Always
  // on for every user (no per-owner flag, unlike teams/travel) — see buildRules for when the
  // model should reach for it.
  {
    name: "web_search",
    type: "web_search_20250305",
  },
```

- [ ] **Step 4: Widen `buildToolsForOwner`'s return type**

At line 706, change:

```ts
export function buildToolsForOwner(ownerId: number): Anthropic.Tool[] {
```

to:

```ts
export function buildToolsForOwner(ownerId: number): Anthropic.ToolUnion[] {
```

- [ ] **Step 5: Run the test again and confirm it passes**

Run: `npm test -- assistant.test.ts`
Expected: PASS. Also re-run the pre-existing `"puts the cache_control breakpoint on the last tool in the array, whichever one that is"` test in the same file to confirm it still passes — it only checks `.cache_control` on the last element, which now may be the `web_search` entry for a no-conditional-tools user; the spread (`{ ...result[result.length - 1], cache_control: {...} }`) works on it the same as any other tool since `cache_control` is a valid optional field on every `ToolUnion` member.

- [ ] **Step 6: Write the failing system-prompt test**

In `server/src/ai/assistant.test.ts`, near the other `buildSystemPrompt` tests (e.g. after the Xero-related ones around line 344), add:

```ts
  it("tells the model when to use web_search and how to present a place recommendation", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("web-search-rule"));
    const prompt = buildSystemPrompt(user.id);
    expect(prompt).toContain("web_search");
    expect(prompt).toContain("google.com/maps/search");
  });
```

- [ ] **Step 7: Run it and confirm it fails**

Run: `npm test -- assistant.test.ts`
Expected: FAIL — neither string is in the prompt yet.

- [ ] **Step 8: Add the system prompt rule**

In `server/src/ai/assistant.ts`, in `buildRules`'s `base` array (ends at line 1172, just before the closing `];` at line 1173), add a new bullet:

```ts
    "- Use web_search for questions you don't have another tool for — nearby places (hotels, restaurants, attractions), current prices/events, or anything else that needs a live answer from the web rather than what you already know. Say plainly that you searched the web rather than presenting the answer as verified fact. When you recommend a specific place, include a Google Maps link built as https://www.google.com/maps/search/?api=1&query=<url-encoded name and address/area> so the user can open it directly — never invent coordinates, and never claim you've sent a location pin (you haven't).",
```

- [ ] **Step 9: Run the test again and confirm it passes**

Run: `npm test -- assistant.test.ts`
Expected: PASS.

- [ ] **Step 10: Run the full unit suite**

Run: `npm test` (from `server/`)
Expected: PASS — no regressions elsewhere (e.g. no other test asserts an exact `ALWAYS_ON_TOOLS`/`buildToolsForOwner` count or a fixed last-tool name for the no-conditional-tools case).

- [ ] **Step 11: Commit**

```bash
git add server/src/ai/assistant.ts server/src/ai/assistant.test.ts
git commit -m "feat: add web_search tool + usage guidance to Marlowe's system prompt"
```

---

## Task 2: Parse inbound WhatsApp location pins

**Files:**
- Modify: `server/src/providers/whatsapp.ts:428-476` (message-kind interfaces, union, `WebhookPayload`, `HANDLED_TYPES`), `server/src/providers/whatsapp.ts:478-561` (`extractIncomingMessages`)
- Test: `server/src/providers/whatsapp.test.ts`

**Interfaces:**
- Consumes: nothing new from other tasks.
- Produces:
  ```ts
  export interface IncomingLocationMessage {
    kind: "location";
    from: string;
    messageId: string;
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
  }
  ```
  added to the `IncomingWhatsAppMessage` union. Task 3 consumes this exact shape.

- [ ] **Step 1: Replace the stale "location falls back to unsupported" test**

In `server/src/providers/whatsapp.test.ts`, the `describe("extractIncomingMessages — unsupported message types", ...)` block (starts at line 134) currently has this test as its first case (lines 135-162):

```ts
  it("parses a location message into an IncomingUnsupportedMessage carrying its raw type", () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: "447000000001",
                    id: "wamid.loc",
                    type: "location",
                    location: { latitude: 51.5, longitude: -0.1 },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const messages = extractIncomingMessages(payload);

    expect(messages).toEqual([
      { kind: "unsupported", from: "447000000001", messageId: "wamid.loc", type: "location" },
    ]);
  });
```

This will start failing once location is handled — replace it with a sticker case (still genuinely unhandled), so the describe block keeps a real example of the fallback path:

```ts
  it("parses a sticker message into an IncomingUnsupportedMessage carrying its raw type", () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [{ from: "447000000001", id: "wamid.sticker1", type: "sticker" }],
              },
            },
          ],
        },
      ],
    };

    expect(extractIncomingMessages(payload)).toEqual([
      { kind: "unsupported", from: "447000000001", messageId: "wamid.sticker1", type: "sticker" },
    ]);
  });
```

(The existing second test in that block, `"parses a sticker message the same way"` at line 164, becomes a near-duplicate once this lands — delete it, since both would assert the identical sticker behavior.)

- [ ] **Step 2: Write the new failing location tests**

Add a new `describe` block right after the `"extractIncomingMessages — unsupported message types"` block (after its closing `});`):

```ts
describe("extractIncomingMessages — location", () => {
  it("parses a dropped pin with a name and address into an IncomingLocationMessage", () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: "447000000001",
                    id: "wamid.loc",
                    type: "location",
                    location: {
                      latitude: 51.5074,
                      longitude: -0.1278,
                      name: "Big Ben",
                      address: "London SW1A 0AA",
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    expect(extractIncomingMessages(payload)).toEqual([
      {
        kind: "location",
        from: "447000000001",
        messageId: "wamid.loc",
        latitude: 51.5074,
        longitude: -0.1278,
        name: "Big Ben",
        address: "London SW1A 0AA",
      },
    ]);
  });

  it("parses a raw pin with no name/address", () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: "447000000001",
                    id: "wamid.loc2",
                    type: "location",
                    location: { latitude: 51.5, longitude: -0.1 },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    expect(extractIncomingMessages(payload)).toEqual([
      { kind: "location", from: "447000000001", messageId: "wamid.loc2", latitude: 51.5, longitude: -0.1 },
    ]);
  });

  it("drops a location message missing coordinates rather than falling back to unsupported", () => {
    const payload = {
      entry: [
        {
          changes: [
            { value: { messages: [{ from: "447000000001", id: "wamid.loc3", type: "location", location: {} }] } },
          ],
        },
      ],
    };

    expect(extractIncomingMessages(payload)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the tests and confirm the right ones fail**

Run: `npm test -- whatsapp.test.ts` (from `server/`)
Expected: FAIL — the new `describe("extractIncomingMessages — location", ...)` tests fail (location still falls into `unsupported`); the replaced sticker test in Step 1 passes already (it exercises existing behavior), confirming Step 1's edit alone didn't break anything.

- [ ] **Step 4: Add the `IncomingLocationMessage` type**

In `server/src/providers/whatsapp.ts`, right after `IncomingReactionMessage` (ends at line 434) and before the `IncomingUnsupportedMessage` comment (line 436), add:

```ts
// A location the user dropped as a pin (or picked from a saved/named place). WhatsApp always
// sends latitude/longitude; name/address are only present when the user picked a named place
// rather than dropping a raw pin.
export interface IncomingLocationMessage {
  kind: "location";
  from: string;
  messageId: string;
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
}
```

Add it to the union (lines 446-451):

```ts
export type IncomingWhatsAppMessage =
  | IncomingTextMessage
  | IncomingMediaMessage
  | IncomingInteractiveMessage
  | IncomingReactionMessage
  | IncomingLocationMessage
  | IncomingUnsupportedMessage;
```

- [ ] **Step 5: Add `location` to `WebhookPayload`'s message shape**

In the `WebhookPayload` interface (lines 453-474), add a `location` field alongside `reaction`:

```ts
          reaction?: { message_id?: string; emoji?: string };
          location?: { latitude?: number; longitude?: number; name?: string; address?: string };
```

- [ ] **Step 6: Add `"location"` to `HANDLED_TYPES` and parse it in `extractIncomingMessages`**

Change line 476:

```ts
const HANDLED_TYPES = new Set(["text", "image", "document", "interactive", "reaction", "location"]);
```

In `extractIncomingMessages`, add a new branch right after the `document` branch (after the block ending at line 503, before the `interactive`/`button_reply` branch):

```ts
        } else if (
          m.type === "location" &&
          m.from &&
          m.id &&
          m.location?.latitude !== undefined &&
          m.location.longitude !== undefined
        ) {
          messages.push({
            kind: "location",
            from: m.from,
            messageId: m.id,
            latitude: m.location.latitude,
            longitude: m.location.longitude,
            name: m.location.name,
            address: m.location.address,
          });
```

- [ ] **Step 7: Run the tests again and confirm they pass**

Run: `npm test -- whatsapp.test.ts`
Expected: PASS.

- [ ] **Step 8: Run the full unit suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add server/src/providers/whatsapp.ts server/src/providers/whatsapp.test.ts
git commit -m "feat: parse inbound WhatsApp location pins"
```

---

## Task 3: Route a location pin into the assistant loop

**Files:**
- Modify: `server/src/services/chatDispatch.ts` (add `handleLocation`)
- Modify: `server/src/routes/whatsappRoutes.ts:1-30` (import), `server/src/routes/whatsappRoutes.ts:142-178` (`handleIncoming`'s branches)
- Test: `server/src/routes/whatsappRoutes.test.ts`

**Interfaces:**
- Consumes: `IncomingLocationMessage` from Task 2 (`kind`, `from`, `messageId`, `latitude`, `longitude`, `name?`, `address?`).
- Produces: `export async function handleLocation(ownerId: number, from: string, latitude: number, longitude: number, messageId: string, name?: string, address?: string): Promise<void>` in `chatDispatch.ts` — same call shape family as `handleMedia` in `whatsappRoutes.ts` (individual scalar params, not the whole message object).

- [ ] **Step 1: Write the failing test in `whatsappRoutes.test.ts`**

`whatsappRoutes.test.ts` already mocks every module `chatDispatch.ts`'s `handleLocation` will touch (`../db/store.js`'s `appendWhatsAppMessage`/`getWhatsAppHistory`, `../ai/assistant.js`'s `runAssistantChat`, `../services/whatsappReply.js`'s `sendAssistantReply`) and exercises `handleText`'s real implementation the same way today (see its `"still routes an ordinary message to the real assistant"` test) — `handleLocation` gets covered the same way, no new mocks needed.

Add, after the existing `describe("handleIncoming — unsupported message types", ...)` block:

```ts
describe("handleIncoming — location messages", () => {
  it("folds a dropped pin (with name/address) into history and runs it through the assistant", async () => {
    vi.mocked(runAssistantChat).mockResolvedValue({ text: "Here are a few hotels nearby." });

    await handleIncoming({
      kind: "location",
      from: "447900000020",
      messageId: "m20",
      latitude: 51.5074,
      longitude: -0.1278,
      name: "Big Ben",
      address: "London SW1A 0AA",
    });

    expect(vi.mocked(appendWhatsAppMessage).mock.calls[0]).toEqual([
      42,
      "447900000020",
      "user",
      "[User shared their location: 51.5074, -0.1278 (Big Ben, London SW1A 0AA)]",
    ]);
    expect(runAssistantChat).toHaveBeenCalled();
    expect(sendAssistantReply).toHaveBeenCalledWith(
      42,
      "447900000020",
      { text: "Here are a few hotels nearby." },
      "m20"
    );
  });

  it("still works for a raw pin with no name/address", async () => {
    vi.mocked(runAssistantChat).mockResolvedValue({ text: "Got it." });

    await handleIncoming({
      kind: "location",
      from: "447900000021",
      messageId: "m21",
      latitude: 51.5,
      longitude: -0.1,
    });

    expect(vi.mocked(appendWhatsAppMessage).mock.calls[0]).toEqual([
      42,
      "447900000021",
      "user",
      "[User shared their location: 51.5, -0.1]",
    ]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -- whatsappRoutes.test.ts` (from `server/`)
Expected: FAIL — a `kind: "location"` message currently falls into `handleIncoming`'s final `else` branch (the stray-interactive-tap log), so `appendWhatsAppMessage`/`runAssistantChat`/`sendAssistantReply` are never called.

- [ ] **Step 3: Add `handleLocation` to `chatDispatch.ts`**

In `server/src/services/chatDispatch.ts`, add (e.g. after `handleLink`, before `handleText`):

```ts
// Folds a dropped WhatsApp pin into the conversation the same way handleLink folds in a saved
// page — except the content here is always just a couple of numbers (and maybe a name/address),
// so unlike handleLink/handleMedia's docContext there's no need to persist a short placeholder
// and swap in a longer version just for the model: the full location line is short enough to
// store as-is and reuse for both.
export async function handleLocation(
  ownerId: number,
  from: string,
  latitude: number,
  longitude: number,
  messageId: string,
  name?: string,
  address?: string
): Promise<void> {
  const label = name ? `${name}${address ? `, ${address}` : ""}` : undefined;
  const locationText = `[User shared their location: ${latitude}, ${longitude}${label ? ` (${label})` : ""}]`;
  appendWhatsAppMessage(ownerId, from, "user", locationText);

  const history = getWhatsAppHistory(from, MAX_HISTORY_MESSAGES).map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const reply = await runAssistantChat(ownerId, history, from);
  await sendAssistantReply(ownerId, from, reply, messageId);
}
```

- [ ] **Step 4: Wire it into `whatsappRoutes.ts`**

In `server/src/routes/whatsappRoutes.ts`, change the import at line 30:

```ts
import { handleText } from "../services/chatDispatch.js";
```

to:

```ts
import { handleText, handleLocation } from "../services/chatDispatch.js";
```

In `handleIncoming` (the `if/else if` chain starting at line 143), add a branch for `"location"` — placed after the `"media"` branch and before `"reaction"`:

```ts
    } else if (message.kind === "location") {
      await handleLocation(
        ownerId,
        message.from,
        message.latitude,
        message.longitude,
        message.messageId,
        message.name,
        message.address
      );
    } else if (message.kind === "reaction") {
```

(This replaces the existing `} else if (message.kind === "reaction") {` line — everything after it, including the `reaction`/`unsupported`/final-`else` branches, stays exactly as-is.)

- [ ] **Step 5: Run the test again and confirm it passes**

Run: `npm test -- whatsappRoutes.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full unit suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/services/chatDispatch.ts server/src/routes/whatsappRoutes.ts server/src/routes/whatsappRoutes.test.ts
git commit -m "feat: route inbound WhatsApp location pins through the assistant loop"
```

---

## Manual verification (not automated — see File Structure note above)

Once all three tasks are merged, before calling this done:
1. Ask Marlowe (real WhatsApp number, real API key) something like "what's a good hotel near the Eiffel Tower" and confirm the reply reads like it actually searched (specific names, not generic hedging) and includes a `google.com/maps/search` link.
2. Drop a real location pin in the WhatsApp chat and confirm Marlowe acknowledges it / can answer a "what's nearby" follow-up using it.
