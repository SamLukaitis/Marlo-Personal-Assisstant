import { beforeEach, describe, expect, it } from "vitest";
import { scenes } from "./script";
import { renderThread } from "./render";

let root: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '<main id="thread"></main>';
  root = document.getElementById("thread")!;
  renderThread(root, scenes);
});

describe("renderThread", () => {
  it("makes one section per scene, in order", () => {
    const ids = [...root.querySelectorAll("section")].map((s) => s.id);
    expect(ids).toEqual(scenes.map((s) => s.id));
  });

  it("makes one list item per message, in order", () => {
    const items = [...root.querySelectorAll("li.msg")];
    const expected = scenes.flatMap((s) => s.messages);
    expect(items).toHaveLength(expected.length);
    items.forEach((li, i) => {
      expect(li.textContent).toContain(expected[i].text);
      expect(li.textContent).toContain(expected[i].time);
      expect(li.classList.contains(`msg--${expected[i].from}`)).toBe(true);
    });
  });

  it("tells a screen reader who is speaking", () => {
    const first = root.querySelector("li.msg--you")!;
    const reply = root.querySelector("li.msg--marlo")!;
    expect(first.textContent).toContain("You said");
    expect(reply.textContent).toContain("Marlo said");
  });

  it("gives every conversation list a label", () => {
    for (const list of root.querySelectorAll("ol")) {
      expect(list.getAttribute("aria-label")).toBeTruthy();
    }
  });

  it("opens each conversation with a titled chip", () => {
    const chips = [...root.querySelectorAll(".chip")].map((c) => c.textContent);
    expect(chips).toEqual(scenes.map((s) => s.title));
  });

  it("has no buttons, forms or inputs", () => {
    expect(root.querySelector("button, form, input, textarea")).toBeNull();
  });
});
