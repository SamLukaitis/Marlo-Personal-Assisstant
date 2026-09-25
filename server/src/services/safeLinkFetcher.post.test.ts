import { describe, it, expect, vi, afterEach } from "vitest";
import { safePostOneClick } from "./safeLinkFetcher.js";

// Public IP literals skip DNS, so these tests never touch the network resolver.
const PUBLIC_URL = "https://93.184.216.34/unsub/abc";

function stubFetch(impl: (...args: unknown[]) => unknown) {
  const fn = vi.fn(impl);
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("safePostOneClick", () => {
  it("POSTs the RFC 8058 body without following redirects", async () => {
    const fetchFn = stubFetch(async () => new Response("ok", { status: 200 }));
    const r = await safePostOneClick(PUBLIC_URL);
    expect(r).toEqual({ ok: true, status: 200 });
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(PUBLIC_URL);
    expect(init.method).toBe("POST");
    expect(init.body).toBe("List-Unsubscribe=One-Click");
    expect(init.redirect).toBe("manual");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/x-www-form-urlencoded");
  });

  it("refuses private, loopback and metadata addresses without fetching", async () => {
    const fetchFn = stubFetch(async () => new Response("", { status: 200 }));
    for (const url of ["https://127.0.0.1/u", "https://10.0.0.5/u", "https://169.254.169.254/latest", "https://[::1]/u"]) {
      const r = await safePostOneClick(url);
      expect(r).toMatchObject({ ok: false, reason: "blocked_host" });
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("refuses non-http(s) schemes and userinfo", async () => {
    const fetchFn = stubFetch(async () => new Response("", { status: 200 }));
    expect(await safePostOneClick("ftp://93.184.216.34/u")).toMatchObject({ ok: false, reason: "unsupported_scheme" });
    expect(await safePostOneClick("https://user:pw@93.184.216.34/u")).toMatchObject({ ok: false, reason: "invalid_url" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("does not treat a redirect as success", async () => {
    stubFetch(async () => new Response(null, { status: 302, headers: { location: "https://127.0.0.1/x" } }));
    const r = await safePostOneClick(PUBLIC_URL);
    expect(r).toMatchObject({ ok: false, reason: "http_error" });
  });

  it("reports a non-2xx response as failed", async () => {
    stubFetch(async () => new Response("nope", { status: 404 }));
    const r = await safePostOneClick(PUBLIC_URL);
    expect(r).toMatchObject({ ok: false, reason: "http_error" });
  });

  it("reports network failures", async () => {
    stubFetch(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    const r = await safePostOneClick(PUBLIC_URL);
    expect(r).toMatchObject({ ok: false, reason: "network_error" });
  });

  it("times out", async () => {
    stubFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          (init as RequestInit).signal!.addEventListener("abort", () => reject(new Error("aborted")));
        })
    );
    const r = await safePostOneClick(PUBLIC_URL, { timeoutMs: 20 });
    expect(r).toMatchObject({ ok: false, reason: "timeout" });
  });
});
