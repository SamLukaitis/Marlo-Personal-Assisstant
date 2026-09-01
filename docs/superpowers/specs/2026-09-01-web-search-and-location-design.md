# Web search + WhatsApp location pins (basic version)

## Purpose

Marlowe currently can't answer questions like "what hotels are nearby" or
"any good restaurants around here" — it has no way to search the web, and it
can't read a WhatsApp location pin the user drops. This adds both, scoped to
the smallest version that's genuinely useful: Claude's built-in web search
tool, plus reading (not sending) location pins.

## Scope

In scope:
- A `web_search` tool available to every user, always on.
- Reading an inbound WhatsApp location message (a dropped pin) and folding it
  into the conversation.
- Replies that reference a place include a Google Maps search link — no real
  location pin sent back.

Out of scope (deliberately, to keep this the "basic" version):
- Google Places / Geocoding API — no structured nearby-search results (name,
  rating, distance), no coordinates for anything Marlowe recommends.
- Sending a WhatsApp location message back to the user.
- A per-user opt-out or feature flag — `web_search` ships the same way the
  existing `ALWAYS_ON_TOOLS` do, not gated like `travel`/`teams`.
- Separate cost metering/dashboard for web search spend (Anthropic's console
  already shows this; token cost continues through the existing
  `recordApiUsage` path unchanged).

## A. Web search

Anthropic's `web_search` is a *server* tool: Anthropic executes the search
and injects `server_tool_use` / `web_search_tool_result` blocks into the same
`messages.create` response, then the model keeps generating in that same
turn. It never produces a `tool_use` block that needs a client-side
`tool_result` round trip, so it doesn't touch `runTool`'s switch statement at
all.

- Add `{ type: "web_search_20250305", name: "web_search" }` to
  `ALWAYS_ON_TOOLS` in `server/src/ai/assistant.ts`.
- Add a couple of sentences to `buildSystemPrompt` telling Marlowe when to use
  it (nearby places, current events/prices, anything not covered by another
  tool) and to be upfront that the answer comes from a live web search rather
  than presenting it as certain/verified fact.
- No change to `usageTotals`/`recordApiUsage` — the existing input/output/
  cache token accounting keeps working as-is. The flat $10/1,000-searches fee
  is not separately tracked in this version (see Non-goals).

## B. Inbound location pins

Today, `whatsapp.ts` routes WhatsApp's `location` message type into the
generic `"unsupported"` branch (`HANDLED_TYPES` doesn't include it), and the
user gets "I can't read that message type yet."

Changes, all in `server/src/providers/whatsapp.ts`:
- Add a new message kind:
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
  and add it to the `IncomingWhatsAppMessage` union.
- Add `"location"` to `HANDLED_TYPES`.
- In `extractIncomingMessages`, add a branch parsing Meta's
  `m.location: { latitude, longitude, name?, address? }` into the new kind,
  following the same required-field-presence pattern as the `image`/
  `document` branches (missing fields silently drop the message rather than
  surfacing a confusing reply, matching the existing convention noted in the
  code).

In `server/src/routes/whatsappRoutes.ts`'s `handleIncoming`, add
`else if (message.kind === "location")` calling a new `handleLocation` in
`server/src/services/chatDispatch.ts`. `handleLocation` mirrors the existing
`handleLink`/`handleMedia` shape:
- Append a synthesized user turn to history, e.g.:
  `[User shared their location: 51.5074, -0.1278 (name/address if Meta sent one)]`
- Run the normal assistant loop (`runAssistantChat`) so the model can act on
  it immediately — either answering a "what's nearby" question already
  pending in the conversation, or just acknowledging the pin if nothing was
  asked.
- Send the reply via `sendAssistantReply`, same as every other handler in
  this file.

## C. Typed place names

No code changes. "Restaurants in Lisbon" already reaches the model as plain
text; (A) gives it something to do with it.

## D. Outbound replies

Text only. When Marlowe recommends a place, it includes a Google Maps search
link built from the place name/address, e.g.:

```
https://www.google.com/maps/search/?api=1&query=<url-encoded name + address>
```

No `sendWhatsAppLocation` function, no geocoding call, no real pin sent back.
This is the main thing that keeps this version "basic" rather than pulling in
Places/Geocoding API cost and integration work.

## Testing

- `whatsapp.test.ts`: `extractIncomingMessages` parses a well-formed
  `location` message into `IncomingLocationMessage`, and drops one missing
  `latitude`/`longitude` the same way a malformed image/document message
  drops today (no `"unsupported"` fallback for a recognized-but-broken type,
  matching existing convention).
- `whatsappRoutes.test.ts`: `handleIncoming` with a location message reaches
  the new `handleLocation` path (mock it) instead of falling into the
  `"unsupported"` branch.
- `chatDispatch.test.ts` (new or extended): `handleLocation` appends the
  synthesized history line and calls `runAssistantChat` + `sendAssistantReply`.
- `grounding.eval.ts`: add a couple of "what's a good hotel/restaurant near
  X" prompts and assert the model actually reaches for `web_search` rather
  than guessing from training data.

## Rollout

No migration, no new env vars, no new feature flag. Ships as a normal PR;
`web_search` and location-reading are live for every user as soon as it
merges.
