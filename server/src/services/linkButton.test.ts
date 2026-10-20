import { describe, it, expect } from "vitest";
import { planLinkButton, textWithoutButtonLink, DEFAULT_LINK_BUTTON_BODY } from "./linkButton.js";

const URL = "https://marlowe.up.railway.app/go/Ab3dE9xY";
const button = { label: "View Google Flights", url: URL };

describe("textWithoutButtonLink", () => {
  it("drops the labelled link line and keeps the rest, per-option links included", () => {
    const text = `Cheapest is Vueling at £84, direct.\nBook: https://kiwi.com/x\n\nAll options:\n${URL}`;
    expect(textWithoutButtonLink(text, button)).toBe("Cheapest is Vueling at £84, direct.\nBook: https://kiwi.com/x\n\nAll options:");
  });

  it("drops a link that shares its line with a short label", () => {
    expect(textWithoutButtonLink(`Two direct flights from £84.\nAll options: ${URL}`, button)).toBe("Two direct flights from £84.");
  });

  it("won't take the link out of the middle of a sentence", () => {
    expect(textWithoutButtonLink(`You can compare every option on ${URL} before you decide which to book.`, button)).toBeNull();
  });

  it("won't use a label longer than WhatsApp allows", () => {
    expect(textWithoutButtonLink(`x\n${URL}`, { label: "View on Google Flights", url: URL })).toBeNull();
  });
});

describe("planLinkButton", () => {
  it("puts a short reply in the button message itself", () => {
    expect(planLinkButton(`Direct from £84.\n${URL}`, button)).toEqual({ leadingText: null, body: "Direct from £84." });
  });

  it("sends a reply too long for a button message first, then the button with a short line", () => {
    const long = "x".repeat(1100);
    expect(planLinkButton(`${long}\n${URL}`, button)).toEqual({ leadingText: long, body: DEFAULT_LINK_BUTTON_BODY });
  });
});
