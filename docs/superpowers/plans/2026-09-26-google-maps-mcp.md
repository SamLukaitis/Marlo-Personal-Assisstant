# Google Maps via MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Marlowe finds real nearby places and driving/walking travel times through Google's Maps Grounding Lite MCP server, and on WhatsApp asks for the user's location with a one-tap **Send location** button.

**Architecture:** A generic MCP client module (`services/mcpClient.ts`, wrapping `@modelcontextprotocol/sdk`) talks to remote MCP servers. A Maps provider (`providers/maps.ts`) uses it to call Grounding Lite's `search_places` / `compute_routes` and trims the results. The assistant exposes three *pinned* tools we define ourselves — `find_places`, `get_route`, `request_location` — only when `GOOGLE_MAPS_API_KEY` is set. `request_location` is a hard stop (like `ask_user_choice`) that becomes a WhatsApp `location_request_message`; the returned pin flows through the existing `handleLocation` path into a new assistant turn.

**Tech Stack:** TypeScript (NodeNext ESM), Express 4, `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk` ^1.30.1 (+ its required peer `zod`), vitest, supertest, React 19 (simulator page only).

**Spec:** `docs/superpowers/specs/2026-09-26-google-maps-mcp-design.md`

## Global Constraints

- MCP endpoint: `https://mapstools.googleapis.com/mcp`, auth header `X-Goog-Api-Key: <GOOGLE_MAPS_API_KEY>`.
- Upstream tool names: `search_places` (input `text_query`, optional `location_bias: {circle: {center: {latitude, longitude}, radius_meters}}`), `compute_routes` (input `origin`/`destination`, each one of `address` / `lat_lng` / `place_id`; `travel_mode` `DRIVE` | `WALK`).
- Tools are **pinned**: never pass a server's `listTools()` output to Claude.
- Maps tools (`find_places`, `get_route`, `request_location`) are offered **only when `GOOGLE_MAPS_API_KEY` is set**; with no key, behaviour is exactly as today.
- Per-call MCP timeout **10 s**; **one** retry on network errors / 5xx / lost session; **no** retry on 4xx or timeout.
- `find_places` returns at most **8** places; default radius **2000** m.
- At most **5** Maps calls (`find_places` + `get_route` combined) per user message.
- "Recent" pin = under **~2 hours** old.
- Google Maps sources (links / `attribution`) are listed **immediately after** the answer.
- Raw Maps results are never persisted (no DB writes of tool results).
- Web chat gets no location button; it asks the user to type where they are.
- Travel modes: driving and walking only — no public transport.

## Review Focus

1. **Grounding Lite's real response shape differs from our guess** (e.g. `displayName` is a string, not `{text}`; no `places` array) → the user should still get an answer, not "no results". Pinned by `maps.test.ts` "falls back to a truncated raw payload when the shape is unrecognised" (Task 2), plus the live probe in Task 2 Step 7.
2. **Model calls `request_location` alongside another tool or with text in the same turn** → the user should still get the location button, not a half-run tool. Pinned by `assistant.maps.test.ts` "request_location wins over other tool calls in the same turn" (Task 4).
3. **`request_location` reached on the web channel** → user sees a plain "tell me where you are" question, never "Tap below" with no button. Pinned by `assistant.maps.test.ts` "on the web, request_location asks the user to type their location" (Task 4).
4. **The MCP session expires between messages (server returns 404 / connection closed)** → the next call silently reconnects and succeeds. Pinned by `mcpClient.test.ts` "reconnects once when the session is gone" (Task 1).
5. **Model loops on Maps calls in parallel within one turn** → the 6th call is refused even when calls 1–6 arrive in the same response. Pinned by `assistant.maps.test.ts` "caps Maps calls at 5 per message, counting parallel calls" (Task 4).

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `server/src/services/mcpClient.ts` | Create | Generic remote-MCP client: lazy session, timeout, retry/reconnect, result parsing. Knows nothing about Maps. |
| `server/src/services/mcpClient.test.ts` | Create | Unit tests with a fake session factory. |
| `server/src/providers/maps.ts` | Create | Grounding Lite config, `searchPlaces`, `computeRoute`, trimming, tool-name startup check. |
| `server/src/providers/maps.test.ts` | Create | Unit tests with a stub `McpClient`. |
| `server/src/scripts/mapsProbe.ts` | Create | Manual live probe that prints real Grounding Lite output (not run in CI). |
| `server/src/providers/whatsapp.ts` | Modify | Add `sendWhatsAppLocationRequest`. |
| `server/src/providers/whatsappSimTranscript.ts` | Modify | Add `locationRequest?: boolean` to `SimTranscriptEntry`. |
| `server/src/services/whatsappReply.ts` | Modify | Render `reply.locationRequest` via the new sender. |
| `server/src/ai/assistant.ts` | Modify | Maps tool defs, `runTool` cases, per-message cap, `request_location` hard stop, `AssistantReply.locationRequest`, rules. |
| `server/src/ai/assistant.maps.test.ts` | Create | Assistant-level tests for the Maps tools. |
| `server/src/routes/whatsappSimRoutes.ts` | Modify | Accept `{latitude, longitude}` to simulate a shared pin. |
| `client/src/api/client.ts` | Modify | Sim types: `locationRequest`, location input. |
| `client/src/pages/WhatsAppSimPage.tsx` | Modify | "Send location" button on a location-request entry (browser geolocation). |
| `server/.env.example`, `server/package.json` | Modify | `GOOGLE_MAPS_API_KEY`, SDK dependency, `maps:probe` script. |

---

### Task 1: Generic MCP client

**Files:**
- Modify: `server/package.json` (dependencies)
- Create: `server/src/services/mcpClient.ts`
- Test: `server/src/services/mcpClient.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  ```ts
  export interface McpServerOptions { name: string; url: string; headers?: Record<string, string>; timeoutMs?: number }
  export interface McpCallResult { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown; isError?: boolean }
  export interface McpSession {
    callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<McpCallResult>;
    listToolNames(timeoutMs: number): Promise<string[]>;
    close(): Promise<void>;
  }
  export type McpSessionFactory = (opts: McpServerOptions & { timeoutMs: number }) => Promise<McpSession>;
  export interface McpClient {
    callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
    listToolNames(): Promise<string[]>;
    close(): Promise<void>;
  }
  export class McpToolError extends Error {}
  export function createMcpClient(opts: McpServerOptions, factory?: McpSessionFactory): McpClient;
  ```

- [ ] **Step 1: Install the SDK**

Run (from `server/`): `npm install @modelcontextprotocol/sdk@^1.30.1 zod`
Expected: both appear under `dependencies` in `server/package.json`; `npm ls @modelcontextprotocol/sdk` prints `1.30.x`.

- [ ] **Step 2: Write the failing tests**

Create `server/src/services/mcpClient.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import {
  createMcpClient,
  McpToolError,
  type McpSession,
  type McpSessionFactory,
  type McpCallResult,
} from "./mcpClient.js";

const OPTS = { name: "test", url: "https://mcp.example.com/mcp", headers: { "X-Key": "k" } };

function fakeSession(callTool: (name: string, args: Record<string, unknown>, timeoutMs: number) => Promise<McpCallResult>): McpSession {
  return {
    callTool: vi.fn(callTool),
    listToolNames: vi.fn().mockResolvedValue(["a", "b"]),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function jsonText(value: unknown): McpCallResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

describe("createMcpClient", () => {
  it("connects lazily on the first call and reuses the session afterwards", async () => {
    const session = fakeSession(async () => jsonText({ ok: true }));
    const factory = vi.fn<McpSessionFactory>().mockResolvedValue(session);
    const client = createMcpClient(OPTS, factory);

    expect(factory).not.toHaveBeenCalled();
    await client.callTool("x", {});
    await client.callTool("x", {});

    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith({ ...OPTS, timeoutMs: 10_000 });
    expect(session.callTool).toHaveBeenCalledTimes(2);
  });

  it("passes the per-call timeout through to the session", async () => {
    const session = fakeSession(async () => jsonText({}));
    const client = createMcpClient({ ...OPTS, timeoutMs: 2_500 }, async () => session);

    await client.callTool("x", { a: 1 });

    expect(session.callTool).toHaveBeenCalledWith("x", { a: 1 }, 2_500);
  });

  it("returns structuredContent when present", async () => {
    const client = createMcpClient(OPTS, async () =>
      fakeSession(async () => ({ structuredContent: { places: [] }, content: [{ type: "text", text: "ignored" }] }))
    );
    await expect(client.callTool("x", {})).resolves.toEqual({ places: [] });
  });

  it("parses a JSON text block, and returns non-JSON text as a string", async () => {
    const jsonClient = createMcpClient(OPTS, async () => fakeSession(async () => jsonText({ n: 1 })));
    await expect(jsonClient.callTool("x", {})).resolves.toEqual({ n: 1 });

    const textClient = createMcpClient(OPTS, async () =>
      fakeSession(async () => ({ content: [{ type: "text", text: "plain " }, { type: "text", text: "words" }] }))
    );
    await expect(textClient.callTool("x", {})).resolves.toBe("plain words");
  });

  it("turns an isError result into McpToolError without retrying", async () => {
    const session = fakeSession(async () => ({ isError: true, content: [{ type: "text", text: "bad query" }] }));
    const factory = vi.fn<McpSessionFactory>().mockResolvedValue(session);
    const client = createMcpClient(OPTS, factory);

    await expect(client.callTool("x", {})).rejects.toThrow(McpToolError);
    await expect(client.callTool("x", {})).rejects.toThrow("bad query");
    expect(session.callTool).toHaveBeenCalledTimes(2); // one per callTool, no retries
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("retries once on a 5xx, on a fresh session", async () => {
    const first = fakeSession(async () => {
      throw new StreamableHTTPError(503, "unavailable");
    });
    const second = fakeSession(async () => jsonText({ ok: 1 }));
    const factory = vi.fn<McpSessionFactory>().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const client = createMcpClient(OPTS, factory);

    await expect(client.callTool("x", {})).resolves.toEqual({ ok: 1 });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(first.close).toHaveBeenCalled();
  });

  it("reconnects once when the session is gone (404 or connection closed)", async () => {
    for (const err of [new StreamableHTTPError(404, "session not found"), new McpError(ErrorCode.ConnectionClosed, "closed")]) {
      const dead = fakeSession(async () => {
        throw err;
      });
      const fresh = fakeSession(async () => jsonText({ ok: true }));
      const factory = vi.fn<McpSessionFactory>().mockResolvedValueOnce(dead).mockResolvedValueOnce(fresh);
      const client = createMcpClient(OPTS, factory);

      await expect(client.callTool("x", {})).resolves.toEqual({ ok: true });
      expect(factory).toHaveBeenCalledTimes(2);
    }
  });

  it("retries once on a network error (fetch TypeError), including a failed connect", async () => {
    const good = fakeSession(async () => jsonText({ ok: true }));
    const factory = vi
      .fn<McpSessionFactory>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(good);
    const client = createMcpClient(OPTS, factory);

    await expect(client.callTool("x", {})).resolves.toEqual({ ok: true });
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("gives up after one retry", async () => {
    const factory = vi.fn<McpSessionFactory>().mockImplementation(async () =>
      fakeSession(async () => {
        throw new StreamableHTTPError(500, "boom");
      })
    );
    const client = createMcpClient(OPTS, factory);

    await expect(client.callTool("x", {})).rejects.toThrow("boom");
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 4xx or a timeout", async () => {
    for (const err of [new StreamableHTTPError(401, "unauthorized"), new McpError(ErrorCode.RequestTimeout, "timed out")]) {
      const session = fakeSession(async () => {
        throw err;
      });
      const factory = vi.fn<McpSessionFactory>().mockResolvedValue(session);
      const client = createMcpClient(OPTS, factory);

      await expect(client.callTool("x", {})).rejects.toBe(err);
      expect(session.callTool).toHaveBeenCalledTimes(1);
      expect(factory).toHaveBeenCalledTimes(1);
    }
  });

  it("lists tool names through the same session", async () => {
    const session = fakeSession(async () => jsonText({}));
    const client = createMcpClient(OPTS, async () => session);

    await expect(client.listToolNames()).resolves.toEqual(["a", "b"]);
    expect(session.listToolNames).toHaveBeenCalledWith(10_000);
  });

  it("close() closes the open session and the next call reconnects", async () => {
    const s1 = fakeSession(async () => jsonText({}));
    const s2 = fakeSession(async () => jsonText({}));
    const factory = vi.fn<McpSessionFactory>().mockResolvedValueOnce(s1).mockResolvedValueOnce(s2);
    const client = createMcpClient(OPTS, factory);

    await client.callTool("x", {});
    await client.close();
    await client.callTool("x", {});

    expect(s1.close).toHaveBeenCalled();
    expect(factory).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/services/mcpClient.test.ts`
Expected: FAIL — `Failed to resolve import "./mcpClient.js"`.

- [ ] **Step 4: Implement `mcpClient.ts`**

Create `server/src/services/mcpClient.ts`:

```ts
// A small, server-agnostic client for remote MCP servers (Streamable HTTP). Deliberately knows
// nothing about any one server: providers (e.g. providers/maps.ts) build one of these and call
// named tools through it. Tools Claude sees are still pinned in assistant.ts — a server's own
// listTools() output is only used for a startup sanity check, never handed to the model, so an
// upstream schema/description change can't silently bust the prompt cache.
//
// Connects lazily on first use and reuses the session. One retry, on a fresh session, for
// failures that a reconnect can fix (network error, 5xx, session gone); none for 4xx, timeouts or
// a tool's own isError result — retrying those just doubles the wait for the same answer.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

const DEFAULT_TIMEOUT_MS = 10_000;

export interface McpServerOptions {
  name: string;
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface McpCallResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpSession {
  callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<McpCallResult>;
  listToolNames(timeoutMs: number): Promise<string[]>;
  close(): Promise<void>;
}

export type McpSessionFactory = (opts: McpServerOptions & { timeoutMs: number }) => Promise<McpSession>;

export interface McpClient {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  listToolNames(): Promise<string[]>;
  close(): Promise<void>;
}

// The server ran the tool and reported a failure (bad input, no results it considers an error,
// etc.) — a real answer, not a transport problem, so never retried.
export class McpToolError extends Error {}

async function connectSdkSession(opts: McpServerOptions & { timeoutMs: number }): Promise<McpSession> {
  const client = new Client({ name: "marlowe", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(opts.url), {
    requestInit: { headers: opts.headers ?? {} },
  });
  await client.connect(transport, { timeout: opts.timeoutMs });
  return {
    async callTool(name, args, timeoutMs) {
      return (await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs })) as McpCallResult;
    },
    async listToolNames(timeoutMs) {
      const { tools } = await client.listTools(undefined, { timeout: timeoutMs });
      return tools.map((t) => t.name);
    },
    close: () => client.close(),
  };
}

function isRetryable(err: unknown): boolean {
  if (err instanceof McpToolError) return false;
  if (err instanceof StreamableHTTPError) {
    // 404 is how a Streamable HTTP server says "unknown session" — a reconnect fixes it.
    return err.code === undefined || err.code === 404 || err.code >= 500;
  }
  if (err instanceof McpError) return err.code === ErrorCode.ConnectionClosed;
  // Node's fetch reports DNS/connection-refused/reset as a TypeError("fetch failed").
  return err instanceof TypeError;
}

function parseResult(result: McpCallResult): unknown {
  const text = (result.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
  if (result.isError) throw new McpToolError(text || "MCP tool reported an error");
  if (result.structuredContent !== undefined) return result.structuredContent;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function createMcpClient(opts: McpServerOptions, factory: McpSessionFactory = connectSdkSession): McpClient {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let sessionPromise: Promise<McpSession> | null = null;

  function getSession(): Promise<McpSession> {
    if (!sessionPromise) {
      sessionPromise = factory({ ...opts, timeoutMs }).catch((err) => {
        sessionPromise = null;
        throw err;
      });
    }
    return sessionPromise;
  }

  async function dropSession(): Promise<void> {
    const current = sessionPromise;
    sessionPromise = null;
    if (!current) return;
    try {
      await (await current).close();
    } catch {
      // Already broken — nothing useful to do with a close failure.
    }
  }

  async function withSession<T>(fn: (session: McpSession) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn(await getSession());
      } catch (err) {
        if (attempt === 0 && isRetryable(err)) {
          await dropSession();
          continue;
        }
        throw err;
      }
    }
  }

  return {
    callTool: (name, args) => withSession(async (s) => parseResult(await s.callTool(name, args, timeoutMs))),
    listToolNames: () => withSession((s) => s.listToolNames(timeoutMs)),
    close: dropSession,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/services/mcpClient.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 6: Typecheck**

Run: `npm run build`
Expected: exits 0. If `tsc` reports that `StreamableHTTPClientTransport` is not assignable to `Transport` (a known optional-property mismatch in some SDK versions), change the connect line to `await client.connect(transport as unknown as Parameters<Client["connect"]>[0], { timeout: opts.timeoutMs });` and re-run.

- [ ] **Step 7: Commit**

```bash
git add server/package.json server/package-lock.json server/src/services/mcpClient.ts server/src/services/mcpClient.test.ts
git commit -m "feat: generic MCP client with lazy session, timeout and one-shot reconnect"
```

---

### Task 2: Maps provider

**Files:**
- Create: `server/src/providers/maps.ts`
- Create: `server/src/scripts/mapsProbe.ts`
- Modify: `server/.env.example`, `server/package.json` (scripts)
- Test: `server/src/providers/maps.test.ts`

**Interfaces:**
- Consumes (Task 1): `createMcpClient(opts): McpClient`, `McpClient`.
- Produces:
  ```ts
  export const MAPS_MCP_URL = "https://mapstools.googleapis.com/mcp";
  export function isMapsConfigured(): boolean;
  export function setMapsClientForTest(client: McpClient | null): void;
  export interface PlaceSummary { name: string; address?: string; rating?: number; ratingCount?: number; openNow?: boolean; mapsUrl?: string; placeId?: string; summary?: string }
  export interface PlacesResult { places: PlaceSummary[]; summary?: string; attribution?: unknown; raw?: string }
  export interface RouteResult { mode: "drive" | "walk"; distanceMeters?: number; durationSeconds?: number; attribution?: unknown; raw?: string }
  export type RoutePoint = string; // free text address/place name, or "lat,lng"
  export function searchPlaces(input: { query: string; near?: { latitude: number; longitude: number }; radiusMeters?: number }): Promise<PlacesResult>;
  export function computeRoute(input: { origin: RoutePoint; destination: RoutePoint; mode: "drive" | "walk" }): Promise<RouteResult>;
  ```

- [ ] **Step 1: Write the failing tests**

Create `server/src/providers/maps.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { McpClient } from "../services/mcpClient.js";
import { isMapsConfigured, searchPlaces, computeRoute, setMapsClientForTest } from "./maps.js";

const originalEnv = { ...process.env };

function stubClient(result: unknown, toolNames = ["search_places", "compute_routes"]): McpClient & { callTool: ReturnType<typeof vi.fn> } {
  return {
    callTool: vi.fn().mockResolvedValue(result),
    listToolNames: vi.fn().mockResolvedValue(toolNames),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  process.env.GOOGLE_MAPS_API_KEY = "test-maps-key";
});

afterEach(() => {
  setMapsClientForTest(null);
  process.env = { ...originalEnv };
});

describe("isMapsConfigured", () => {
  it("is false without a key or with a blank key, true with one", () => {
    delete process.env.GOOGLE_MAPS_API_KEY;
    expect(isMapsConfigured()).toBe(false);
    process.env.GOOGLE_MAPS_API_KEY = "   ";
    expect(isMapsConfigured()).toBe(false);
    process.env.GOOGLE_MAPS_API_KEY = "k";
    expect(isMapsConfigured()).toBe(true);
  });
});

describe("searchPlaces", () => {
  it("sends text_query and a circle location_bias when near is given", async () => {
    const client = stubClient({ places: [] });
    setMapsClientForTest(client);

    await searchPlaces({ query: "pharmacy open now", near: { latitude: 51.53, longitude: -0.12 }, radiusMeters: 1500 });

    expect(client.callTool).toHaveBeenCalledWith("search_places", {
      text_query: "pharmacy open now",
      location_bias: { circle: { center: { latitude: 51.53, longitude: -0.12 }, radius_meters: 1500 } },
    });
  });

  it("defaults the radius to 2000 m and omits location_bias without near", async () => {
    const client = stubClient({ places: [] });
    setMapsClientForTest(client);

    await searchPlaces({ query: "ramen", near: { latitude: 1, longitude: 2 } });
    expect(client.callTool.mock.calls[0][1].location_bias.circle.radius_meters).toBe(2000);

    await searchPlaces({ query: "ramen in Lisbon" });
    expect(client.callTool.mock.calls[1][1]).toEqual({ text_query: "ramen in Lisbon" });
  });

  it("trims each place to the fields the model needs and keeps attribution", async () => {
    setMapsClientForTest(
      stubClient({
        summary: "Two pharmacies nearby.",
        attribution: { text: "Google Maps" },
        places: [
          {
            id: "ChIJ1",
            displayName: { text: "Boots" },
            formattedAddress: "1 Euston Rd, London",
            rating: 4.1,
            userRatingCount: 212,
            currentOpeningHours: { openNow: true, weekdayDescriptions: ["Mon: 8–8"] },
            googleMapsUri: "https://maps.google.com/?cid=1",
            reviews: [{ text: "long review..." }],
            photos: [{ name: "p1" }],
          },
          { place_id: "ChIJ2", displayName: "Superdrug", address: "2 Euston Rd", maps_uri: "https://maps.google.com/?cid=2" },
        ],
      })
    );

    const result = await searchPlaces({ query: "pharmacy" });

    expect(result).toEqual({
      summary: "Two pharmacies nearby.",
      attribution: { text: "Google Maps" },
      places: [
        {
          name: "Boots",
          address: "1 Euston Rd, London",
          rating: 4.1,
          ratingCount: 212,
          openNow: true,
          mapsUrl: "https://maps.google.com/?cid=1",
          placeId: "ChIJ1",
        },
        { name: "Superdrug", address: "2 Euston Rd", mapsUrl: "https://maps.google.com/?cid=2", placeId: "ChIJ2" },
      ],
    });
  });

  it("caps the list at 8 places", async () => {
    const places = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, displayName: { text: `Place ${i}` } }));
    setMapsClientForTest(stubClient({ places }));

    const result = await searchPlaces({ query: "cafe" });

    expect(result.places).toHaveLength(8);
    expect(result.places[7].name).toBe("Place 7");
  });

  it("returns an empty list for an empty result", async () => {
    setMapsClientForTest(stubClient({ places: [] }));
    await expect(searchPlaces({ query: "nothing here" })).resolves.toEqual({ places: [] });
  });

  it("falls back to a truncated raw payload when the shape is unrecognised", async () => {
    setMapsClientForTest(stubClient({ results: [{ title: "x".repeat(5000) }] }));

    const result = await searchPlaces({ query: "cafe" });

    expect(result.places).toEqual([]);
    expect(result.raw).toBeDefined();
    expect(result.raw!.length).toBeLessThanOrEqual(3000);
    expect(result.raw).toContain("results");
  });

  it("wraps a plain-text answer as raw", async () => {
    setMapsClientForTest(stubClient("Here are some places: ..."));
    await expect(searchPlaces({ query: "cafe" })).resolves.toEqual({ places: [], raw: "Here are some places: ..." });
  });
});

describe("computeRoute", () => {
  it("maps free-text points to address and 'lat,lng' strings to lat_lng", async () => {
    const client = stubClient({ routes: [] });
    setMapsClientForTest(client);

    await computeRoute({ origin: "King's Cross, London", destination: "51.5194, -0.1270", mode: "walk" });

    expect(client.callTool).toHaveBeenCalledWith("compute_routes", {
      origin: { address: "King's Cross, London" },
      destination: { lat_lng: { latitude: 51.5194, longitude: -0.127 } },
      travel_mode: "WALK",
    });
  });

  it("maps a ChIJ-style id to place_id and drive to DRIVE", async () => {
    const client = stubClient({ routes: [] });
    setMapsClientForTest(client);

    await computeRoute({ origin: "ChIJdd4hrwug2EcRmSrV3Vo6llI", destination: "Heathrow Airport", mode: "drive" });

    expect(client.callTool.mock.calls[0][1]).toMatchObject({
      origin: { place_id: "ChIJdd4hrwug2EcRmSrV3Vo6llI" },
      travel_mode: "DRIVE",
    });
  });

  it("returns distance, duration in seconds and attribution from the first route", async () => {
    setMapsClientForTest(
      stubClient({ routes: [{ distanceMeters: 1830, duration: "1320s", polyline: { encodedPolyline: "abc" } }], attribution: "Google Maps" })
    );

    await expect(computeRoute({ origin: "a", destination: "b", mode: "walk" })).resolves.toEqual({
      mode: "walk",
      distanceMeters: 1830,
      durationSeconds: 1320,
      attribution: "Google Maps",
    });
  });

  it("falls back to raw when there is no recognisable route", async () => {
    setMapsClientForTest(stubClient({ something: "else" }));
    const result = await computeRoute({ origin: "a", destination: "b", mode: "drive" });
    expect(result.mode).toBe("drive");
    expect(result.raw).toContain("something");
  });
});

describe("startup tool check", () => {
  it("warns once when an expected upstream tool is missing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = stubClient({ places: [] }, ["search_places"]);
    setMapsClientForTest(client);

    await searchPlaces({ query: "a" });
    await searchPlaces({ query: "b" });
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));

    expect(warn.mock.calls[0].join(" ")).toContain("compute_routes");
    expect(client.listToolNames).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/providers/maps.test.ts`
Expected: FAIL — `Failed to resolve import "./maps.js"`.

- [ ] **Step 3: Implement `maps.ts`**

Create `server/src/providers/maps.ts`:

```ts
// Google Maps Platform "Maps Grounding Lite" over MCP (services/mcpClient.ts). Two upstream tools
// are used: search_places (real place data + Google Maps links) and compute_routes
// (driving/walking distance and duration — no public transport). The assistant's own tools
// (find_places / get_route in ai/assistant.ts) are pinned definitions that call into here.
//
// Results are trimmed before they reach the model: every tool result is re-sent at full input
// price on each later turn of the same message's loop (feature-to-do/token-cost-reduction.md), and
// Places responses carry reviews/photos/hours arrays the model doesn't need. If the upstream
// shape is ever unrecognised, a truncated raw payload is passed through instead of an empty
// answer, so a Google-side format change degrades to "verbose" rather than "no results".
//
// Terms: Google requires its attribution to be shown with any grounded answer, and forbids
// caching Maps data — attribution and Maps links are always passed through, and nothing here is
// persisted.
import { createMcpClient, type McpClient } from "../services/mcpClient.js";

export const MAPS_MCP_URL = "https://mapstools.googleapis.com/mcp";
const EXPECTED_TOOLS = ["search_places", "compute_routes"];
const MAX_PLACES = 8;
const DEFAULT_RADIUS_METERS = 2000;
const MAX_RAW_CHARS = 3000;

export interface PlaceSummary {
  name: string;
  address?: string;
  rating?: number;
  ratingCount?: number;
  openNow?: boolean;
  mapsUrl?: string;
  placeId?: string;
  summary?: string;
}

export interface PlacesResult {
  places: PlaceSummary[];
  summary?: string;
  attribution?: unknown;
  raw?: string;
}

export interface RouteResult {
  mode: "drive" | "walk";
  distanceMeters?: number;
  durationSeconds?: number;
  attribution?: unknown;
  raw?: string;
}

export type RoutePoint = string;

let client: McpClient | null = null;
let toolCheckDone = false;

export function isMapsConfigured(): boolean {
  return Boolean(process.env.GOOGLE_MAPS_API_KEY?.trim());
}

export function setMapsClientForTest(c: McpClient | null): void {
  client = c;
  toolCheckDone = false;
}

function getClient(): McpClient {
  if (!client) {
    client = createMcpClient({
      name: "google-maps",
      url: MAPS_MCP_URL,
      headers: { "X-Goog-Api-Key": process.env.GOOGLE_MAPS_API_KEY?.trim() ?? "" },
    });
  }
  if (!toolCheckDone) {
    toolCheckDone = true;
    // Fire-and-forget: surfaces an upstream rename in the admin portal's logs instead of as a
    // confusing tool error, without delaying the user's first answer.
    const c = client;
    void c
      .listToolNames()
      .then((names) => {
        const missing = EXPECTED_TOOLS.filter((t) => !names.includes(t));
        if (missing.length) console.warn(`maps: Grounding Lite no longer lists expected tool(s): ${missing.join(", ")}`);
      })
      .catch((err) => console.warn("maps: couldn't list Grounding Lite tools", err));
  }
  return client;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim()) return v;
  const rec = asRecord(v);
  return rec && typeof rec.text === "string" && rec.text.trim() ? rec.text : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function rawOf(result: unknown): string {
  const text = typeof result === "string" ? result : JSON.stringify(result);
  return text.slice(0, MAX_RAW_CHARS);
}

function trimPlace(p: Record<string, unknown>): PlaceSummary | null {
  const name = str(p.displayName) ?? str(p.name) ?? str(p.title);
  if (!name) return null;
  const hours = asRecord(p.currentOpeningHours) ?? asRecord(p.regularOpeningHours);
  const links = asRecord(p.googleMapsLinks);
  const place: PlaceSummary = { name };
  const address = str(p.formattedAddress) ?? str(p.address) ?? str(p.shortFormattedAddress);
  if (address) place.address = address;
  const rating = num(p.rating);
  if (rating !== undefined) place.rating = rating;
  const ratingCount = num(p.userRatingCount);
  if (ratingCount !== undefined) place.ratingCount = ratingCount;
  if (typeof hours?.openNow === "boolean") place.openNow = hours.openNow;
  const mapsUrl = str(p.googleMapsUri) ?? str(links?.placeUri) ?? str(p.maps_uri) ?? str(p.mapsUri) ?? str(p.url);
  if (mapsUrl) place.mapsUrl = mapsUrl;
  const placeId = str(p.id) ?? str(p.place_id) ?? str(p.placeId);
  if (placeId) place.placeId = placeId;
  const summary = str(p.summary) ?? str(p.editorialSummary) ?? str(p.generativeSummary);
  if (summary) place.summary = summary;
  return place;
}

export async function searchPlaces(input: {
  query: string;
  near?: { latitude: number; longitude: number };
  radiusMeters?: number;
}): Promise<PlacesResult> {
  const args: Record<string, unknown> = { text_query: input.query };
  if (input.near) {
    args.location_bias = {
      circle: {
        center: { latitude: input.near.latitude, longitude: input.near.longitude },
        radius_meters: input.radiusMeters ?? DEFAULT_RADIUS_METERS,
      },
    };
  }
  const result = await getClient().callTool("search_places", args);

  const rec = asRecord(result);
  if (!rec || !Array.isArray(rec.places)) return { places: [], raw: rawOf(result) };

  const places = rec.places
    .map((p) => asRecord(p))
    .filter((p): p is Record<string, unknown> => p !== null)
    .map(trimPlace)
    .filter((p): p is PlaceSummary => p !== null)
    .slice(0, MAX_PLACES);
  const out: PlacesResult = { places };
  const summary = str(rec.summary);
  if (summary) out.summary = summary;
  if (rec.attribution !== undefined) out.attribution = rec.attribution;
  return out;
}

const LAT_LNG = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;
// Google place IDs are opaque; in practice they start "ChIJ" / "Ei" / "Gh" and contain no spaces.
const PLACE_ID = /^(ChIJ|Ei|Gh)[A-Za-z0-9_-]{10,}$/;

function toWaypoint(point: RoutePoint): Record<string, unknown> {
  const m = LAT_LNG.exec(point);
  if (m) return { lat_lng: { latitude: Number(m[1]), longitude: Number(m[2]) } };
  if (PLACE_ID.test(point.trim())) return { place_id: point.trim() };
  return { address: point };
}

function parseDurationSeconds(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const m = /^(\d+(?:\.\d+)?)s$/.exec(v.trim());
    if (m) return Math.round(Number(m[1]));
  }
  return undefined;
}

export async function computeRoute(input: {
  origin: RoutePoint;
  destination: RoutePoint;
  mode: "drive" | "walk";
}): Promise<RouteResult> {
  const result = await getClient().callTool("compute_routes", {
    origin: toWaypoint(input.origin),
    destination: toWaypoint(input.destination),
    travel_mode: input.mode === "walk" ? "WALK" : "DRIVE",
  });

  const rec = asRecord(result);
  const first = rec && Array.isArray(rec.routes) ? asRecord(rec.routes[0]) : null;
  const distanceMeters = num(first?.distanceMeters);
  const durationSeconds = parseDurationSeconds(first?.duration);
  if (distanceMeters === undefined && durationSeconds === undefined) {
    return { mode: input.mode, raw: rawOf(result) };
  }
  const out: RouteResult = { mode: input.mode };
  if (distanceMeters !== undefined) out.distanceMeters = distanceMeters;
  if (durationSeconds !== undefined) out.durationSeconds = durationSeconds;
  if (rec?.attribution !== undefined) out.attribution = rec.attribution;
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/providers/maps.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Add the probe script, env docs and npm script**

Create `server/src/scripts/mapsProbe.ts`:

```ts
// Manual live check against Google's Maps Grounding Lite MCP server — prints the raw upstream
// output for both tools so the field mapping in providers/maps.ts can be confirmed against reality.
// Not part of the test suite (needs a real key and spends real quota).
//   GOOGLE_MAPS_API_KEY=... npm run maps:probe
import "dotenv/config";
import { createMcpClient } from "../services/mcpClient.js";
import { MAPS_MCP_URL, searchPlaces, computeRoute } from "../providers/maps.js";

const key = process.env.GOOGLE_MAPS_API_KEY?.trim();
if (!key) {
  console.error("Set GOOGLE_MAPS_API_KEY first.");
  process.exit(1);
}

const raw = createMcpClient({ name: "google-maps-probe", url: MAPS_MCP_URL, headers: { "X-Goog-Api-Key": key } });
console.log("tools:", await raw.listToolNames());
console.log(
  "raw search_places:",
  JSON.stringify(
    await raw.callTool("search_places", {
      text_query: "pharmacy",
      location_bias: { circle: { center: { latitude: 51.5308, longitude: -0.1238 }, radius_meters: 1500 } },
    }),
    null,
    2
  )
);
console.log(
  "raw compute_routes:",
  JSON.stringify(
    await raw.callTool("compute_routes", {
      origin: { address: "King's Cross Station, London" },
      destination: { address: "British Museum, London" },
      travel_mode: "WALK",
    }),
    null,
    2
  )
);
console.log("trimmed places:", JSON.stringify(await searchPlaces({ query: "pharmacy near King's Cross, London" }), null, 2));
console.log(
  "trimmed route:",
  JSON.stringify(await computeRoute({ origin: "King's Cross Station, London", destination: "British Museum, London", mode: "walk" }), null, 2)
);
await raw.close();
process.exit(0);
```

In `server/package.json` `scripts`, add after `"whatsapp:check"`:

```json
    "maps:probe": "tsx src/scripts/mapsProbe.ts"
```

In `server/.env.example`, append after the Claude section:

```
# --- Google Maps (optional: nearby places + driving/walking times) ---
# Google Cloud console > enable "Maps Grounding Lite API" on a billing-enabled project >
# Credentials > API key, restricted to that API. Set a daily quota as a cost backstop.
# Leave blank to disable — Marlowe then falls back to web search for places.
GOOGLE_MAPS_API_KEY=
```

- [ ] **Step 6: Build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 7: Live probe (only if a key is available)**

Run: `GOOGLE_MAPS_API_KEY=<key> npm run maps:probe`
Expected: `tools:` includes `search_places` and `compute_routes`; "trimmed places" shows named places with `mapsUrl`, and "trimmed route" shows `distanceMeters`/`durationSeconds` — **not** `raw`. If trimmed output falls back to `raw`, read the raw JSON printed above it, add the real field names to `trimPlace` / `computeRoute`, add a test case in `maps.test.ts` using a copy of that real payload, and re-run Steps 4 and 7. If no key is available yet, skip this step and note it in the task report.

- [ ] **Step 8: Commit**

```bash
git add server/src/providers/maps.ts server/src/providers/maps.test.ts server/src/scripts/mapsProbe.ts server/package.json server/.env.example
git commit -m "feat: Google Maps Grounding Lite provider (places + routes) over MCP"
```

---

### Task 3: WhatsApp location-request message

**Files:**
- Modify: `server/src/providers/whatsappSimTranscript.ts` (`SimTranscriptEntry`)
- Modify: `server/src/providers/whatsapp.ts` (new sender, after `sendWhatsAppCtaUrl`)
- Modify: `server/src/services/whatsappReply.ts`
- Modify: `server/src/ai/assistant.ts` (`AssistantReply` type only)
- Test: `server/src/providers/whatsapp.test.ts`, `server/src/services/whatsappReply.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1–2.
- Produces:
  ```ts
  // providers/whatsapp.ts
  export async function sendWhatsAppLocationRequest(to: string, bodyText: string): Promise<string | undefined>;
  // ai/assistant.ts — AssistantReply gains:
  locationRequest?: true;
  // providers/whatsappSimTranscript.ts — SimTranscriptEntry gains:
  locationRequest?: boolean;
  ```

- [ ] **Step 1: Write the failing sender tests**

In `server/src/providers/whatsapp.test.ts`, add `sendWhatsAppLocationRequest` to the import list from `./whatsapp.js`, then add:

```ts
describe("sendWhatsAppLocationRequest", () => {
  it("posts an interactive location_request_message with a send_location action", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({ messages: [{ id: "wamid.LOC" }] }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    const wamid = await sendWhatsAppLocationRequest("447000000001", "Tap below to share where you are.");

    expect(wamid).toBe("wamid.LOC");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "447000000001",
      type: "interactive",
      interactive: {
        type: "location_request_message",
        body: { text: "Tap below to share where you are." },
        action: { name: "send_location" },
      },
    });
  });

  it("throws a WhatsAppSendError on a non-OK response", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => "bad" }) as unknown as typeof fetch;
    await expect(sendWhatsAppLocationRequest("447000000001", "hi")).rejects.toThrow(WhatsAppSendError);
  });

  it("records a location request in the simulator transcript instead of calling Meta", async () => {
    const fetchMock = mockFetchOk();
    const to = simulatedPhoneForOwner(987654);

    await sendWhatsAppLocationRequest(to, "Share your location?");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(getSimTranscript(to).at(-1)).toMatchObject({ role: "assistant", text: "Share your location?", locationRequest: true });
  });
});
```

- [ ] **Step 2: Write the failing reply-rendering test**

In `server/src/services/whatsappReply.test.ts`:
- add `sendWhatsAppLocationRequest: vi.fn().mockResolvedValue("wamid.loc"),` to the `vi.mock("../providers/whatsapp.js", …)` object;
- add `sendWhatsAppLocationRequest` to the destructured `await import("../providers/whatsapp.js")`;
- add `vi.mocked(sendWhatsAppLocationRequest).mockClear();` to `beforeEach`;
- add this test inside `describe("sendAssistantReply", …)`:

```ts
  it("sends a location request with the Send location button and persists the prompt with its wamid", async () => {
    await sendAssistantReply(1, "44700", { text: "Tap below to share where you are.", locationRequest: true }, "wamid.in");

    expect(sendWhatsAppLocationRequest).toHaveBeenCalledWith("44700", "Tap below to share where you are.");
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(appendWhatsAppMessage).toHaveBeenCalledWith(1, "44700", "assistant", "Tap below to share where you are.", ["wamid.loc"]);
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/providers/whatsapp.test.ts src/services/whatsappReply.test.ts`
Expected: FAIL — `sendWhatsAppLocationRequest is not a function` / not exported, and a TS/type error on `locationRequest`.

- [ ] **Step 4: Implement**

In `server/src/providers/whatsappSimTranscript.ts`, add to `SimTranscriptEntry` after `link?`:

```ts
  /** A location_request_message — the simulator shows a "Send location" button for it. */
  locationRequest?: boolean;
```

In `server/src/providers/whatsapp.ts`, add after `sendWhatsAppCtaUrl`:

```ts
// A "Send location" button under a short prompt. Tapping it opens WhatsApp's own share-location
// screen; the pin comes back as an ordinary inbound location message (IncomingLocationMessage),
// which chatDispatch.handleLocation already turns into a new assistant turn. Like every
// interactive message it can only be sent within 24h of the user's last message — it's only ever
// sent as a reply, so that always holds.
export async function sendWhatsAppLocationRequest(to: string, bodyText: string): Promise<string | undefined> {
  if (isSimulatedPhone(to)) {
    recordSimMessage(to, { role: "assistant", text: bodyText, locationRequest: true });
    return `sim-wamid-${crypto.randomUUID()}`;
  }
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
        recipient_type: "individual",
        to,
        type: "interactive",
        interactive: {
          type: "location_request_message",
          body: { text: bodyText },
          action: { name: "send_location" },
        },
      }),
    }
  );
  if (!res.ok) {
    throw await buildSendError("WhatsApp location-request send failed", res);
  }
  return extractSentWamid(res);
}
```

In `server/src/ai/assistant.ts`, extend `AssistantReply` (currently at ~line 1786):

```ts
export interface AssistantReply {
  text: string;
  choice?: {
    actionId: string;
    question: string;
    mode: "confirm" | "resume";
    buttons: PendingChoiceButton[];
  };
  reaction?: {
    emoji: string;
  };
  // request_location was called: on WhatsApp, `text` is sent with a "Send location" button
  // (whatsappReply.ts). The web ignores this flag and just shows `text`.
  locationRequest?: true;
}
```

In `server/src/services/whatsappReply.ts`:
- change the whatsapp import to `import { sendWhatsAppMessage, sendChoiceMessage, sendWhatsAppReaction, sendWhatsAppLocationRequest } from "../providers/whatsapp.js";`
- insert directly after the `if (reply.reaction) { … return; }` block:

```ts
  if (reply.locationRequest) {
    // Persisted like any reply so the next turn — triggered by the pin the user shares — can see
    // what was asked for (chatDispatch.handleLocation appends the pin right after this row).
    const wamid = await sendWhatsAppLocationRequest(phone, reply.text);
    if (wamid) {
      appendWhatsAppMessage(ownerId, phone, "assistant", reply.text, [wamid]);
    } else {
      appendWhatsAppMessage(ownerId, phone, "assistant", reply.text);
    }
    return;
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/providers/whatsapp.test.ts src/services/whatsappReply.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/providers/whatsapp.ts server/src/providers/whatsapp.test.ts server/src/providers/whatsappSimTranscript.ts server/src/services/whatsappReply.ts server/src/services/whatsappReply.test.ts server/src/ai/assistant.ts
git commit -m "feat: WhatsApp Send-location request message and reply rendering"
```

---

### Task 4: Assistant tools, cap, hard stop and rules

**Files:**
- Modify: `server/src/ai/assistant.ts`
- Test: `server/src/ai/assistant.maps.test.ts`

**Interfaces:**
- Consumes: Task 2 `isMapsConfigured()`, `searchPlaces(...)`, `computeRoute(...)`; Task 3 `AssistantReply.locationRequest`.
- Produces: tool names `find_places`, `get_route`, `request_location`; exported constant `MAX_MAPS_CALLS_PER_MESSAGE = 5`.

- [ ] **Step 1: Write the failing tests**

Create `server/src/ai/assistant.maps.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  // Arrow functions can never be used as constructors — `new Anthropic()` in assistant.ts
  // requires a real function here, not `() => ({...})`.
  const MockAnthropic = vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  });
  return { __esModule: true, default: MockAnthropic };
});

const mockSearchPlaces = vi.fn();
const mockComputeRoute = vi.fn();
vi.mock("../providers/maps.js", () => ({
  isMapsConfigured: () => Boolean(process.env.GOOGLE_MAPS_API_KEY?.trim()),
  searchPlaces: (...args: unknown[]) => mockSearchPlaces(...args),
  computeRoute: (...args: unknown[]) => mockComputeRoute(...args),
}));

import { runAssistantChat, runTool, buildToolsForOwner, buildSystemPrompt } from "./assistant.js";
import { findOrCreateUserByEmail } from "../db/store.js";

const originalEnv = { ...process.env };
let counter = 0;
function newUser(prefix: string) {
  counter += 1;
  return findOrCreateUserByEmail(`${prefix}-${Date.now()}-${counter}@example.com`);
}

beforeEach(() => {
  mockCreate.mockReset();
  mockSearchPlaces.mockReset().mockResolvedValue({ places: [{ name: "Boots", mapsUrl: "https://maps.google.com/?cid=1" }] });
  mockComputeRoute.mockReset().mockResolvedValue({ mode: "walk", distanceMeters: 1800, durationSeconds: 1300 });
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.GOOGLE_MAPS_API_KEY = "maps-key";
});

afterEach(() => {
  process.env = { ...originalEnv };
});

function toolUse(id: string, name: string, input: Record<string, unknown>) {
  return { type: "tool_use", id, name, input };
}

describe("Maps tools — availability", () => {
  it("offers find_places, get_route and request_location only when a Maps key is set", () => {
    const user = newUser("maps-tools-on");
    const on = buildToolsForOwner(user.id).map((t) => t.name);
    expect(on).toEqual(expect.arrayContaining(["find_places", "get_route", "request_location"]));

    delete process.env.GOOGLE_MAPS_API_KEY;
    const off = buildToolsForOwner(user.id).map((t) => t.name);
    expect(off).not.toContain("find_places");
    expect(off).not.toContain("get_route");
    expect(off).not.toContain("request_location");
  });

  it("keeps the cache breakpoint on the last tool when Maps tools are appended", () => {
    const tools = buildToolsForOwner(newUser("maps-cache").id);
    const last = tools[tools.length - 1] as { cache_control?: unknown };
    expect(last.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(tools.filter((t) => (t as { cache_control?: unknown }).cache_control)).toHaveLength(1);
  });

  it("runTool refuses Maps tools when no key is configured", async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;
    const result = await runTool(newUser("maps-off-run").id, "find_places", { query: "cafe" });
    expect(result).toEqual({ error: "Maps lookups aren't set up on this server." });
    expect(mockSearchPlaces).not.toHaveBeenCalled();
  });
});

describe("runTool — Maps", () => {
  it("find_places passes query, pin and radius through to searchPlaces", async () => {
    const result = await runTool(newUser("find-places").id, "find_places", {
      query: "pharmacy open now",
      latitude: 51.53,
      longitude: -0.12,
      radius_meters: 1000,
    });

    expect(mockSearchPlaces).toHaveBeenCalledWith({
      query: "pharmacy open now",
      near: { latitude: 51.53, longitude: -0.12 },
      radiusMeters: 1000,
    });
    expect(result).toEqual({ places: [{ name: "Boots", mapsUrl: "https://maps.google.com/?cid=1" }] });
  });

  it("find_places ignores a half-specified pin", async () => {
    await runTool(newUser("find-places-half").id, "find_places", { query: "cafe", latitude: 51.5 });
    expect(mockSearchPlaces).toHaveBeenCalledWith({ query: "cafe" });
  });

  it("get_route defaults to drive and passes walk through", async () => {
    const ownerId = newUser("get-route").id;
    await runTool(ownerId, "get_route", { origin: "A", destination: "B" });
    await runTool(ownerId, "get_route", { origin: "A", destination: "B", mode: "walk" });

    expect(mockComputeRoute).toHaveBeenNthCalledWith(1, { origin: "A", destination: "B", mode: "drive" });
    expect(mockComputeRoute).toHaveBeenNthCalledWith(2, { origin: "A", destination: "B", mode: "walk" });
  });

  it("returns a short error instead of throwing when Maps fails", async () => {
    mockSearchPlaces.mockRejectedValueOnce(new Error("fetch failed"));
    const result = await runTool(newUser("maps-fail").id, "find_places", { query: "cafe" });
    expect(result).toEqual({ error: "Couldn't reach Google Maps: fetch failed" });
  });
});

describe("runAssistantChat — request_location", () => {
  it("on WhatsApp, ends the turn with a location request and makes no second API call", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [toolUse("t1", "request_location", { message: "Tap below to share where you are and I'll find the nearest pharmacy." })],
    });

    const reply = await runAssistantChat(newUser("req-loc-wa").id, [{ role: "user", content: "pharmacy near me?" }], "447000000001");

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(reply).toEqual({
      text: "Tap below to share where you are and I'll find the nearest pharmacy.",
      locationRequest: true,
    });
  });

  it("request_location wins over other tool calls in the same turn", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        { type: "text", text: "Let me check." },
        toolUse("t1", "find_places", { query: "pharmacy" }),
        toolUse("t2", "request_location", { message: "Share your location?" }),
      ],
    });

    const reply = await runAssistantChat(newUser("req-loc-mixed").id, [{ role: "user", content: "pharmacy near me" }], "447000000001");

    expect(reply).toEqual({ text: "Share your location?", locationRequest: true });
    expect(mockSearchPlaces).not.toHaveBeenCalled();
  });

  it("falls back to a default prompt when the message is empty", async () => {
    mockCreate.mockResolvedValueOnce({ content: [toolUse("t1", "request_location", { message: "  " })] });
    const reply = await runAssistantChat(newUser("req-loc-empty").id, [{ role: "user", content: "near me" }], "447000000001");
    expect(reply).toEqual({ text: "Tap below to share your location and I'll look it up.", locationRequest: true });
  });

  it("on the web, request_location asks the user to type their location", async () => {
    mockCreate.mockResolvedValueOnce({ content: [toolUse("t1", "request_location", { message: "Tap below to share where you are." })] });

    const reply = await runAssistantChat(newUser("req-loc-web").id, [{ role: "user", content: "pharmacy near me?" }]);

    expect(reply.locationRequest).toBeUndefined();
    expect(reply.text).toBe("Where are you? Tell me the area or an address and I'll look it up.");
  });
});

describe("runAssistantChat — Maps call cap", () => {
  it("caps Maps calls at 5 per message, counting parallel calls", async () => {
    const six = Array.from({ length: 6 }, (_, i) => toolUse(`t${i}`, "find_places", { query: `q${i}` }));
    mockCreate
      .mockResolvedValueOnce({ content: six })
      .mockResolvedValueOnce({ content: [toolUse("t9", "get_route", { origin: "A", destination: "B" })] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Here you go." }] });

    const reply = await runAssistantChat(newUser("maps-cap").id, [{ role: "user", content: "find lots" }], "447000000001");

    expect(reply.text).toBe("Here you go.");
    expect(mockSearchPlaces).toHaveBeenCalledTimes(5);
    expect(mockComputeRoute).not.toHaveBeenCalled();

    // The loop keeps appending to the same messages array, so read the tool results from the
    // final call's history rather than trusting .at(-1) of an earlier call.
    type Block = { type: string; is_error?: boolean; content?: string };
    const history = mockCreate.mock.calls[2][0].messages as Array<{ content: unknown }>;
    const firstResults = history.find(
      (m) => Array.isArray(m.content) && (m.content as Block[]).filter((b) => b.type === "tool_result").length === 6
    )!.content as Block[];
    const errors = firstResults.filter((r) => r.is_error);
    expect(errors).toHaveLength(1);
    expect(errors[0].content).toContain("Maps lookup limit");
  });

  it("does not carry the count over to the next message", async () => {
    const ownerId = newUser("maps-cap-reset").id;
    for (let i = 0; i < 2; i++) {
      mockCreate
        .mockResolvedValueOnce({ content: Array.from({ length: 5 }, (_, j) => toolUse(`t${j}`, "find_places", { query: `q${j}` })) })
        .mockResolvedValueOnce({ content: [{ type: "text", text: "ok" }] });
      await runAssistantChat(ownerId, [{ role: "user", content: `find ${i}` }], "447000000001");
    }
    expect(mockSearchPlaces).toHaveBeenCalledTimes(10);
  });
});

describe("system prompt — Maps rules", () => {
  it("with Maps configured, steers places to find_places and requires Maps sources", () => {
    const prompt = buildSystemPrompt(newUser("rules-on").id);
    expect(prompt).toContain("find_places");
    expect(prompt).toContain("Google Maps links");
    expect(prompt).not.toContain("https://www.google.com/maps/search/?api=1&query=");
  });

  it("without Maps, keeps the web_search hand-built Maps link rule", () => {
    delete process.env.GOOGLE_MAPS_API_KEY;
    const prompt = buildSystemPrompt(newUser("rules-off").id);
    expect(prompt).not.toContain("find_places");
    expect(prompt).toContain("https://www.google.com/maps/search/?api=1&query=");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/ai/assistant.maps.test.ts`
Expected: FAIL — `find_places` missing from tools, `runTool` returns `unknown tool`, etc.

- [ ] **Step 3: Add the import and tool definitions**

In `server/src/ai/assistant.ts`, next to `import { fetchWeather } from "../providers/weather.js";` add:

```ts
import { isMapsConfigured, searchPlaces, computeRoute } from "../providers/maps.js";
```

Directly above `export function buildToolsForOwner`, add:

```ts
// Google Maps Grounding Lite (providers/maps.ts), offered only when GOOGLE_MAPS_API_KEY is set —
// constant for the life of the process, so it never varies the cached tools prefix between
// requests. Pinned definitions, not the MCP server's own listTools() output: see
// services/mcpClient.ts for why.
const MAPS_TOOLS: Anthropic.Tool[] = [
  {
    name: "find_places",
    description:
      "Find real places (restaurants, cafés, pharmacies, hotels, shops, attractions…) from Google Maps: name, address, rating, whether it's open now, and a Google Maps link. Use this instead of web_search for any request to find or recommend places. For 'near me', pass latitude/longitude from the most recent '[User shared their location: lat, lng]' line in the conversation if it's under ~2 hours old. For a named area ('ramen in Lisbon', 'cafés near Borough Market'), put the area in the query and omit coordinates. For city-scale asks with no place named ('good restaurants here'), you may use the user's latest travel check-in city as the area if list_travel_checkins is available. If the user means near them specifically and there's no recent pin, call request_location instead of guessing. Always end your answer with the places' Google Maps links (and any attribution in the result) as sources.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to find, including the area if not using coordinates, e.g. 'pharmacy open now' or 'ramen in Lisbon'." },
        latitude: { type: "number", description: "Latitude of the user's recent pin. Pass together with longitude, or neither." },
        longitude: { type: "number", description: "Longitude of the user's recent pin. Pass together with latitude, or neither." },
        radius_meters: { type: "number", description: "Search radius around the coordinates, default 2000." },
      },
      required: ["query"],
    },
  },
  {
    name: "get_route",
    description:
      "Driving or walking distance and travel time between two places, from Google Maps. Driving and walking only — if asked about public transport, say plainly you can only give driving or walking times rather than inventing one. Origin/destination can be an address or place name, or 'lat,lng' from the user's recent pin. Cite the result's attribution as the source.",
    input_schema: {
      type: "object",
      properties: {
        origin: { type: "string", description: "Start: an address/place name, or 'lat,lng'." },
        destination: { type: "string", description: "End: an address/place name, or 'lat,lng'." },
        mode: { type: "string", enum: ["drive", "walk"], description: "Default drive." },
      },
      required: ["origin", "destination"],
    },
  },
  {
    name: "request_location",
    description:
      "Ask the user to share their current location with a one-tap 'Send location' button on WhatsApp. Use when they ask for something near them and there's no '[User shared their location: …]' line from the last ~2 hours. Call it ALONE — the only tool call in your turn. When they share it, you'll get their location as the next message; answer their original question then.",
    input_schema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "One short sentence saying what you'll do with it, e.g. \"Tap below to share where you are and I'll find the nearest pharmacy.\"",
        },
      },
      required: ["message"],
    },
  },
];

export const MAX_MAPS_CALLS_PER_MESSAGE = 5;
const MAPS_CALL_TOOLS = new Set(["find_places", "get_route"]);
```

In `buildToolsForOwner`, after the `for (const key of TOOL_KEYS) { … }` loop and before the cache-breakpoint block, add:

```ts
  if (isMapsConfigured()) result.push(...MAPS_TOOLS);
```

- [ ] **Step 4: Add the `runTool` cases**

In `runTool`'s `switch (name)`, next to `case "get_weather":`, add:

```ts
    case "find_places": {
      if (!isMapsConfigured()) return { error: "Maps lookups aren't set up on this server." };
      const lat = typeof input.latitude === "number" ? input.latitude : undefined;
      const lng = typeof input.longitude === "number" ? input.longitude : undefined;
      try {
        return await searchPlaces({
          query: String(input.query ?? ""),
          ...(lat !== undefined && lng !== undefined ? { near: { latitude: lat, longitude: lng } } : {}),
          ...(typeof input.radius_meters === "number" ? { radiusMeters: input.radius_meters } : {}),
        });
      } catch (err) {
        console.warn("find_places: Maps lookup failed", err);
        return { error: `Couldn't reach Google Maps: ${(err as Error).message}` };
      }
    }
    case "get_route": {
      if (!isMapsConfigured()) return { error: "Maps lookups aren't set up on this server." };
      try {
        return await computeRoute({
          origin: String(input.origin ?? ""),
          destination: String(input.destination ?? ""),
          mode: input.mode === "walk" ? "walk" : "drive",
        });
      } catch (err) {
        console.warn("get_route: Maps lookup failed", err);
        return { error: `Couldn't reach Google Maps: ${(err as Error).message}` };
      }
    }
```

- [ ] **Step 5: Add the hard stop and the per-message cap in `runAssistantChat`**

Directly after the `react_to_message` hard-stop block (the one ending `return finish({ text: "", reaction: { emoji: input.emoji as string } });` and its closing `}`), add:

```ts
    // request_location is a hard stop too — the answer arrives as the user's next message (their
    // shared pin, via chatDispatch.handleLocation), not as a tool result. It wins over any other
    // tool call in the same response, same as ask_user_choice. The web has no location button,
    // so there it becomes a plain question instead of "tap below" with nothing to tap.
    const locationUse = toolUses.find((t) => t.name === "request_location");
    if (locationUse) {
      if (!phone) {
        return finish({ text: "Where are you? Tell me the area or an address and I'll look it up." });
      }
      const raw = (locationUse.input as Record<string, unknown>).message;
      const message = typeof raw === "string" && raw.trim() ? raw.trim() : "Tap below to share your location and I'll look it up.";
      return finish({ text: message, locationRequest: true });
    }
```

Next to `const usageTotals = …` (before the `for (let turn = 0; …)` loop), add:

```ts
  // Maps calls made while answering this one user message — same blast-radius guard as
  // web_search's max_uses. Counted synchronously inside the map below, so parallel calls in one
  // response are counted too.
  let mapsCalls = 0;
```

In the `toolUses.map(async (toolUse) => { … })` callback, directly after the `CONFIRM_REQUIRED_TOOLS` early return and before `try {`, add:

```ts
        if (MAPS_CALL_TOOLS.has(toolUse.name) && ++mapsCalls > MAX_MAPS_CALLS_PER_MESSAGE) {
          return {
            type: "tool_result" as const,
            tool_use_id: toolUse.id,
            content: "Error: Maps lookup limit reached for this message — answer with what you already have.",
            is_error: true,
          };
        }
```

- [ ] **Step 6: Swap the places rule when Maps is configured**

In `buildRules`, replace the single `"- Use web_search for questions you don't have another tool for — nearby places (hotels, …) … never claim you've sent a location pin (you haven't).",` entry with a reference to a constant, and define both variants above `buildRules`:

```ts
const WEB_SEARCH_RULE_NO_MAPS =
  "- Use web_search for questions you don't have another tool for — nearby places (hotels, restaurants, attractions), current prices/events, or anything else that needs a live answer from the web rather than what you already know. Attribute the answer to what search turned up rather than presenting it as verified fact — e.g. \"these consistently come up as favorites near X\" or \"per current listings, ...\" — don't frame it as a disclaimer about lacking personal experience (you're an assistant, not a diner; that framing reads as oddly defensive rather than just informative). When you recommend a specific place, include a Google Maps link built as https://www.google.com/maps/search/?api=1&query=<url-encoded name and address/area> so the user can open it directly — never invent coordinates, and never claim you've sent a location pin (you haven't).";

const WEB_SEARCH_RULE_WITH_MAPS =
  "- Use find_places to find or recommend places and get_route for driving/walking times — they return real Google Maps data. Use web_search only for what Maps doesn't cover (reviews in depth, events, menus, prices, news). For anything near the user with no shared location from the last ~2 hours, call request_location rather than guessing where they are. Always list the Google Maps links (and any attribution) from the Maps result as sources right after your answer. Never invent coordinates or place details, and never claim you've sent a location pin (you haven't).";
```

Copy `WEB_SEARCH_RULE_NO_MAPS` **byte-for-byte** from the current line in `buildRules` (the text above is that line; verify with `git diff` that the no-Maps prompt is unchanged). Then in the `base` array replace the old string literal with:

```ts
    isMapsConfigured() ? WEB_SEARCH_RULE_WITH_MAPS : WEB_SEARCH_RULE_NO_MAPS,
```

- [ ] **Step 7: Run the new tests**

Run: `npx vitest run src/ai/assistant.maps.test.ts`
Expected: PASS (15 tests).

- [ ] **Step 8: Run the existing assistant tests (regression)**

Run: `npx vitest run src/ai/`
Expected: PASS. In particular `assistant.test.ts`'s `buildToolsForOwner` counts are unchanged because `GOOGLE_MAPS_API_KEY` is unset in those tests. If `src/test/setup.ts` or a local `.env` sets `GOOGLE_MAPS_API_KEY`, delete it in that file's `beforeEach` rather than changing expected counts.

- [ ] **Step 9: Build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 10: Commit**

```bash
git add server/src/ai/assistant.ts server/src/ai/assistant.maps.test.ts
git commit -m "feat: find_places, get_route and request_location assistant tools"
```

---

### Task 5: Simulator support for sharing a location

Needed for the spec's manual test: today the WhatsApp Simulator can only type text or tap reply buttons, so the "Send location" round trip can't be exercised without a real phone.

**Files:**
- Modify: `server/src/routes/whatsappSimRoutes.ts`
- Modify: `client/src/api/client.ts`
- Modify: `client/src/pages/WhatsAppSimPage.tsx`
- Test: `server/src/routes/whatsappSimRoutes.test.ts`

**Interfaces:**
- Consumes: Task 3 `SimTranscriptEntry.locationRequest`.
- Produces: `POST /whatsapp-sim/send` accepts `{ latitude: number, longitude: number }` → inbound `{ kind: "location", from, messageId, latitude, longitude }`.

- [ ] **Step 1: Write the failing route tests**

In `server/src/routes/whatsappSimRoutes.test.ts`, add inside the same `describe` as "sends a tapped button as a button reply…":

```ts
  it("sends a shared location as a location message", async () => {
    const { user, app } = newAdminApp("wa-sim-location");
    const phone = simulatedPhoneForOwner(user.id);

    const res = await request(app).post("/whatsapp-sim/send").send({ latitude: 51.5308, longitude: -0.1238 });

    expect(res.status).toBe(202);
    const arg = vi.mocked(handleIncoming).mock.calls[0][0];
    expect(arg).toMatchObject({ kind: "location", from: phone, latitude: 51.5308, longitude: -0.1238 });
    expect(getSimTranscript(phone).at(-1)?.text).toBe("[shared location 51.5308, -0.1238]");
  });

  it("rejects an out-of-range or half-specified location with 400", async () => {
    const { app } = newAdminApp("wa-sim-location-bad");

    for (const body of [{ latitude: 91, longitude: 0 }, { latitude: 10 }, { latitude: "x", longitude: 1 }]) {
      const res = await request(app).post("/whatsapp-sim/send").send(body);
      expect(res.status).toBe(400);
    }
    expect(handleIncoming).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/routes/whatsappSimRoutes.test.ts`
Expected: "sends a shared location as a location message" FAILS (the route answers 400 `text is required`). The 400-rejection test may already pass, since today every non-text body is rejected — that's fine; it guards the new validation.

- [ ] **Step 3: Implement the route change**

In `server/src/routes/whatsappSimRoutes.ts`, update the body comment to mention `{ latitude, longitude }`, and replace the block from `const text = …` through the `if (buttonId) { … } else { … }` with:

```ts
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  const buttonId = typeof req.body?.buttonId === "string" ? req.body.buttonId.trim() : "";
  const hasLat = req.body?.latitude !== undefined;
  const hasLng = req.body?.longitude !== undefined;
  const latitude = Number(req.body?.latitude);
  const longitude = Number(req.body?.longitude);
  const isLocation = hasLat || hasLng;
  if (
    isLocation &&
    !(
      hasLat &&
      hasLng &&
      typeof req.body.latitude === "number" &&
      typeof req.body.longitude === "number" &&
      Math.abs(latitude) <= 90 &&
      Math.abs(longitude) <= 180
    )
  ) {
    res.status(400).json({ error: "latitude and longitude must both be valid numbers" });
    return;
  }
  if (!text && !buttonId && !isLocation) {
    res.status(400).json({ error: "text is required" });
    return;
  }

  // Idempotent — binds the caller's own sim number on first use. Test users are deliberately
  // left unbound: registration binds them to a fresh account of their own.
  if (target.self) addPhoneNumberForUser(ownerId, phone);

  const messageId = `sim-${crypto.randomUUID()}`;
  let message: IncomingWhatsAppMessage;
  if (isLocation) {
    recordSimMessage(phone, { role: "user", text: `[shared location ${latitude}, ${longitude}]` });
    message = { kind: "location", from: phone, messageId, latitude, longitude };
  } else if (buttonId) {
    const label = typeof req.body?.label === "string" && req.body.label.trim() ? req.body.label.trim() : buttonId;
    recordSimMessage(phone, { role: "user", text: `[tapped ${label}]` });
    message = { kind: "interactive", from: phone, messageId, buttonId };
  } else {
    recordSimMessage(phone, { role: "user", text });
    message = { kind: "text", from: phone, text, messageId };
  }
```

(Keep the existing `handleIncoming(...)` and `res.status(202)` lines that follow.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/routes/whatsappSimRoutes.test.ts`
Expected: PASS.

- [ ] **Step 5: Client types**

In `client/src/api/client.ts`, add to `WhatsAppSimEntry` after `link?`:

```ts
  locationRequest?: boolean;
```

and replace the `WhatsAppSimInput` type with:

```ts
export type WhatsAppSimInput =
  | { text: string }
  | { buttonId: string; label: string }
  | { latitude: number; longitude: number };
```

- [ ] **Step 6: Simulator button**

In `client/src/pages/WhatsAppSimPage.tsx`, add this function next to `sendTyped`:

```tsx
  // Uses the browser's real location rather than a fixed test pin: a shared pin also sets the
  // account's timezone (chatDispatch.handleLocation), and "Me" is the admin's real account.
  function shareLocation() {
    if (!navigator.geolocation) {
      setError("This browser can't share a location.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => void send({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
      (err) => setError(`Couldn't get your location: ${err.message}`),
      { timeout: 10_000 }
    );
  }
```

and, inside the entry bubble, directly after the `{entry.link && ( … )}` block, add:

```tsx
                {entry.locationRequest && (
                  <div className="chips" style={{ marginTop: 8 }}>
                    <button type="button" className="chip-minimal" disabled={busy} onClick={shareLocation}>
                      📍 Send location
                    </button>
                  </div>
                )}
```

- [ ] **Step 7: Build the client**

Run (from `client/`): `npm run build`
Expected: exits 0.

- [ ] **Step 8: Commit**

```bash
git add server/src/routes/whatsappSimRoutes.ts server/src/routes/whatsappSimRoutes.test.ts client/src/api/client.ts client/src/pages/WhatsAppSimPage.tsx
git commit -m "feat: share a location from the WhatsApp Simulator"
```

---

### Task 6: Full verification and docs

**Files:**
- Modify: `README.md` (feature list)

- [ ] **Step 1: Full server test suite**

Run (from `server/`): `npm test`
Expected: all tests pass. Paste the summary line in the task report.

- [ ] **Step 2: Builds**

Run: `npm run build` in `server/` and in `client/`.
Expected: both exit 0.

- [ ] **Step 3: README**

In `README.md`, under "## What Marlowe does", after the **News, weather, and markets** bullet, add:

```markdown
- **Places and travel times (optional):** With `GOOGLE_MAPS_API_KEY` set, the assistant finds real nearby places and driving/walking times through Google's Maps Grounding Lite MCP server. On WhatsApp it can ask for your location with a one-tap "Send location" button.
```

- [ ] **Step 4: Manual check (needs a Maps key; skip and say so if none yet)**

With `GOOGLE_MAPS_API_KEY` in `server/.env` and `ENABLE_WHATSAPP_SIMULATOR=true`, run `npm run dev` in `server/` and `client/`, open the WhatsApp Simulator and check:
1. "Is there a pharmacy open near me?" → reply with a **📍 Send location** button → tap it, allow browser location → a reply listing real pharmacies with Google Maps links at the end.
2. "How long to walk from King's Cross to the British Museum?" → a walking time and distance, no location request.
3. "Can I get the tube there?" → says it can only do driving or walking times.
4. In the web assistant page, "pharmacy near me?" → asks you to type where you are (no button text).
5. Remove the key and restart → "cafés near Borough Market" still answers via web search with a hand-built Maps link.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: mention Google Maps places and travel times"
```

---

## Operator follow-up (not code)

- Enable **Maps Grounding Lite API** on a billing-enabled Google Cloud project, create an API key restricted to that API, and set a daily request quota.
- Add `GOOGLE_MAPS_API_KEY` to Railway. Merging before the key exists is safe — nothing changes until it's set.
