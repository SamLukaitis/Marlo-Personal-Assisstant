import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("lenis", () => ({
  default: class {
    on() {}
    raf() {}
    destroy() {}
  },
}));

import { initScroll, shouldAnimate } from "./scroll";
import { renderThread } from "./render";
import { scenes } from "./script";

function mockReducedMotion(reduce: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: reduce && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
}

let root: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '<section id="phone"><div class="phone"><div class="wa__chat"><main id="thread"></main></div></div></section>';
  root = document.getElementById("thread")!;
  renderThread(root, scenes);
});

afterEach(() => vi.restoreAllMocks());

describe("shouldAnimate", () => {
  it("is false for someone who asked for reduced motion", () => {
    mockReducedMotion(true);
    expect(shouldAnimate()).toBe(false);
  });

  it("is true otherwise", () => {
    mockReducedMotion(false);
    expect(shouldAnimate()).toBe(true);
  });
});

describe("initScroll", () => {
  it("leaves every message visible when motion is reduced", () => {
    mockReducedMotion(true);
    const stop = initScroll(root);
    expect(root.querySelectorAll(".is-pending")).toHaveLength(0);
    stop();
  });

  it("pins the phone while running and releases it when stopped", () => {
    mockReducedMotion(false);
    const stop = initScroll(root);
    expect(document.getElementById("phone")!.classList.contains("is-scrub")).toBe(true);
    stop();
    expect(document.getElementById("phone")!.classList.contains("is-scrub")).toBe(false);
  });

  it("hides messages only while it is running, and shows them all when stopped", () => {
    mockReducedMotion(false);
    const stop = initScroll(root);
    expect(root.querySelectorAll(".msg.is-pending").length).toBeGreaterThan(0);
    stop();
    expect(root.querySelectorAll(".is-pending")).toHaveLength(0);
  });
});
