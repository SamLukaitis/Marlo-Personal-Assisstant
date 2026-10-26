import { beforeEach, describe, expect, it } from "vitest";
import { PHONE_DISPLAY, waLink } from "./config";
import { renderNumberBlocks } from "./numberBlocks";

beforeEach(() => {
  document.body.innerHTML = '<div id="hero"></div><div id="bar"></div><main id="thread"></main><div id="close"></div>';
  renderNumberBlocks();
});

describe("renderNumberBlocks", () => {
  it.each(["hero", "bar", "close"])("shows the number in #%s", (id) => {
    expect(document.getElementById(id)!.textContent).toContain(PHONE_DISPLAY);
  });

  it("links every number to the WhatsApp chat", () => {
    for (const id of ["hero", "bar", "close"]) {
      const link = document.getElementById(id)!.querySelector("a")!;
      expect(link.getAttribute("href")).toBe(waLink());
      expect(link.getAttribute("aria-label")).toBe("Message Marlo on WhatsApp");
    }
  });

  it("offers nothing to click except links to that chat", () => {
    expect(document.querySelector("button, form, input, textarea, select")).toBeNull();
    for (const a of document.querySelectorAll("a")) {
      expect(a.getAttribute("href")).toBe(waLink());
    }
  });

  it("gives the bar a plain Message link beside the number", () => {
    expect(document.getElementById("bar")!.textContent).toContain("Message");
  });
});
