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
