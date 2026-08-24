// Dependency-free safe link fetching + HTML-to-text extraction (Node built-ins only: global
// fetch, node:dns). Used for the "forwarded link" ingestion path — a WhatsApp text message that
// looks like it's asking us to save a URL's content the way we already save a photo/PDF.
//
// WHY this module is written this defensively: the target URL is attacker-influenced (any user
// who can message the bot can send any link), so this is an SSRF-prone code path. Everything
// here fails CLOSED — when in doubt, reject rather than fetch.

import { promises as dnsPromises } from "node:dns";
import { htmlToText } from "./htmlToText.js";

export type FetchFailureReason =
  | "invalid_url"
  | "unsupported_scheme"
  | "blocked_host"
  | "dns_error"
  | "timeout"
  | "too_many_redirects"
  | "non_html_content"
  | "response_too_large"
  | "network_error";

export type FetchPageResult =
  | { ok: true; text: string; finalUrl: string; bytes: number; truncated: boolean }
  | { ok: false; reason: FetchFailureReason; detail?: string };

export interface FetchPageOptions {
  timeoutMs?: number; // overall deadline across all hops (default 8_000)
  maxBytes?: number; // hard cap on downloaded body (default 1 MiB)
  maxRedirects?: number; // default 4
}

export class SafeFetchError extends Error {
  constructor(
    public reason: FetchFailureReason,
    detail: string
  ) {
    super(`${reason}: ${detail}`);
    this.name = "SafeFetchError";
  }
}

// ---------------------------------------------------------------------------
// IP classification (pure, testable)
// ---------------------------------------------------------------------------

function parseIpv4(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const p of parts) {
    // Reject leading zeros ("010" ambiguity between octal and decimal) and non-numeric junk.
    if (!/^\d{1,3}$/.test(p) || (p.length > 1 && p[0] === "0")) return null;
    const n = Number(p);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets as [number, number, number, number];
}

/**
 * Parse an IPv6 address into its 8 16-bit groups, or null if invalid. Expects a bare address
 * (no surrounding brackets) — callers must strip `[...]` first (see `stripBrackets`).
 */
function parseIpv6(input: string): number[] | null {
  // Strip a zone id (%eth0) if present — never routable for our purposes anyway.
  const pct = input.indexOf("%");
  const ip = pct === -1 ? input : input.slice(0, pct);

  let headStr: string;
  let tailStr: string;
  if (ip.includes("::")) {
    const halves = ip.split("::");
    if (halves.length !== 2) return null; // more than one "::" is invalid
    headStr = halves[0];
    tailStr = halves[1];
  } else {
    headStr = ip;
    tailStr = "";
  }

  const parseGroup = (s: string): number | null =>
    /^[0-9a-fA-F]{1,4}$/.test(s) ? parseInt(s, 16) : null;

  // An embedded IPv4 tail (::ffff:1.2.3.4) becomes two 16-bit groups.
  const expandTail = (segments: string[]): number[] | null => {
    if (segments.length === 0) return [];
    const last = segments[segments.length - 1];
    if (last.includes(".")) {
      const v4 = parseIpv4(last);
      if (!v4) return null;
      const headGroups = segments.slice(0, -1).map(parseGroup);
      if (headGroups.some((g) => g === null)) return null;
      return [...(headGroups as number[]), (v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    }
    const groups = segments.map(parseGroup);
    if (groups.some((g) => g === null)) return null;
    return groups as number[];
  };

  const head = expandTail(headStr ? headStr.split(":") : []);
  const tail = expandTail(tailStr ? tailStr.split(":") : []);
  if (!head || !tail) return null;

  const total = head.length + tail.length;
  if (total > 8) return null;

  if (ip.includes("::")) {
    // "::" expands to fill the middle with zeros.
    const zeros = 8 - total;
    return [...head, ...new Array(zeros).fill(0), ...tail];
  }
  // No "::": must be a full 8-group address.
  if (total !== 8) return null;
  return [...head, ...tail];
}

function isBlockedIpv4(o: [number, number, number, number]): boolean {
  const [a, b] = o;
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  if (a === 0) return true; // 0.0.0.0/8 "this network" — never a legit target
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT — fail closed
  return false;
}

function isBlockedIpv6(g: number[]): boolean {
  const allZero = g.every((x) => x === 0);
  if (allZero) return true; // :: unspecified
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1 loopback
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if (g[0] >>> 6 === 0x3fa) return true; // fe80::/10 link-local (top 10 bits 1111111010)
  // ::ffff:0:0/96 IPv4-mapped — the embedded v4 must itself be public.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return isBlockedIpv4([(g[6] >> 8) & 0xff, g[6] & 0xff, (g[7] >> 8) & 0xff, g[7] & 0xff]);
  }
  // 64:ff9b::/96 NAT64 — synthesizes an internal v4 behind the translator; fail closed.
  if (g[0] === 0x0064 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return true;
  // Accepted limitation: 6to4 (2002::/16) and Teredo can tunnel toward private space;
  // extremely unlikely as an attack vector here and not blocked. Revisit if the threat model
  // changes (e.g. this ever runs somewhere with a real internal network behind it).
  return false;
}

/**
 * Strip a `[...]` bracket wrapper, if present. `new URL(...).hostname` keeps the brackets
 * around an IPv6 literal (`http://[::1]/` -> hostname `"[::1]"`) — DNS-resolved addresses from
 * `dns.lookup` never have brackets, so this only matters for IPv6 written directly in a URL.
 */
function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/**
 * Pure predicate: given an IP string (brackets already stripped), is it in a blocked
 * (private/internal/loopback/link-local/etc.) range? Exported for unit tests.
 */
export function isBlockedIp(ip: string): boolean {
  const trimmed = stripBrackets(ip.trim());
  if (trimmed.includes(":")) {
    const groups = parseIpv6(trimmed);
    // Unparseable IPv6 — fail closed.
    return groups ? isBlockedIpv6(groups) : true;
  }
  const octets = parseIpv4(trimmed);
  // Unparseable IPv4 — fail closed.
  return octets ? isBlockedIpv4(octets) : true;
}

// ---------------------------------------------------------------------------
// URL validation (pure, testable)
// ---------------------------------------------------------------------------

/**
 * Validate scheme + shape. Returns the parsed URL, or throws SafeFetchError with reason
 * 'unsupported_scheme' / 'invalid_url'.
 *
 * Note: Node's WHATWG URL parser already normalizes legacy IPv4 encodings (decimal, octal, hex
 * — e.g. `http://2130706433/` and `http://0x7f000001/` both become hostname `127.0.0.1`) before
 * we ever see `.hostname`, so the IP-range check below isn't bypassable through those classic
 * SSRF obfuscation tricks — verified directly against Node's URL implementation.
 */
export function validateHttpUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new SafeFetchError("invalid_url", `not a parsable URL: ${rawUrl.slice(0, 120)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SafeFetchError("unsupported_scheme", `scheme ${url.protocol} not allowed`);
  }
  // Userinfo (http://user:pass@host/) is a classic SSRF/filter-confusion trick — reject.
  if (url.username || url.password) {
    throw new SafeFetchError("invalid_url", "userinfo credentials not allowed");
  }
  if (!url.hostname) {
    throw new SafeFetchError("invalid_url", "missing hostname");
  }
  return url;
}

// ---------------------------------------------------------------------------
// Host resolution + check
// ---------------------------------------------------------------------------

const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Resolve hostname and verify EVERY address is public. Throws SafeFetchError
 * ('blocked_host' | 'dns_error'). IP literals (including bracketed IPv6) skip DNS and are
 * checked directly.
 *
 * KNOWN GAP (documented, not hidden): this resolves DNS once here, but the actual `fetch` call
 * re-resolves independently at connect time — a classic DNS-rebinding TOCTOU. An attacker with a
 * short-TTL record could return a public IP for this check and a private IP when `fetch` itself
 * connects. Closing this fully requires connecting to the *already-validated* IP address
 * directly (a custom low-level connect step that pins the address while still sending the
 * correct Host/SNI) instead of letting `fetch` re-dial the hostname — not expressible with the
 * stock `fetch` API used here. Documented as an accepted gap rather than pretended away; revisit
 * if this fetcher is ever pointed at a genuinely adversarial, high-value target list.
 */
async function assertHostIsPublic(hostname: string): Promise<void> {
  const host = stripBrackets(hostname.toLowerCase());

  if (IPV4_LITERAL.test(host) || host.includes(":")) {
    if (isBlockedIp(host)) {
      throw new SafeFetchError("blocked_host", `IP literal ${host} is in a blocked range`);
    }
    return;
  }

  let records: { address: string; family: number }[];
  try {
    records = await dnsPromises.lookup(host, { all: true });
  } catch (e) {
    throw new SafeFetchError("dns_error", `lookup failed for ${host}: ${(e as Error).message}`);
  }
  if (records.length === 0) {
    throw new SafeFetchError("dns_error", `no addresses for ${host}`);
  }
  // Fail closed if ANY resolved address is blocked — don't let one clean A record launder a
  // dirty AAAA record (or vice versa).
  for (const r of records) {
    if (isBlockedIp(r.address)) {
      throw new SafeFetchError("blocked_host", `${host} resolves to blocked IP ${r.address}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Link-detection heuristic (pure, testable)
// ---------------------------------------------------------------------------

const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/i;

/**
 * Returns the URL iff a WhatsApp text message qualifies as a "save this link" command: exactly
 * one URL, and everything outside it is <= 40 chars of lead-in text. A bare URL trivially
 * qualifies.
 *
 * WHY 40 chars and this shape: generous enough for real forwarding phrasing ("here's my hotel
 * confirmation:", "save this") but strict enough that ordinary conversation that happens to
 * mention a link ("can you check https://x and tell me if it's any good") stays conversation.
 * The costs are asymmetric — a false positive fires an outbound fetch + an LLM extraction call
 * and pollutes the document store; a false negative just means the user re-sends the bare link.
 * Bias hard toward precision.
 */
export function findSaveableUrl(message: string): string | null {
  const match = message.match(URL_REGEX);
  if (!match || match.index === undefined) return null;
  // More than one URL in the message -> ambiguous which one to save -> treat as conversation.
  const rest = message.slice(match.index + match[0].length);
  if (URL_REGEX.test(rest)) return null;

  const outside = (message.slice(0, match.index) + rest).trim();
  if (outside.length > 40) return null;

  // Trailing punctuation glommed onto the URL by surrounding prose ("...at https://x.com.").
  return match[0].replace(/[.,;:!?)\]]+$/, "");
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export async function fetchPageText(
  rawUrl: string,
  options: FetchPageOptions = {}
): Promise<FetchPageResult> {
  const { timeoutMs = 8_000, maxBytes = 1_024 * 1_024, maxRedirects = 4 } = options;

  // One deadline across ALL hops — otherwise a redirect chain multiplies the wait.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let currentUrl: URL;
    try {
      currentUrl = validateHttpUrl(rawUrl);
    } catch (e) {
      const err = e as SafeFetchError;
      return { ok: false, reason: err.reason, detail: err.message };
    }

    for (let hop = 0; hop <= maxRedirects; hop++) {
      // Re-validate scheme + DNS on EVERY hop, including hop 0 and the final URL.
      try {
        await assertHostIsPublic(currentUrl.hostname);
      } catch (e) {
        const err = e as SafeFetchError;
        return { ok: false, reason: err.reason, detail: err.message };
      }

      let res: Response;
      try {
        // redirect:'manual' so WE own redirect validation instead of the fetch implementation
        // silently following a hop straight into blocked address space.
        res = await fetch(currentUrl.toString(), {
          redirect: "manual",
          signal: controller.signal,
          headers: {
            accept: "text/html,application/xhtml+xml",
            "user-agent": "Mozilla/5.0 (compatible; personal-assistant-link-fetcher)",
          },
        });
      } catch (e) {
        if (controller.signal.aborted) {
          return { ok: false, reason: "timeout", detail: `deadline exceeded at ${currentUrl}` };
        }
        return { ok: false, reason: "network_error", detail: (e as Error).message };
      }

      if (REDIRECT_STATUSES.has(res.status)) {
        const location = res.headers.get("location");
        await res.body?.cancel().catch(() => {}); // free the socket promptly; never read redirect bodies
        if (!location) {
          return { ok: false, reason: "network_error", detail: `redirect ${res.status} without Location` };
        }
        let next: URL;
        try {
          next = new URL(location, currentUrl); // resolve relative Locations against the current URL
        } catch {
          return { ok: false, reason: "invalid_url", detail: `bad redirect Location: ${location}` };
        }
        try {
          currentUrl = validateHttpUrl(next.toString());
        } catch (e) {
          const err = e as SafeFetchError;
          return { ok: false, reason: err.reason, detail: `redirect target rejected: ${err.message}` };
        }
        if (hop === maxRedirects) {
          return { ok: false, reason: "too_many_redirects", detail: `exceeded ${maxRedirects} hops` };
        }
        continue;
      }

      // Only run HTML extraction over HTML — PDFs, images, JSON APIs go through other pipelines
      // or are rejected here rather than mangled through an HTML stripper.
      const contentType = res.headers.get("content-type") ?? "";
      if (!/^text\/html\b/i.test(contentType) && !/^application\/xhtml\+xml\b/i.test(contentType)) {
        await res.body?.cancel().catch(() => {});
        return { ok: false, reason: "non_html_content", detail: `content-type: ${contentType || "none"}` };
      }

      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return { ok: false, reason: "network_error", detail: `HTTP ${res.status}` };
      }

      if (!res.body) {
        return { ok: false, reason: "network_error", detail: "empty response body" };
      }

      // Stream the body with a hard byte cap — never buffer an unbounded response; abort the
      // connection the moment the cap is exceeded.
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      let truncated = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) {
            truncated = true;
            await reader.cancel().catch(() => {});
            break;
          }
          chunks.push(value);
        }
      } catch (e) {
        if (controller.signal.aborted) {
          return { ok: false, reason: "timeout", detail: "deadline exceeded mid-body" };
        }
        return { ok: false, reason: "network_error", detail: (e as Error).message };
      }

      const html = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
      return {
        ok: true,
        text: htmlToText(html),
        finalUrl: currentUrl.toString(),
        bytes: size,
        truncated,
      };
    }

    return { ok: false, reason: "too_many_redirects", detail: `exceeded ${maxRedirects} hops` };
  } finally {
    clearTimeout(timer);
  }
}
