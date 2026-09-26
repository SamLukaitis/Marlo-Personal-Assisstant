# Google Maps via MCP: nearby places and travel times

Date: 2026-09-26

## Problem

Marlowe answers "where's a good X near Y" today with `web_search`, and the prompt tells the model
to hand-build a `google.com/maps/search` link for any place it recommends. That works, but the
answers are only as good as whatever web pages come back — no real opening hours, ratings or
exact addresses — and Marlowe can't answer travel-time questions ("how long to drive to
Heathrow?") at all.

Google publishes an official MCP server for exactly this — **Maps Grounding Lite** — and we want
an MCP client layer in Marlowe anyway, so later servers (Todoist, Zapier, …) can plug in the same
way. This is the first one.

## Goals

1. Marlowe finds real places (name, address, rating, open-now, Google Maps link) for "near me"
   and "near <place>" questions.
2. Marlowe answers driving and walking travel-time/distance questions.
3. On WhatsApp, when a "near me" question has no recent location to go on, Marlowe sends a
   one-tap **Send location** button instead of asking in prose.
4. A small, reusable MCP client module that the next MCP server can use unchanged.

## Non-goals (this version)

- Web-app location (browser geolocation). Web chat asks the user to type where they are.
- Public transport routes — Grounding Lite supports `DRIVE` and `WALK` only.
- Google's `lookup_weather` — we keep the existing Open-Meteo `get_weather`.
- `resolve_maps_urls` / `resolve_names` (experimental; understanding shared Maps links is a
  possible follow-up).
- Dynamically importing a server's tool list. Tools are pinned (see Design → Approach).

## Background: Maps Grounding Lite

- Endpoint `https://mapstools.googleapis.com/mcp`, Streamable HTTP transport.
- Auth: `X-Goog-Api-Key: <key>` header (OAuth also supported; not needed — this isn't per-user
  data). Requires the "Maps Grounding Lite" API enabled on a Google Cloud project with billing.
- Tools used here (both GA):
  - `search_places` — `text_query` (required), `location_bias`
    (`{circle: {center: {latitude, longitude}, radius_meters}}`), `language_code`, `region_code`.
    Returns places with place IDs, coordinates, Google Maps links and an `attribution` field.
  - `compute_routes` — `origin` and `destination` (each one of `address`, `lat_lng`,
    `place_id`), `travel_mode` `DRIVE` (default) or `WALK`. Returns distance/duration and an
    `attribution` field.
- Rate limit 300 queries/minute per project for both. Pay-per-request.
- Terms: grounded output must be attributed using the `attribution` field, with Google Maps
  sources shown immediately after the generated answer; Maps data must not be cached or used for
  model training.

## Design

### Approach: reusable client, pinned tools

The MCP connection is generic; the **tool definitions Claude sees are written by us** in
`assistant.ts`, like every other tool, rather than copied from the server's `listTools()`.

- The tools+system prefix is prompt-cached. A dynamic tool list would change whenever Google
  edits a description or schema, silently busting the cache and changing model behaviour with no
  code change on our side. Pinned definitions only change when we change them.
- Our descriptions can carry Marlowe-specific guidance (use the latest WhatsApp pin, fall back to
  check-in city, prefer this over `web_search` for places) that a generic server description
  can't.
- Cost: a new upstream tool needs a few lines from us before Marlowe uses it. Fine for two tools.
  A later, much larger server (e.g. Todoist's 47 tools) can still choose dynamic loading on top
  of the same client module.

### Components

**`server/src/services/mcpClient.ts`** (new, server-agnostic)

- Wraps `@modelcontextprotocol/sdk`'s `Client` + `StreamableHTTPClientTransport`.
- `createMcpClient({ name, url, headers })` returns an object with
  `callTool(toolName, args): Promise<McpToolResult>` and `listToolNames(): Promise<string[]>`.
- Connects lazily on first call and reuses the session. If a call fails because the session is
  gone (transport closed / session-expired error), it reconnects once and retries.
- Per-call timeout (10 s). One retry on network errors and 5xx; no retry on 4xx.
- Returns the tool's content parsed into plain JSON (MCP tool results arrive as content blocks;
  the text/JSON block is extracted). An MCP `isError: true` result becomes a thrown
  `McpToolError` with the server's message.
- Knows nothing about Maps.

**`server/src/providers/maps.ts`** (new)

- Builds one `mcpClient` for Grounding Lite from `GOOGLE_MAPS_API_KEY`;
  `isMapsConfigured()` is false when the key is unset.
- `searchPlaces({ query, near?: {latitude, longitude}, radiusMeters? })` → calls
  `search_places`, then **trims** each place to: name, address, rating (+ count), open-now if
  present, Google Maps link, place ID. Caps at 8 places. Passes the `attribution` through
  unchanged.
- `computeRoute({ origin, destination, mode })` → calls `compute_routes` with origin/destination
  each passed as `address` / `lat_lng` / `place_id`, returns distance, duration, mode and
  `attribution`.
- Trimming keeps tool results small, since every tool result is re-sent at full input price on
  each later turn of the same message's loop (see `feature-to-do/token-cost-reduction.md`).
- At startup (first use), logs a `console.warn` if `listToolNames()` doesn't include
  `search_places` and `compute_routes` — surfaces an upstream rename in the admin portal's logs
  rather than as confusing tool errors.

**`server/src/providers/whatsapp.ts`**

- New `sendWhatsAppLocationRequest(to, bodyText)` sending
  `{type: "interactive", interactive: {type: "location_request_message", body: {text}, action:
  {name: "send_location"}}}`, alongside the existing reply-button/list/CTA senders. Returns the
  wamid like the others.

**`server/src/ai/assistant.ts`**

Three new tools, appended by `buildToolsForOwner` **only when `isMapsConfigured()`** (constant
for the life of the process, so the cached prefix stays stable). The existing
"cache breakpoint on the last tool" logic already handles a longer list.

- `find_places` — input `query` (required), `latitude` + `longitude` (optional, together),
  `radius_meters` (optional, default 2000). Description: use for any request to find places
  (restaurants, pharmacies, hotels, shops…); for "near me" use the latest
  `[User shared their location: …]` line in the conversation if it's under ~2 hours old; for a
  named area, put the area in the query instead of coordinates; for city-scale asks with no
  place named ("good restaurants here"), the user's latest travel check-in city may be used as
  the area (only when the travel tools are enabled for them); if the user means near them
  specifically and there's no recent pin, call `request_location` instead of guessing. The answer must end with
  the places' Google Maps links / attribution as sources.
- `get_route` — input `origin`, `destination` (each a free-text address/place name, or
  "lat,lng"), `mode` `drive` | `walk` (default drive). Description states driving/walking only,
  and to say so plainly when asked about public transport rather than inventing a time.
- `request_location` — input `message` (short body text naming what Marlowe will do with it,
  e.g. "Tap below to share where you are and I'll find the nearest pharmacy."). A **hard stop**,
  intercepted in `runAssistantChat`'s loop exactly like `ask_user_choice`/`react_to_message`:
  returns `finish({ text: message, locationRequest: true })`, no tool_result round-trip.

`AssistantReply` gains `locationRequest?: true`.

`runTool` gets `find_places` and `get_route` cases calling `maps.ts`; a
per-message counter caps Maps calls at **5** (over that, the tool returns
`{ error: "map lookup limit reached for this message" }`), mirroring `web_search`'s `max_uses`.

**Prompt (`buildRules`)** — the existing `web_search` rule's "build a Google Maps link" guidance
is replaced, when Maps is configured, with: use `find_places` for places and `get_route` for
travel times; use `web_search` only for what Maps doesn't cover (reviews, events, menus, news);
always list the Google Maps links from the tool result as sources right after the answer. When
Maps is not configured the current rule stays as-is.

**`server/src/services/whatsappReply.ts`**

- If `reply.locationRequest`, persist `reply.text` to WhatsApp history as the assistant turn (so
  the next turn sees what was asked) and send it with `sendWhatsAppLocationRequest` instead of
  plain text.

**Web channel**

- `request_location` on the web: the web reply path ignores `locationRequest` and shows
  `reply.text`, and the tool description tells the model that on the web the user should type
  their location. No client changes.

**Config**

- `GOOGLE_MAPS_API_KEY` read via `process.env`, documented in `server/.env.example` and set in
  Railway.

### Data flow

1. "Is there a pharmacy open near me?" (WhatsApp, no recent pin) → model calls
   `request_location` → user gets text + **Send location** button.
2. User taps it and shares → webhook delivers a `location` message → existing `handleLocation`
   sets their timezone, appends `[User shared their location: lat, lng]`, queues an assistant
   turn.
3. That turn sees the original question + the pin → `find_places(query: "pharmacy open now",
   latitude, longitude)` → trimmed results → reply listing 2–4 options with Maps links as
   sources.

"How long to walk from King's Cross to the British Museum?" needs no pin: `get_route` with two
addresses, `mode: walk`.

"Good ramen in Lisbon" needs no pin: `find_places(query: "ramen in Lisbon")`.

### Error handling

- Maps timeout / 5xx after retry / `McpToolError` → tool returns `{ error: "<short reason>" }`;
  the model says it couldn't look it up and may fall back to `web_search`, saying so. Never throws
  out of the assistant loop.
- No key configured → tools not offered; nothing else changes.
- User never taps the location button → nothing pending to clean up; their next message is a
  normal turn.
- 24-hour WhatsApp window: a location request is only ever sent as a reply to an inbound
  message, so it's always inside the window.

### Terms compliance

- Attribution: `maps.ts` preserves each result's `attribution` and Maps link; tool descriptions
  and the prompt require them as sources immediately after the answer.
- No caching: raw Maps results exist only within one assistant turn and are never persisted.
  **Accepted risk:** Marlowe's final reply text (which names places) is stored in chat history
  like every reply, and background memory extraction may record the user's own preferences
  ("likes café X"). Neither is a store of Maps data; not engineered around.

### Cost controls

- Per-message cap of 5 Maps calls.
- **Operator action:** set a daily request quota on the Grounding Lite API in Google Cloud
  console as a hard backstop.

## Testing

- `mcpClient.test.ts` — against a fake transport, no network: lazy connect, session reuse,
  timeout, one retry on 5xx/network, no retry on 4xx, reconnect-once after session loss,
  `isError` result → `McpToolError`.
- `maps.test.ts` — with a stubbed client: place trimming (fields kept, 8-place cap, attribution
  preserved), empty result, origin/destination mapping to `address` / `lat_lng` / `place_id`,
  `isMapsConfigured()` false without the key.
- `assistant.maps.test.ts` — tools present only when configured; `runTool` routes
  `find_places`/`get_route` to `maps.ts`; the 5-call cap; `request_location` is a hard stop
  producing `locationRequest: true`.
- `whatsapp.test.ts` — `sendWhatsAppLocationRequest` payload shape.
- `whatsappReply.test.ts` — a `locationRequest` reply is persisted to history and sent via the
  location-request sender.
- Manual: WhatsApp Simulator + one real phone — "pharmacy near me" → button → share pin → answer
  with Maps links; a walking-route question with no pin; the same "near me" question on the web
  asks the user to type their location.

## Rollout

1. Enable Maps Grounding Lite in a Google Cloud project with billing; create an API key
   restricted to that API; set a daily quota.
2. Add `GOOGLE_MAPS_API_KEY` to Railway.
3. Deploy. Without the key, behaviour is unchanged, so merging before the key exists is safe.

## Possible follow-ups

- Reuse `request_location` where the prompt currently tells users to share a pin via
  "attachment/+ icon → Location" (timezone for reminders).
- `resolve_maps_urls` for Maps links users forward.
- Browser geolocation in web chat.
