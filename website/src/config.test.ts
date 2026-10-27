import { describe, expect, it } from "vitest";
import { PHONE_DISPLAY, PHONE_E164_DIGITS, waLink } from "./config";

describe("Marlo's number", () => {
  it("links to a WhatsApp chat with the number", () => {
    expect(waLink()).toBe("https://wa.me/447552639982");
  });

  it("shows the number in international format", () => {
    expect(PHONE_DISPLAY).toBe("+44 7552 639982");
  });

  it("keeps the link digits free of plus signs and spaces", () => {
    expect(PHONE_E164_DIGITS).toMatch(/^\d+$/);
  });
});
