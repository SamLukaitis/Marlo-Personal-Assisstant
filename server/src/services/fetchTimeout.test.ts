import { describe, it, expect, vi } from "vitest";
import { withDefaultTimeout } from "./fetchTimeout.js";
import { withDeadline, DeadlineError } from "./deadline.js";

describe("withDefaultTimeout", () => {
  it("adds a deadline to a fetch that has none", async () => {
    const inner = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response("ok"));
    await withDefaultTimeout(inner as unknown as typeof fetch, 1000)("https://example.test/x", { method: "POST" });
    const init = inner.mock.calls[0][1];
    expect(init?.method).toBe("POST");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("leaves a caller's own signal alone", async () => {
    const inner = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response("ok"));
    const own = new AbortController().signal;
    await withDefaultTimeout(inner as unknown as typeof fetch, 1000)("https://example.test/x", { signal: own });
    expect(inner.mock.calls[0][1]?.signal).toBe(own);
  });

  it("aborts a fetch that never answers", async () => {
    const inner = ((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as unknown as typeof fetch;
    await expect(withDefaultTimeout(inner, 20)("https://example.test/hang")).rejects.toThrow();
  });
});

describe("withDeadline", () => {
  it("passes through a value that arrives in time", async () => {
    await expect(withDeadline(Promise.resolve(7), 1000, "x")).resolves.toBe(7);
  });

  it("passes through a rejection that arrives in time", async () => {
    await expect(withDeadline(Promise.reject(new Error("boom")), 1000, "x")).rejects.toThrow("boom");
  });

  it("rejects with a DeadlineError naming the work when it never settles", async () => {
    const err = await withDeadline(new Promise(() => {}), 20, "alerts check for user 3").catch((e) => e);
    expect(err).toBeInstanceOf(DeadlineError);
    expect(err.message).toBe("alerts check for user 3 timed out after 0s");
  });
});
