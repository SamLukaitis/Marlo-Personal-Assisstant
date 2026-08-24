import { describe, it, expect } from "vitest";
import { isBlockedIp, validateHttpUrl, findSaveableUrl, SafeFetchError } from "./safeLinkFetcher.js";
import { htmlToText } from "./htmlToText.js";

describe("isBlockedIp — IPv4", () => {
  it.each([
    ["10.0.0.1"], ["10.255.255.255"], // 10/8
    ["172.16.0.0"], ["172.31.255.255"], // 172.16/12 boundaries (inside)
    ["192.168.0.1"], ["192.168.255.255"], // 192.168/16
    ["127.0.0.1"], ["127.255.255.254"], // loopback
    ["169.254.1.1"], // link-local
    ["0.0.0.0"], ["0.1.2.3"], // "this network"
    ["100.64.0.1"], ["100.127.255.255"], // CGNAT
  ])("blocks %s", (ip) => expect(isBlockedIp(ip)).toBe(true));

  it.each([
    ["8.8.8.8"],
    ["1.1.1.1"],
    ["172.15.255.255"], // just below 172.16/12
    ["172.32.0.0"], // just above 172.16/12
    ["192.169.0.1"], // just outside 192.168/16
    ["128.0.0.1"],
    ["100.63.255.255"], // just below CGNAT
    ["100.128.0.0"], // just above CGNAT
  ])("allows %s", (ip) => expect(isBlockedIp(ip)).toBe(false));

  it("fails closed on malformed input", () => {
    expect(isBlockedIp("not-an-ip")).toBe(true);
    expect(isBlockedIp("999.1.1.1")).toBe(true);
    expect(isBlockedIp("01.2.3.4")).toBe(true); // leading-zero ambiguity
    expect(isBlockedIp("")).toBe(true);
  });
});

describe("isBlockedIp — IPv6", () => {
  it.each([
    ["::1"], // loopback
    ["::"], // unspecified
    ["fe80::1"], // link-local
    ["febf::1"], // top of fe80::/10
    ["fc00::1"], // unique-local
    ["fd12:3456:789a::1"], // unique-local (fd00::/8 half)
    ["::ffff:127.0.0.1"], // v4-mapped loopback
    ["::ffff:10.0.0.5"], // v4-mapped private
    ["64:ff9b::7f00:1"], // NAT64 wrapping 127.0.0.1
  ])("blocks %s", (ip) => expect(isBlockedIp(ip)).toBe(true));

  it.each([
    ["2606:4700::1111"],
    ["2001:4860:4860::8888"],
    ["::ffff:8.8.8.8"], // v4-mapped public
  ])("allows %s", (ip) => expect(isBlockedIp(ip)).toBe(false));

  // Regression test: `new URL(...).hostname` keeps brackets around an IPv6 literal
  // ("http://[2606:4700::1111]/" -> hostname "[2606:4700::1111]"), unlike a DNS-resolved
  // address, which never has brackets. isBlockedIp must strip them itself, or every literal
  // IPv6 URL — including entirely public ones — silently fails closed as "blocked".
  it("strips brackets so a public IPv6 literal from a URL's .hostname isn't wrongly blocked", () => {
    expect(isBlockedIp("[2606:4700::1111]")).toBe(false);
    expect(isBlockedIp("[::1]")).toBe(true); // still correctly blocks a bracketed loopback
  });
});

describe("validateHttpUrl — scheme validation", () => {
  it("accepts http and https", () => {
    expect(validateHttpUrl("https://example.com/x").protocol).toBe("https:");
    expect(validateHttpUrl("http://example.com/").protocol).toBe("http:");
  });

  it.each([
    ["file:///etc/passwd"],
    ["data:text/html,<h1>x</h1>"],
    ["ftp://example.com/file"],
    ["javascript:alert(1)"],
    ["gopher://example.com"],
  ])("rejects %s", (raw) => {
    expect(() => validateHttpUrl(raw)).toThrow(SafeFetchError);
    try {
      validateHttpUrl(raw);
    } catch (e) {
      expect((e as SafeFetchError).reason).toBe("unsupported_scheme");
    }
  });

  it("rejects userinfo credentials", () => {
    expect(() => validateHttpUrl("https://user:pass@example.com/")).toThrow(SafeFetchError);
  });

  it("rejects unparsable garbage", () => {
    expect(() => validateHttpUrl("not a url")).toThrow(SafeFetchError);
  });

  // Regression: Node's URL parser normalizes legacy IPv4 encodings (decimal/octal/hex) to
  // dotted-decimal in `.hostname` — a classic SSRF obfuscation trick against naive string
  // matching. Verified this actually holds in this Node runtime, not just assumed.
  it("normalizes legacy IPv4 encodings to dotted-decimal (verified against a real SSRF bypass class)", () => {
    expect(validateHttpUrl("http://2130706433/").hostname).toBe("127.0.0.1");
    expect(validateHttpUrl("http://0x7f000001/").hostname).toBe("127.0.0.1");
    expect(validateHttpUrl("http://0177.0.0.1/").hostname).toBe("127.0.0.1");
    expect(isBlockedIp(validateHttpUrl("http://2130706433/").hostname)).toBe(true);
  });
});

describe("findSaveableUrl — detection heuristic", () => {
  it("accepts a bare URL", () => {
    expect(findSaveableUrl("https://hotels.example.com/abc123")).toBe(
      "https://hotels.example.com/abc123"
    );
  });
  it("accepts a short lead-in", () => {
    expect(findSaveableUrl("here's my hotel confirmation: https://x.example.com/bk/99")).toBe(
      "https://x.example.com/bk/99"
    );
  });
  it("rejects conversational mentions (long surrounding text)", () => {
    expect(
      findSaveableUrl(
        "can you check https://x.example.com and tell me if the cancellation policy looks reasonable?"
      )
    ).toBeNull();
  });
  it("rejects multiple URLs regardless of combined lead-in length", () => {
    // Regression: the combined-length check alone isn't a real "one URL" guarantee — two short
    // URLs with a short gap between them could otherwise sneak under the 40-char budget and
    // silently save only the first, dropping the second without telling the user.
    expect(findSaveableUrl("https://a.example.com https://b.example.com")).toBeNull();
    expect(findSaveableUrl("compare https://a.example.com and https://b.example.com")).toBeNull();
  });
  it("strips trailing sentence punctuation from the URL", () => {
    expect(findSaveableUrl("https://x.example.com/page.")).toBe("https://x.example.com/page");
  });
  it("returns null for non-URL messages", () => {
    expect(findSaveableUrl("what time is my flight tomorrow?")).toBeNull();
  });
});

describe("htmlToText", () => {
  it("strips scripts and styles entirely, including their contents", () => {
    const html =
      "<html><head><style>body{color:red}</style></head>" +
      '<body><script>var x = "<p>evil</p>";</script><p>Hello world</p></body></html>';
    const text = htmlToText(html);
    expect(text).toContain("Hello world");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("evil");
    expect(text).not.toContain("<p>");
  });

  it("converts block tags to line breaks", () => {
    const text = htmlToText("<div>Line one</div><div>Line two</div><p>Para three</p>");
    expect(text).toBe("Line one\nLine two\nPara three");
  });

  it("decodes named and numeric entities", () => {
    const text = htmlToText("<p>A &amp; B &lt;tag&gt; &#8212; dash &#x2713;</p>");
    expect(text).toContain("A & B <tag> — dash ✓");
  });

  it("collapses whitespace and blank-line runs down to a single separator line", () => {
    // Two separate <p> blocks with extra blank lines between them in the source collapse to
    // exactly one blank line, not zero — a real paragraph break is worth preserving for the
    // downstream LLM extractor, matching this function's own "collapse to a single blank line"
    // design (see the whitespace-normalization step above), not "remove paragraph breaks".
    const text = htmlToText("<p>Alpha</p>\n\n\n<p>\n   Beta   gamma  </p>");
    expect(text).toBe("Alpha\n\nBeta gamma");
  });

  it("collapses runs of whitespace within a single line", () => {
    const text = htmlToText("<p>Beta   gamma</p>");
    expect(text).toBe("Beta gamma");
  });

  it("drops comments and extracts the title", () => {
    const text = htmlToText(
      "<html><head><title>My Booking</title></head>" +
        "<body><!-- nav --><p>Details here</p></body></html>"
    );
    expect(text).toContain("Details here");
    expect(text).not.toContain("<!--");
    expect(text.startsWith("My Booking")).toBe(true);
  });

  it("leaves entity-encoded markup inert (no double-decode injection)", () => {
    const text = htmlToText("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
    expect(text).toContain("<script>alert(1)</script>"); // visible TEXT, never live markup
  });
});
