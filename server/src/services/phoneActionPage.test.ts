import { describe, it, expect } from "vitest";
import { renderActionPage } from "./phoneActionPage.js";

describe("renderActionPage", () => {
  it("cannot be broken out of the inline script by a </script> in the run URL", () => {
    const html = renderActionPage({
      state: "ready",
      label: "x",
      summary: [],
      runUrl: "shortcuts://x</script><img src=x onerror=alert(1)>",
      installUrl: "",
    });
    expect(html.split("</script>").length - 1).toBe(1);
    expect(html).toContain("\u003c/script>");
  });

  it("escapes U+2028 and U+2029 inside the script", () => {
    const html = renderActionPage({
      state: "ready",
      label: "x",
      summary: [],
      runUrl: "shortcuts://x\u2028y\u2029z",
      installUrl: "",
    });
    // The href attribute may carry the raw characters (harmless there); the script must not.
    const script = html.slice(html.indexOf("<script>"));
    expect(script).not.toContain("\u2028");
    expect(script).not.toContain("\u2029");
    expect(script).toContain("\\u2028");
    expect(script).toContain("\\u2029");
  });
});
