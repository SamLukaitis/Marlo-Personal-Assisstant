// Gives every plain fetch() in the process a deadline. Dozens of call sites (WhatsApp sends,
// Microsoft Graph, weather, geocoding) call fetch with no timeout of their own, so a stalled
// connection was waited on for as long as Node allowed (5 minutes per phase), and each of those
// sits inside the scheduler's 5-minute tick. Installed once at startup (index.ts) rather than
// threaded through every call site.
//
// A call that passes its own signal is left alone: the Anthropic and MCP SDKs manage their own
// timeouts and long-lived streams, and safeLinkFetcher.ts has a tighter deadline of its own.
export const DEFAULT_FETCH_TIMEOUT_MS = 60_000;

let installed = false;

export function withDefaultTimeout(inner: typeof fetch, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const hasOwnSignal = !!init?.signal || (typeof Request !== "undefined" && input instanceof Request);
    if (hasOwnSignal) return inner(input, init);
    return inner(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  }) as typeof fetch;
}

export function installFetchTimeout(): void {
  if (installed) return;
  installed = true;
  globalThis.fetch = withDefaultTimeout(globalThis.fetch.bind(globalThis));
}
