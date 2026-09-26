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
